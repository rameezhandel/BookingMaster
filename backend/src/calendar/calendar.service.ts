import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DB, type Db } from '../db/database.module';
import { OCCUPYING_STATUSES, customers, reservations } from '../db/schema';
import { generateSlots, overlaps, startOfDay } from '../common/time';
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

    const occupied = await this.occupancy(tenantId, venueId, dayStart.toJSDate(), dayEnd.toJSDate());
    const rulesByResource = await this.pricing.rulesForResources(
      tenantId,
      courts.map((c) => c.id),
    );

    let bookedSlots = 0;
    let totalSlots = 0;
    let bookedPaise = 0;

    const grid = courts.map((court) => {
      const slots = generateSlots(date, tz, court.opensAt, court.closesAt, court.slotMinutes);
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
        opensAt: court.opensAt,
        closesAt: court.closesAt,
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
    const days: { date: string; bookedSlots: number; totalSlots: number; occupancyPct: number }[] = [];

    const rangeStart = weekStart.toJSDate();
    const rangeEnd = weekStart.plus({ days: 7 }).toJSDate();
    const occupied = await this.occupancy(tenantId, venueId, rangeStart, rangeEnd);

    for (let i = 0; i < 7; i++) {
      const dayISO = weekStart.plus({ days: i }).toISODate()!;
      let total = 0;
      let booked = 0;

      for (const court of courts) {
        const slots = generateSlots(dayISO, tz, court.opensAt, court.closesAt, court.slotMinutes);
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
    customer: r.customerId
      ? { id: r.customerId, name: r.customerName, phone: r.customerPhone }
      : null,
  };
}
