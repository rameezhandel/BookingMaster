import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DB, type Db } from '../db/database.module';
import { OCCUPYING_STATUSES, customers, reservations } from '../db/schema';
import { overlaps, startOfDay } from '../common/time';
import { openingFor, slotsForWindows } from '../availability/resolve';
import { HoursService } from '../availability/hours.service';
import { paidTotals, toPaise } from '../common/paid-totals';
import { PricingService } from '../pricing/pricing.service';
import { VenuesService } from '../venues/venues.service';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type SlotState = 'free' | 'booked' | 'held' | 'blocked' | 'past';

@Injectable()
export class CalendarService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly venues: VenuesService,
    private readonly pricing: PricingService,
    private readonly hours: HoursService,
  ) {}

  /**
   * The day view: for each court, the slots its opening hours imply, each marked
   * with whatever occupies it.
   *
   * Slots are generated here rather than stored. Changing a venue's hours
   * changes tomorrow's calendar immediately, with no backfill.
   */
  async day(tenantId: string, venueId: string, date: string) {
    if (!DATE_RE.test(date)) throw new BadRequestException('date must be YYYY-MM-DD.');

    const venue = await this.venues.get(tenantId, venueId);
    const courts = await this.venues.listResources(tenantId, venueId);
    const tz = venue.timezone;

    const dayStart = startOfDay(date, tz);
    const dayEnd = dayStart.plus({ days: 1 });
    const now = DateTime.now().setZone(tz);

    const courtIds = courts.map((c) => c.id);
    const [occupied, rulesByResource, hourRules, overrides] = await Promise.all([
      this.occupancy(tenantId, venueId, dayStart.toJSDate(), dayEnd.toJSDate()),
      this.pricing.rulesForResources(tenantId, courtIds),
      this.hours.rulesForResources(tenantId, courtIds),
      this.hours.overridesForRange(tenantId, venueId, date, date),
    ]);
    const dayOfWeek = dayStart.weekday % 7;

    let bookedSlots = 0;
    let totalSlots = 0;
    let bookedPaise = 0;

    const grid = courts.map((court) => {
      const opening = openingFor(date, dayOfWeek, court.id, hourRules, overrides);
      const slots = slotsForWindows(date, tz, opening.windows, court.slotMinutes);
      const forCourt = occupied.filter((r) => r.resourceId === court.id);
      const rules = rulesByResource.get(court.id) ?? [];

      const rendered = slots.map((slot) => {
        const hit = forCourt.find((r) => overlaps(slot, { start: r.start, end: r.end }));
        totalSlots++;

        let state: SlotState = 'free';
        if (hit) {
          state = hit.kind === 'block' ? 'blocked' : hit.status === 'held' ? 'held' : 'booked';
          bookedSlots++;
        } else if (DateTime.fromJSDate(slot.end, { zone: tz }) < now) {
          state = 'past';
        }

        return {
          start: slot.start.toISOString(),
          end: slot.end.toISOString(),
          label: DateTime.fromJSDate(slot.start, { zone: tz }).toFormat('HH:mm'),
          state,
          pricePaise: this.pricing.priceFor(slot, tz, rules),
          reservation: hit ? summarise(hit) : null,
        };
      });

      // Anything the owner booked off the slot grid (19:15-20:45, a whole-day
      // block) still has to be visible, so it is returned alongside.
      const offGrid = forCourt
        .filter((r) => !slots.some((s) => s.start.getTime() === r.start.getTime() && s.end.getTime() === r.end.getTime()))
        .map(summarise);

      for (const r of forCourt) {
        if (r.kind === 'booking') bookedPaise += Number(r.amountPaise);
      }

      return {
        id: court.id,
        name: court.name,
        sport: court.sport,
        slotMinutes: court.slotMinutes,
        // What the court is actually doing today, so the UI can say "closed for
        // Diwali" rather than silently rendering an empty column.
        closed: opening.closed,
        closedReason: opening.reason,
        openingSource: opening.source,
        windows: opening.windows,
        slots: rendered,
        offGrid,
      };
    });

    return {
      date,
      timezone: tz,
      venue: { id: venue.id, name: venue.name },
      courts: grid,
      summary: {
        totalSlots,
        bookedSlots,
        occupancyPct: totalSlots === 0 ? 0 : Math.round((bookedSlots / totalSlots) * 100),
        bookedPaise,
      },
    };
  }

  /** Seven-day occupancy strip, for navigating between days. */
  async week(tenantId: string, venueId: string, date: string) {
    if (!DATE_RE.test(date)) throw new BadRequestException('date must be YYYY-MM-DD.');

    const venue = await this.venues.get(tenantId, venueId);
    const courts = await this.venues.listResources(tenantId, venueId);
    const tz = venue.timezone;

    const weekStart = startOfDay(date, tz).startOf('week');
    const days: {
      date: string;
      bookedSlots: number;
      totalSlots: number;
      occupancyPct: number;
      closed: boolean;
    }[] = [];

    const rangeStart = weekStart.toJSDate();
    const rangeEnd = weekStart.plus({ days: 7 }).toJSDate();
    const lastDate = weekStart.plus({ days: 6 }).toISODate()!;
    const courtIds = courts.map((c) => c.id);

    const [occupied, hourRules, overrides] = await Promise.all([
      this.occupancy(tenantId, venueId, rangeStart, rangeEnd),
      this.hours.rulesForResources(tenantId, courtIds),
      this.hours.overridesForRange(tenantId, venueId, weekStart.toISODate()!, lastDate),
    ]);

    for (let i = 0; i < 7; i++) {
      const day = weekStart.plus({ days: i });
      const dayISO = day.toISODate()!;
      const dayOfWeek = day.weekday % 7;
      let total = 0;
      let booked = 0;
      let closedCourts = 0;

      for (const court of courts) {
        const opening = openingFor(dayISO, dayOfWeek, court.id, hourRules, overrides);
        if (opening.closed) closedCourts++;
        const slots = slotsForWindows(dayISO, tz, opening.windows, court.slotMinutes);
        total += slots.length;
        const forCourt = occupied.filter((r) => r.resourceId === court.id);
        booked += slots.filter((slot) =>
          forCourt.some((r) => overlaps(slot, { start: r.start, end: r.end })),
        ).length;
      }

      days.push({
        date: dayISO,
        bookedSlots: booked,
        totalSlots: total,
        occupancyPct: total === 0 ? 0 : Math.round((booked / total) * 100),
        // Every court shut means the venue is shut, which the strip should show.
        closed: courts.length > 0 && closedCourts === courts.length,
      });
    }

    return { weekStart: weekStart.toISODate(), timezone: tz, days };
  }

  /** Everything that occupies a court in the window, matching the DB constraint's status set. */
  private async occupancy(tenantId: string, venueId: string, from: Date, to: Date) {
    const paid = paidTotals(this.db);
    const rows = await this.db
      .select({
        id: reservations.id,
        resourceId: reservations.resourceId,
        kind: reservations.kind,
        status: reservations.status,
        during: reservations.during,
        amountPaise: reservations.amountPaise,
        notes: reservations.notes,
        blockReason: reservations.blockReason,
        seriesId: reservations.seriesId,
        customerId: customers.id,
        customerName: customers.name,
        customerPhone: customers.phone,
        paidPaise: paid.paidPaise,
      })
      .from(reservations)
      .leftJoin(customers, eq(customers.id, reservations.customerId))
      .leftJoin(paid, eq(paid.reservationId, reservations.id))
      .where(
        and(
          eq(reservations.tenantId, tenantId),
          eq(reservations.venueId, venueId),
          inArray(reservations.status, OCCUPYING_STATUSES),
          sql`${reservations.during} && tstzrange(${from.toISOString()}::timestamptz, ${to.toISOString()}::timestamptz, '[)')`,
        ),
      );

    return rows.map((r) => ({
      ...r,
      start: r.during.start,
      end: r.during.end,
      amountPaise: toPaise(r.amountPaise),
      paidPaise: toPaise(r.paidPaise),
    }));
  }
}

function summarise(r: {
  id: string;
  kind: string;
  status: string;
  start: Date;
  end: Date;
  amountPaise: number;
  paidPaise: number;
  notes: string | null;
  blockReason: string | null;
  seriesId: string | null;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
}) {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    start: r.start.toISOString(),
    end: r.end.toISOString(),
    amountPaise: Number(r.amountPaise),
    paidPaise: Number(r.paidPaise),
    duePaise: Number(r.amountPaise) - Number(r.paidPaise),
    notes: r.notes,
    blockReason: r.blockReason,
    seriesId: r.seriesId,
    customer: r.customerId
      ? { id: r.customerId, name: r.customerName, phone: r.customerPhone }
      : null,
  };
}
