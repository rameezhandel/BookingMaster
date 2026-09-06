import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/database.module';
import { payments, reservations, resources } from '../db/schema';
import { startOfDay } from '../common/time';
import { VenuesService } from '../venues/venues.service';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class ReportsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly venues: VenuesService,
  ) {}

  /**
   * The numbers an owner actually asks for: what was billed, what was collected,
   * what is still owed, and which court earned it.
   *
   * "Billed" counts confirmed and completed bookings; cancellations and blocks
   * are excluded. "Collected" comes from the payment ledger, not the booking, so
   * a partly-paid booking reads correctly.
   */
  async summary(tenantId: string, venueId: string, from: string, to: string) {
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
      throw new BadRequestException('from and to must be YYYY-MM-DD.');
    }
    const venue = await this.venues.get(tenantId, venueId);
    const tz = venue.timezone;

    const rangeStart = startOfDay(from, tz).toJSDate();
    const rangeEnd = startOfDay(to, tz).plus({ days: 1 }).toJSDate();
    const window = sql`tstzrange(${rangeStart.toISOString()}::timestamptz, ${rangeEnd.toISOString()}::timestamptz, '[)')`;

    const [totals] = await this.db
      .select({
        bookings: sql<number>`COUNT(*) FILTER (WHERE ${reservations.status} IN ('confirmed','completed'))`,
        cancelled: sql<number>`COUNT(*) FILTER (WHERE ${reservations.status} = 'cancelled')`,
        noShows: sql<number>`COUNT(*) FILTER (WHERE ${reservations.status} = 'no_show')`,
        billedPaise: sql<number>`COALESCE(SUM(${reservations.amountPaise}) FILTER (WHERE ${reservations.status} IN ('confirmed','completed')), 0)`,
      })
      .from(reservations)
      .where(
        and(
          eq(reservations.tenantId, tenantId),
          eq(reservations.venueId, venueId),
          eq(reservations.kind, 'booking'),
          sql`${reservations.during} && ${window}`,
        ),
      );

    // Collected is keyed on when the money arrived, not when the court was used.
    const [collected] = await this.db
      .select({
        collectedPaise: sql<number>`COALESCE(SUM(CASE WHEN ${payments.direction} = 'in' THEN ${payments.amountPaise} ELSE -${payments.amountPaise} END), 0)`,
      })
      .from(payments)
      .innerJoin(reservations, eq(reservations.id, payments.reservationId))
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(reservations.venueId, venueId),
          sql`${payments.receivedAt} >= ${rangeStart.toISOString()}::timestamptz`,
          sql`${payments.receivedAt} < ${rangeEnd.toISOString()}::timestamptz`,
        ),
      );

    const byCourt = await this.db
      .select({
        resourceId: resources.id,
        name: resources.name,
        sport: resources.sport,
        bookings: sql<number>`COUNT(*) FILTER (WHERE ${reservations.status} IN ('confirmed','completed'))`,
        billedPaise: sql<number>`COALESCE(SUM(${reservations.amountPaise}) FILTER (WHERE ${reservations.status} IN ('confirmed','completed')), 0)`,
        bookedMinutes: sql<number>`COALESCE(SUM(EXTRACT(EPOCH FROM (upper(${reservations.during}) - lower(${reservations.during}))) / 60) FILTER (WHERE ${reservations.status} IN ('confirmed','completed')), 0)`,
      })
      .from(resources)
      .leftJoin(
        reservations,
        and(
          eq(reservations.resourceId, resources.id),
          eq(reservations.kind, 'booking'),
          sql`${reservations.during} && ${window}`,
        ),
      )
      .where(and(eq(resources.tenantId, tenantId), eq(resources.venueId, venueId)))
      .groupBy(resources.id, resources.name, resources.sport, resources.sortOrder)
      .orderBy(resources.sortOrder);

    const billedPaise = Number(totals.billedPaise);
    const collectedPaise = Number(collected.collectedPaise);

    return {
      from,
      to,
      timezone: tz,
      bookings: Number(totals.bookings),
      cancelled: Number(totals.cancelled),
      noShows: Number(totals.noShows),
      billedPaise,
      collectedPaise,
      outstandingPaise: billedPaise - collectedPaise,
      byCourt: byCourt.map((c) => ({
        ...c,
        bookings: Number(c.bookings),
        billedPaise: Number(c.billedPaise),
        bookedMinutes: Math.round(Number(c.bookedMinutes)),
      })),
    };
  }
}
