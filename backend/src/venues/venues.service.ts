import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DB, type Db } from '../db/database.module';
import { OCCUPYING_STATUSES, reservations, resourceHourRules, resources, venues } from '../db/schema';
import { timeToMinutes } from '../common/time';
import type { CreateResourceDto, CreateVenueDto, UpdateResourceDto, UpdateVenueDto } from './dto';

@Injectable()
export class VenuesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ------------------------------------------------------------- venues --

  list(tenantId: string) {
    return this.db
      .select()
      .from(venues)
      .where(eq(venues.tenantId, tenantId))
      .orderBy(asc(venues.createdAt));
  }

  async get(tenantId: string, venueId: string) {
    const [venue] = await this.db
      .select()
      .from(venues)
      .where(and(eq(venues.tenantId, tenantId), eq(venues.id, venueId)))
      .limit(1);
    if (!venue) throw new NotFoundException('Venue not found.');
    return venue;
  }

  async create(tenantId: string, dto: CreateVenueDto) {
    const timezone = dto.timezone ?? 'Asia/Kolkata';
    this.assertValidTimezone(timezone);
    const [venue] = await this.db
      .insert(venues)
      .values({ tenantId, name: dto.name, timezone, address: dto.address, phone: dto.phone })
      .returning();
    return venue;
  }

  async update(tenantId: string, venueId: string, dto: UpdateVenueDto) {
    await this.get(tenantId, venueId);
    if (dto.timezone) this.assertValidTimezone(dto.timezone);
    const [venue] = await this.db
      .update(venues)
      .set(dto)
      .where(and(eq(venues.tenantId, tenantId), eq(venues.id, venueId)))
      .returning();
    return venue;
  }

  // ---------------------------------------------------------- resources --

  async listResources(tenantId: string, venueId: string, includeInactive = false) {
    await this.get(tenantId, venueId);
    const where = includeInactive
      ? and(eq(resources.tenantId, tenantId), eq(resources.venueId, venueId))
      : and(
          eq(resources.tenantId, tenantId),
          eq(resources.venueId, venueId),
          eq(resources.isActive, true),
        );
    return this.db
      .select()
      .from(resources)
      .where(where)
      .orderBy(asc(resources.sortOrder), asc(resources.createdAt));
  }

  async getResource(tenantId: string, resourceId: string) {
    const [resource] = await this.db
      .select()
      .from(resources)
      .where(and(eq(resources.tenantId, tenantId), eq(resources.id, resourceId)))
      .limit(1);
    if (!resource) throw new NotFoundException('Court not found.');
    return resource;
  }

  async createResource(tenantId: string, venueId: string, dto: CreateResourceDto) {
    await this.get(tenantId, venueId);
    const opensAt = dto.opensAt ?? '06:00';
    const closesAt = dto.closesAt ?? '23:00';
    this.assertHours(opensAt, closesAt, dto.slotMinutes ?? 60);

    // The court and a week of opening hours are created together: a court with
    // no hours generates no slots, which would look like a broken calendar.
    return this.db.transaction(async (tx) => {
      const [resource] = await tx
        .insert(resources)
        .values({
          tenantId,
          venueId,
          name: dto.name,
          sport: dto.sport,
          slotMinutes: dto.slotMinutes ?? 60,
          sortOrder: dto.sortOrder ?? 0,
        })
        .returning();

      await tx.insert(resourceHourRules).values(
        [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
          tenantId,
          resourceId: resource.id,
          dayOfWeek,
          opensAt,
          closesAt,
        })),
      );

      return resource;
    });
  }

  async updateResource(tenantId: string, resourceId: string, dto: UpdateResourceDto) {
    await this.getResource(tenantId, resourceId);

    const [resource] = await this.db
      .update(resources)
      .set(dto)
      .where(and(eq(resources.tenantId, tenantId), eq(resources.id, resourceId)))
      .returning();
    return resource;
  }

  /**
   * Courts with history are deactivated rather than deleted: removing them would
   * take their bookings, and therefore the revenue record, with them.
   */
  async deleteResource(tenantId: string, resourceId: string) {
    await this.getResource(tenantId, resourceId);
    const [{ value: used }] = await this.db
      .select({ value: count() })
      .from(reservations)
      .where(
        and(
          eq(reservations.tenantId, tenantId),
          eq(reservations.resourceId, resourceId),
          inArray(reservations.status, OCCUPYING_STATUSES),
        ),
      );

    if (used > 0) {
      throw new ConflictException(
        'This court has bookings against it. Deactivate it instead so its history is kept.',
      );
    }
    await this.db
      .delete(resources)
      .where(and(eq(resources.tenantId, tenantId), eq(resources.id, resourceId)));
    return { deleted: true };
  }

  // ------------------------------------------------------------ helpers --

  private assertValidTimezone(timezone: string) {
    if (!DateTime.local().setZone(timezone).isValid) {
      throw new BadRequestException(`"${timezone}" is not a recognised IANA timezone.`);
    }
  }

  private assertHours(opensAt: string, closesAt: string, slotMinutes: number) {
    const open = timeToMinutes(opensAt);
    const close = timeToMinutes(closesAt);
    if (close <= open) {
      throw new BadRequestException('Closing time must be after opening time.');
    }
    if (close - open < slotMinutes) {
      throw new BadRequestException(
        `Opening hours are shorter than one ${slotMinutes}-minute slot.`,
      );
    }
  }
}
