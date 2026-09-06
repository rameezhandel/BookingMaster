import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { DB, type Db } from '../db/database.module';
import { customers, payments, reservations, resources, venues, type ReservationStatus } from '../db/schema';
import { rethrowAsHttp } from '../common/errors';
import { paidTotals, toPaise } from '../common/paid-totals';
import { durationMinutes, type Interval } from '../common/time';
import { CustomersService } from '../customers/customers.service';
import { PricingService } from '../pricing/pricing.service';
import type { AuthUser } from '../common/current-user.decorator';
import type {
  CreateBlockDto,
  CreateReservationDto,
  ListReservationsDto,
  UpdateReservationDto,
} from './dto';

const MAX_RESERVATION_MINUTES = 24 * 60;

/** Which status changes an owner is allowed to make, and from where. */
const ALLOWED_TRANSITIONS: Record<string, ReservationStatus[]> = {
  held: ['confirmed'],
  confirmed: ['completed', 'no_show'],
  completed: ['no_show'],
  no_show: ['completed'],
};

@Injectable()
export class ReservationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly customersService: CustomersService,
    private readonly pricing: PricingService,
  ) {}

  // ------------------------------------------------------------ writing --

  /**
   * Quick-book: the owner is on the phone or at the desk and needs this to be
   * one round trip. Overlap is *not* checked here — the database constraint is
   * the check, and a race surfaces as a 409 from rethrowAsHttp.
   */
  async create(user: AuthUser, dto: CreateReservationDto) {
    const interval = parseInterval(dto.start, dto.end);
    const resource = await this.loadResource(user.tenantId, dto.resourceId);

    const amountPaise =
      dto.amountPaise ?? (await this.autoPrice(user.tenantId, dto.resourceId, interval));

    try {
      return await this.db.transaction(async (tx) => {
        let customerId = dto.customerId ?? null;
        if (dto.customer) {
          const customer = await this.customersService.findOrCreate(tx, user.tenantId, dto.customer);
          customerId = customer.id;
        } else if (customerId) {
          await this.customersService.get(user.tenantId, customerId);
        }

        const [created] = await tx
          .insert(reservations)
          .values({
            tenantId: user.tenantId,
            venueId: resource.venueId,
            resourceId: resource.id,
            kind: 'booking',
            status: 'confirmed',
            during: interval,
            customerId,
            amountPaise,
            notes: dto.notes,
            createdBy: user.id,
          })
          .returning();
        return created;
      });
    } catch (err) {
      rethrowAsHttp(err);
    }
  }

  /** Rain, maintenance, a tournament: same table, same overlap guarantee. */
  async block(user: AuthUser, dto: CreateBlockDto) {
    const interval = parseInterval(dto.start, dto.end);
    const resource = await this.loadResource(user.tenantId, dto.resourceId);

    try {
      const [created] = await this.db
        .insert(reservations)
        .values({
          tenantId: user.tenantId,
          venueId: resource.venueId,
          resourceId: resource.id,
          kind: 'block',
          status: 'blocked',
          during: interval,
          blockReason: dto.reason,
          createdBy: user.id,
        })
        .returning();
      return created;
    } catch (err) {
      rethrowAsHttp(err);
    }
  }

  async update(tenantId: string, id: string, dto: UpdateReservationDto) {
    const existing = await this.getRaw(tenantId, id);

    if (dto.status && dto.status !== existing.status) {
      if (existing.kind === 'block') {
        throw new BadRequestException('A block has no booking status.');
      }
      const allowed = ALLOWED_TRANSITIONS[existing.status] ?? [];
      if (!allowed.includes(dto.status)) {
        throw new ConflictException(
          `A ${existing.status} booking cannot be marked ${dto.status}.`,
        );
      }
    }

    try {
      const [updated] = await this.db
        .update(reservations)
        .set({
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.amountPaise !== undefined ? { amountPaise: dto.amountPaise } : {}),
          ...(dto.status ? { status: dto.status } : {}),
        })
        .where(and(eq(reservations.tenantId, tenantId), eq(reservations.id, id)))
        .returning();
      return updated;
    } catch (err) {
      // Marking a no-show back to completed can collide with a slot that was
      // resold in the meantime. The constraint catches it; say so plainly.
      rethrowAsHttp(err);
    }
  }

  async cancel(tenantId: string, id: string) {
    const existing = await this.getRaw(tenantId, id);
    if (existing.status === 'cancelled') return existing;

    const [updated] = await this.db
      .update(reservations)
      .set({ status: 'cancelled', cancelledAt: new Date() })
      .where(and(eq(reservations.tenantId, tenantId), eq(reservations.id, id)))
      .returning();
    return updated;
  }

  /** Blocks carry no financial record, so removing one leaves nothing behind. */
  async remove(tenantId: string, id: string) {
    const existing = await this.getRaw(tenantId, id);
    if (existing.kind !== 'block') {
      throw new BadRequestException('Bookings are cancelled, not deleted, so revenue stays auditable.');
    }
    await this.db
      .delete(reservations)
      .where(and(eq(reservations.tenantId, tenantId), eq(reservations.id, id)));
    return { deleted: true };
  }

  // ------------------------------------------------------------ reading --

  async list(tenantId: string, query: ListReservationsDto) {
    const filters: SQL[] = [eq(reservations.tenantId, tenantId)];

    if (query.venueId) filters.push(eq(reservations.venueId, query.venueId));
    if (query.resourceId) filters.push(eq(reservations.resourceId, query.resourceId));
    if (query.customerId) filters.push(eq(reservations.customerId, query.customerId));
    if (query.status) filters.push(eq(reservations.status, query.status as ReservationStatus));
    if (query.from && query.to) {
      filters.push(
        sql`${reservations.during} && tstzrange(${new Date(query.from).toISOString()}::timestamptz, ${new Date(query.to).toISOString()}::timestamptz, '[)')`,
      );
    } else if (query.from) {
      filters.push(sql`upper(${reservations.during}) > ${new Date(query.from).toISOString()}::timestamptz`);
    } else if (query.to) {
      filters.push(sql`lower(${reservations.during}) < ${new Date(query.to).toISOString()}::timestamptz`);
    }
    if (query.q?.trim()) {
      const needle = `%${query.q.trim()}%`;
      filters.push(sql`(${customers.name} ILIKE ${needle} OR ${customers.phone} ILIKE ${needle})`);
    }

    const paid = paidTotals(this.db);
    const rows = await this.db
      .select(this.selection(paid))
      .from(reservations)
      .innerJoin(resources, eq(resources.id, reservations.resourceId))
      .innerJoin(venues, eq(venues.id, reservations.venueId))
      .leftJoin(customers, eq(customers.id, reservations.customerId))
      .leftJoin(paid, eq(paid.reservationId, reservations.id))
      .where(and(...filters))
      .orderBy(desc(sql`lower(${reservations.during})`))
      .limit(Math.min(query.limit ?? 100, 500));
    return rows.map(withMoney);
  }

  async get(tenantId: string, id: string) {
    const paid = paidTotals(this.db);
    const [row] = await this.db
      .select(this.selection(paid))
      .from(reservations)
      .innerJoin(resources, eq(resources.id, reservations.resourceId))
      .innerJoin(venues, eq(venues.id, reservations.venueId))
      .leftJoin(customers, eq(customers.id, reservations.customerId))
      .leftJoin(paid, eq(paid.reservationId, reservations.id))
      .where(and(eq(reservations.tenantId, tenantId), eq(reservations.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException('Booking not found.');
    return this.withPayments(tenantId, withMoney(row));
  }

  async getRaw(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(reservations)
      .where(and(eq(reservations.tenantId, tenantId), eq(reservations.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException('Booking not found.');
    return row;
  }

  // ------------------------------------------------------------ helpers --

  /** One column list, used by both the list and the single-booking read. */
  private selection(paid: ReturnType<typeof paidTotals>) {
    return {
      id: reservations.id,
      kind: reservations.kind,
      status: reservations.status,
      during: reservations.during,
      amountPaise: reservations.amountPaise,
      notes: reservations.notes,
      blockReason: reservations.blockReason,
      createdAt: reservations.createdAt,
      resourceId: resources.id,
      resourceName: resources.name,
      sport: resources.sport,
      venueId: venues.id,
      venueName: venues.name,
      timezone: venues.timezone,
      customerId: customers.id,
      customerName: customers.name,
      customerPhone: customers.phone,
      paidPaise: paid.paidPaise,
    };
  }

  private async withPayments<T extends { id: string }>(tenantId: string, row: T) {
    const rows = await this.db
      .select()
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.reservationId, row.id)))
      .orderBy(desc(payments.receivedAt));
    return { ...row, payments: rows };
  }

  private async loadResource(tenantId: string, resourceId: string) {
    const [resource] = await this.db
      .select()
      .from(resources)
      .where(and(eq(resources.tenantId, tenantId), eq(resources.id, resourceId)))
      .limit(1);
    if (!resource) throw new NotFoundException('Court not found.');
    if (!resource.isActive) throw new BadRequestException('That court is deactivated.');
    return resource;
  }

  private async autoPrice(tenantId: string, resourceId: string, interval: Interval) {
    const resource = await this.loadResource(tenantId, resourceId);
    const [venue] = await this.db.select().from(venues).where(eq(venues.id, resource.venueId)).limit(1);
    const rules = (await this.pricing.rulesForResources(tenantId, [resourceId])).get(resourceId) ?? [];
    return this.pricing.priceFor(interval, venue.timezone, rules) ?? 0;
  }
}

/** Money leaves the database as bigint strings; normalise it once, at the edge. */
function withMoney<T extends { amountPaise: unknown; paidPaise: unknown }>(row: T) {
  const amountPaise = toPaise(row.amountPaise);
  const paidPaise = toPaise(row.paidPaise);
  return { ...row, amountPaise, paidPaise, duePaise: amountPaise - paidPaise };
}

function parseInterval(start: string, end: string): Interval {
  const interval = { start: new Date(start), end: new Date(end) };
  if (Number.isNaN(interval.start.getTime()) || Number.isNaN(interval.end.getTime())) {
    throw new BadRequestException('start and end must be ISO-8601 timestamps.');
  }
  if (interval.end <= interval.start) {
    throw new BadRequestException('End time must be after start time.');
  }
  if (durationMinutes(interval) > MAX_RESERVATION_MINUTES) {
    throw new BadRequestException('A single booking cannot be longer than 24 hours.');
  }
  return interval;
}
