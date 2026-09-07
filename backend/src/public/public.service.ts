import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DB, type Db } from '../db/database.module';
import { runAsTenant } from '../db/run-as-tenant';
import { OCCUPYING_STATUSES, reservations, resources, venues } from '../db/schema';
import { overlaps, startOfDay } from '../common/time';
import { openingFor, slotsForWindows } from '../availability/resolve';
import { HoursService } from '../availability/hours.service';
import { PricingService } from '../pricing/pricing.service';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface PublicVenue {
  slug: string;
  name: string;
  address: string | null;
  phone: string | null;
  timezone: string;
  bookingWindowDays: number;
  minNoticeMinutes: number;
  courts: { id: string; name: string; sport: string; slotMinutes: number }[];
}

@Injectable()
export class PublicService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly hours: HoursService,
    private readonly pricing: PricingService,
  ) {}

  /**
   * Resolves a public slug to a tenant.
   *
   * This is the one query in the application that legitimately looks across
   * tenants: a visitor arrives with a slug and nothing else. It is deliberately
   * narrow — one row, three columns, no customer data — and everything after it
   * runs adopted into that tenant under the ordinary policies.
   */
  async resolveSlug(slug: string) {
    const [venue] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.bypass_rls', 'on', true)`);
      return tx
        .select({ id: venues.id, tenantId: venues.tenantId, isPublished: venues.isPublished })
        .from(venues)
        .where(sql`lower(${venues.slug}) = ${slug.toLowerCase()}`)
        .limit(1);
    });

    // An unpublished venue is indistinguishable from one that does not exist,
    // so a slug cannot be probed to discover who is about to launch.
    if (!venue || !venue.isPublished) throw new NotFoundException('No such venue.');
    return venue;
  }

  async venue(slug: string): Promise<PublicVenue> {
    const found = await this.resolveSlug(slug);

    return runAsTenant(this.db, found.tenantId, async () => {
      const [venue] = await this.db.select().from(venues).where(eq(venues.id, found.id)).limit(1);
      const courts = await this.db
        .select({
          id: resources.id,
          name: resources.name,
          sport: resources.sport,
          slotMinutes: resources.slotMinutes,
        })
        .from(resources)
        .where(and(eq(resources.venueId, found.id), eq(resources.isActive, true)))
        .orderBy(asc(resources.sortOrder), asc(resources.createdAt));

      return {
        slug: venue.slug!,
        name: venue.name,
        address: venue.address,
        phone: venue.phone,
        timezone: venue.timezone,
        bookingWindowDays: venue.bookingWindowDays,
        minNoticeMinutes: venue.minNoticeMinutes,
        courts,
      };
    });
  }

  /**
   * What a stranger may book on one day.
   *
   * Returns only whether each slot is free and what it costs. Who holds a taken
   * slot, what they paid, and whether it is a booking or maintenance are all
   * absent by construction rather than by filtering — the query never selects
   * them.
   */
  async availability(slug: string, date: string) {
    if (!DATE_RE.test(date)) throw new BadRequestException('date must be YYYY-MM-DD.');
    const found = await this.resolveSlug(slug);

    return runAsTenant(this.db, found.tenantId, async () => {
      const [venue] = await this.db.select().from(venues).where(eq(venues.id, found.id)).limit(1);
      const tz = venue.timezone;

      const today = DateTime.now().setZone(tz).startOf('day');
      const requested = DateTime.fromISO(date, { zone: tz }).startOf('day');
      if (!requested.isValid) throw new BadRequestException('Invalid date.');

      const lastBookable = today.plus({ days: venue.bookingWindowDays });
      const withinWindow = requested >= today && requested <= lastBookable;
      const bookableFrom = DateTime.now().setZone(tz).plus({ minutes: venue.minNoticeMinutes });

      const courts = await this.db
        .select({
          id: resources.id,
          name: resources.name,
          sport: resources.sport,
          slotMinutes: resources.slotMinutes,
        })
        .from(resources)
        .where(and(eq(resources.venueId, found.id), eq(resources.isActive, true)))
        .orderBy(asc(resources.sortOrder), asc(resources.createdAt));

      const courtIds = courts.map((c) => c.id);
      const dayStart = startOfDay(date, tz).toJSDate();
      const dayEnd = startOfDay(date, tz).plus({ days: 1 }).toJSDate();

      const [taken, hourRules, overrides, priceRules] = await Promise.all([
        this.occupiedIntervals(courtIds, dayStart, dayEnd),
        this.hours.rulesForResources(found.tenantId, courtIds),
        this.hours.overridesForRange(found.tenantId, found.id, date, date),
        this.pricing.rulesForResources(found.tenantId, courtIds),
      ]);

      const dayOfWeek = requested.weekday % 7;

      return {
        date,
        timezone: tz,
        withinWindow,
        lastBookableDate: lastBookable.toISODate(),
        courts: courts.map((court) => {
          const opening = openingFor(date, dayOfWeek, court.id, hourRules, overrides);
          const slots = slotsForWindows(date, tz, opening.windows, court.slotMinutes);
          const busy = taken.filter((t) => t.resourceId === court.id);

          return {
            id: court.id,
            name: court.name,
            sport: court.sport,
            slotMinutes: court.slotMinutes,
            closed: opening.closed,
            closedReason: opening.reason,
            slots: slots.map((slot) => {
              const occupied = busy.some((b) => overlaps(slot, b));
              const tooSoon = DateTime.fromJSDate(slot.start, { zone: tz }) < bookableFrom;
              const pricePaise = this.pricing.priceFor(slot, tz, priceRules.get(court.id) ?? []);

              return {
                start: slot.start.toISOString(),
                end: slot.end.toISOString(),
                label: DateTime.fromJSDate(slot.start, { zone: tz }).toFormat('HH:mm'),
                // One flag, one reason. A visitor does not need to know whether
                // a slot is taken or blocked for maintenance.
                available: !occupied && !tooSoon && withinWindow && pricePaise !== null,
                unavailableReason: !withinWindow
                  ? 'outside-window'
                  : occupied
                    ? 'taken'
                    : tooSoon
                      ? 'too-soon'
                      : pricePaise === null
                        ? 'no-price'
                        : null,
                pricePaise,
              };
            }),
          };
        }),
      };
    });
  }

  /** Just the intervals. No status, no customer, no amount. */
  private async occupiedIntervals(courtIds: string[], from: Date, to: Date) {
    if (courtIds.length === 0) return [];
    const rows = await this.db
      .select({ resourceId: reservations.resourceId, during: reservations.during })
      .from(reservations)
      .where(
        and(
          inArray(reservations.resourceId, courtIds),
          inArray(reservations.status, OCCUPYING_STATUSES),
          sql`${reservations.during} && tstzrange(${from.toISOString()}::timestamptz, ${to.toISOString()}::timestamptz, '[)')`,
        ),
      );
    return rows.map((r) => ({ resourceId: r.resourceId, start: r.during.start, end: r.during.end }));
  }
}
