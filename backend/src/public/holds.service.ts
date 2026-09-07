import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DB, type Db } from '../db/database.module';
import { payments, reservations, resources, venues } from '../db/schema';
import { PG_EXCLUSION_VIOLATION, rethrowAsHttp } from '../common/errors';
import { durationMinutes, toISODate, type Interval } from '../common/time';
import { HoursService } from '../availability/hours.service';
import { isWithinOpening, openingFor } from '../availability/resolve';
import { PricingService } from '../pricing/pricing.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class HoldsService {
  private readonly logger = new Logger(HoldsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly hours: HoursService,
    private readonly pricing: PricingService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Takes a slot off the market while a customer finishes booking.
   *
   * A hold is an ordinary reservation with status 'held', so it participates in
   * the same exclusion constraint as a confirmed booking — two people cannot
   * hold the same slot, and a hold blocks the owner's quick-book too. What it
   * adds is a deadline.
   */
  async create(
    tenantId: string,
    venueId: string,
    customerId: string,
    resourceId: string,
    interval: Interval,
  ) {
    const [venue] = await this.db.select().from(venues).where(eq(venues.id, venueId)).limit(1);
    if (!venue) throw new NotFoundException('No such venue.');

    const [resource] = await this.db
      .select()
      .from(resources)
      .where(and(eq(resources.id, resourceId), eq(resources.venueId, venueId)))
      .limit(1);
    if (!resource || !resource.isActive) throw new NotFoundException('No such court.');

    this.assertBookable(venue, interval);
    await this.assertOpen(tenantId, venue, resource, interval);

    const amountPaise = await this.priceFor(tenantId, resource.id, venue.timezone, interval);
    if (amountPaise === null) {
      throw new ConflictException('That slot is not bookable online. Please call the venue.');
    }

    const expiresAt = new Date(Date.now() + venue.holdMinutes * 60_000);

    const held = await this.insertHold({
      tenantId,
      venueId,
      resourceId,
      customerId,
      interval,
      amountPaise,
      expiresAt,
    });

    await this.audit.record({
      action: 'hold.created',
      entityType: 'reservation',
      entityId: held.id,
      summary: `Held ${resource.name} online for ${venue.holdMinutes} minutes`,
      data: { start: interval.start.toISOString(), end: interval.end.toISOString(), amountPaise },
    });

    return {
      id: held.id,
      expiresAt: expiresAt.toISOString(),
      amountPaise,
      requiresPrepayment: venue.requiresPrepayment,
      court: resource.name,
      start: interval.start.toISOString(),
      end: interval.end.toISOString(),
    };
  }

  /**
   * Inserts the hold, coping with a hold that has expired but not yet been
   * swept.
   *
   * The exclusion constraint cannot evaluate now(): to the database an expired
   * hold still occupies the slot until something updates the row. So the
   * availability view can honestly show a slot as free while the insert is
   * rejected. Rather than telling the customer a slot they can see is taken, a
   * conflict triggers a targeted sweep of exactly that court and interval, and
   * one retry. If it fails again the slot really is taken.
   */
  private async insertHold(input: {
    tenantId: string;
    venueId: string;
    resourceId: string;
    customerId: string;
    interval: Interval;
    amountPaise: number;
    expiresAt: Date;
  }) {
    const values = {
      tenantId: input.tenantId,
      venueId: input.venueId,
      resourceId: input.resourceId,
      kind: 'booking' as const,
      status: 'held' as const,
      during: input.interval,
      customerId: input.customerId,
      amountPaise: input.amountPaise,
      expiresAt: input.expiresAt,
      bookedByPublic: true,
    };

    try {
      return await this.attemptInsert(values);
    } catch (err) {
      if ((err as { code?: string }).code !== PG_EXCLUSION_VIOLATION) rethrowAsHttp(err);

      const swept = await this.sweepInterval(input.resourceId, input.interval);
      if (swept === 0) {
        throw new ConflictException('Someone just took that slot. Please pick another.');
      }

      this.logger.log(`Swept ${swept} expired hold(s) before retrying a booking.`);
      try {
        return await this.attemptInsert(values);
      } catch (retryErr) {
        if ((retryErr as { code?: string }).code === PG_EXCLUSION_VIOLATION) {
          throw new ConflictException('Someone just took that slot. Please pick another.');
        }
        rethrowAsHttp(retryErr);
      }
    }
  }

  /**
   * One insert attempt, inside a SAVEPOINT.
   *
   * The request already runs in a transaction, and in Postgres a failed
   * statement aborts the whole thing — catching the error in JavaScript does
   * not make the transaction usable again. Without the savepoint the sweep and
   * retry below would themselves fail, and the caller would get a 500 instead
   * of either a booking or an honest "someone just took that slot".
   */
  private async attemptInsert(values: typeof reservations.$inferInsert) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(reservations).values(values).returning();
      return row;
    });
  }

  /** Releases expired holds overlapping one court and interval. */
  private async sweepInterval(resourceId: string, interval: Interval): Promise<number> {
    const released = await this.db
      .delete(reservations)
      .where(
        and(
          eq(reservations.resourceId, resourceId),
          eq(reservations.status, 'held'),
          lt(reservations.expiresAt, new Date()),
          sql`${reservations.during} && tstzrange(${interval.start.toISOString()}::timestamptz, ${interval.end.toISOString()}::timestamptz, '[)')`,
        ),
      )
      .returning({ id: reservations.id });
    return released.length;
  }

  /**
   * Releases every expired hold. Run on a timer.
   *
   * Abandoned checkouts are deleted rather than cancelled: a hold that never
   * became a booking is not history, it is someone who closed a tab, and
   * leaving them behind would fill the owner's bookings list with ghosts. A
   * hold that somehow attracted a payment is kept and cancelled instead, so no
   * money is ever detached from its record.
   */
  async sweepExpired(): Promise<{ released: number; keptWithPayments: number }> {
    const expired = await this.db
      .select({ id: reservations.id })
      .from(reservations)
      .where(
        and(
          eq(reservations.status, 'held'),
          isNotNull(reservations.expiresAt),
          lt(reservations.expiresAt, new Date()),
        ),
      )
      .limit(500);

    let released = 0;
    let keptWithPayments = 0;

    for (const { id } of expired) {
      const [paid] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(payments)
        .where(eq(payments.reservationId, id));

      if (Number(paid?.n ?? 0) > 0) {
        await this.db
          .update(reservations)
          .set({
            status: 'cancelled',
            cancelledAt: new Date(),
            cancellationReason: 'Hold expired after payment; needs review',
          })
          .where(eq(reservations.id, id));
        keptWithPayments++;
        this.logger.warn(`Hold ${id} expired but has payments against it; cancelled for review.`);
        continue;
      }

      await this.db.delete(reservations).where(eq(reservations.id, id));
      released++;
    }

    return { released, keptWithPayments };
  }

  /** Confirms a hold. Only valid when the venue does not require prepayment. */
  async confirm(tenantId: string, holdId: string, customerId: string) {
    const hold = await this.load(tenantId, holdId, customerId);

    const [venue] = await this.db.select().from(venues).where(eq(venues.id, hold.venueId)).limit(1);
    if (venue.requiresPrepayment) {
      throw new ConflictException('This venue takes payment online. Complete payment to confirm.');
    }

    if (hold.expiresAt && hold.expiresAt < new Date()) {
      throw new ConflictException('That hold has expired. Please pick the slot again.');
    }

    const [confirmed] = await this.db
      .update(reservations)
      .set({ status: 'confirmed', expiresAt: null })
      .where(and(eq(reservations.id, holdId), eq(reservations.status, 'held')))
      .returning();

    if (!confirmed) throw new ConflictException('That hold is no longer available.');

    await this.audit.record({
      action: 'booking.created',
      entityType: 'reservation',
      entityId: confirmed.id,
      summary: 'Booked online, paying at the venue',
      data: { amountPaise: Number(confirmed.amountPaise), source: 'public' },
    });

    await this.notifications.enqueue({
      tenantId,
      reservationId: confirmed.id,
      templateKey: 'booking_confirmed',
    });

    return confirmed;
  }

  async release(tenantId: string, holdId: string, customerId: string) {
    const hold = await this.load(tenantId, holdId, customerId);
    await this.db
      .delete(reservations)
      .where(and(eq(reservations.id, hold.id), eq(reservations.status, 'held')));
    return { released: true };
  }

  async load(tenantId: string, holdId: string, customerId: string) {
    const [hold] = await this.db
      .select()
      .from(reservations)
      .where(and(eq(reservations.tenantId, tenantId), eq(reservations.id, holdId)))
      .limit(1);

    if (!hold || hold.customerId !== customerId) {
      throw new NotFoundException('No such booking.');
    }
    return hold;
  }

  // ------------------------------------------------------------ guards --

  private assertBookable(
    venue: { timezone: string; bookingWindowDays: number; minNoticeMinutes: number },
    interval: Interval,
  ) {
    if (interval.end <= interval.start) {
      throw new BadRequestException('End time must be after start time.');
    }
    if (durationMinutes(interval) > 24 * 60) {
      throw new BadRequestException('That booking is too long.');
    }

    const now = DateTime.now().setZone(venue.timezone);
    const start = DateTime.fromJSDate(interval.start, { zone: venue.timezone });

    if (start < now.plus({ minutes: venue.minNoticeMinutes })) {
      throw new ConflictException(
        venue.minNoticeMinutes >= 60
          ? `Bookings need at least ${Math.round(venue.minNoticeMinutes / 60)} hour(s) notice. Please call the venue.`
          : 'That slot is too close to its start time. Please call the venue.',
      );
    }
    if (start > now.startOf('day').plus({ days: venue.bookingWindowDays + 1 })) {
      throw new ConflictException(
        `Bookings open ${venue.bookingWindowDays} days ahead.`,
      );
    }
  }

  private async assertOpen(
    tenantId: string,
    venue: { id: string; timezone: string },
    resource: { id: string },
    interval: Interval,
  ) {
    const date = toISODate(interval.start, venue.timezone);
    const dayOfWeek = DateTime.fromJSDate(interval.start, { zone: venue.timezone }).weekday % 7;

    const [rules, overrides] = await Promise.all([
      this.hours.rulesForResources(tenantId, [resource.id]),
      this.hours.overridesForRange(tenantId, venue.id, date, date),
    ]);
    const opening = openingFor(date, dayOfWeek, resource.id, rules, overrides);

    if (opening.closed || !isWithinOpening(interval, venue.timezone, date, opening.windows)) {
      throw new ConflictException('The court is not open then.');
    }
  }

  private async priceFor(tenantId: string, resourceId: string, timezone: string, interval: Interval) {
    const rules = await this.pricing.rulesForResources(tenantId, [resourceId]);
    return this.pricing.priceFor(interval, timezone, rules.get(resourceId) ?? []);
  }
}
