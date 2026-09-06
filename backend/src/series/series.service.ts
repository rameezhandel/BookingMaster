import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DB, type Db } from '../db/database.module';
import {
  bookingSeries,
  customers,
  reservations,
  resources,
  venues,
  type ReservationStatus,
} from '../db/schema';
import { PG_EXCLUSION_VIOLATION, PG_UNIQUE_VIOLATION, rethrowAsHttp } from '../common/errors';
import { timeToMinutes, type Interval } from '../common/time';
import { HoursService } from '../availability/hours.service';
import { isWithinOpening, openingFor } from '../availability/resolve';
import { CustomersService } from '../customers/customers.service';
import { PricingService } from '../pricing/pricing.service';
import type { AuthUser } from '../common/current-user.decorator';
import { horizonFrom, occurrenceDates } from './occurrences';
import type {
  CreateSeriesDto,
  EndSeriesDto,
  ExtendSeriesDto,
  ListSeriesDto,
  UpdateSeriesDto,
} from './dto';

const DEFAULT_HORIZON_WEEKS = 12;

export type SkipReason = 'clash' | 'closed' | 'outside-hours' | 'already-booked';

export interface MaterialiseResult {
  created: { date: string; reservationId: string; amountPaise: number }[];
  skipped: { date: string; reason: SkipReason; detail: string }[];
  materialisedThrough: string;
}

@Injectable()
export class SeriesService {
  private readonly logger = new Logger(SeriesService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly customersService: CustomersService,
    private readonly pricing: PricingService,
    private readonly hours: HoursService,
  ) {}

  // ----------------------------------------------------------- commands --

  async create(user: AuthUser, dto: CreateSeriesDto) {
    const resource = await this.loadResource(user.tenantId, dto.resourceId);
    const venue = await this.loadVenue(resource.venueId);

    if (dto.endsOn && dto.endsOn.slice(0, 10) < dto.startsOn.slice(0, 10)) {
      throw new BadRequestException('The end date is before the start date.');
    }

    const series = await this.db.transaction(async (tx) => {
      let customerId = dto.customerId ?? null;
      if (dto.customer) {
        const customer = await this.customersService.findOrCreate(tx, user.tenantId, dto.customer);
        customerId = customer.id;
      }

      const [created] = await tx
        .insert(bookingSeries)
        .values({
          tenantId: user.tenantId,
          venueId: resource.venueId,
          resourceId: resource.id,
          customerId,
          dayOfWeek: dto.dayOfWeek,
          startsAt: dto.startsAt,
          durationMinutes: dto.durationMinutes,
          startsOn: dto.startsOn.slice(0, 10),
          endsOn: dto.endsOn?.slice(0, 10) ?? null,
          amountPaise: dto.amountPaise ?? null,
          notes: dto.notes,
          createdBy: user.id,
        })
        .returning();
      return created;
    });

    const through = horizonFrom(
      DateTime.now().setZone(venue.timezone).toISODate()!,
      dto.weeks ?? DEFAULT_HORIZON_WEEKS,
    );
    const result = await this.materialise(user.tenantId, series.id, through);
    return { series: await this.get(user.tenantId, series.id), ...result };
  }

  async extend(tenantId: string, seriesId: string, dto: ExtendSeriesDto) {
    const series = await this.getRaw(tenantId, seriesId);
    const venue = await this.loadVenue(series.venueId);
    const through = horizonFrom(
      DateTime.now().setZone(venue.timezone).toISODate()!,
      dto.weeks ?? DEFAULT_HORIZON_WEEKS,
    );
    return this.materialise(tenantId, seriesId, through);
  }

  async update(tenantId: string, seriesId: string, dto: UpdateSeriesDto) {
    const series = await this.getRaw(tenantId, seriesId);
    const endsOn = dto.endsOn?.slice(0, 10);
    if (endsOn && endsOn < series.startsOn) {
      throw new BadRequestException('The end date is before the series started.');
    }

    await this.db
      .update(bookingSeries)
      .set({
        ...(endsOn !== undefined ? { endsOn } : {}),
        ...(dto.amountPaise !== undefined ? { amountPaise: dto.amountPaise } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      })
      .where(and(eq(bookingSeries.tenantId, tenantId), eq(bookingSeries.id, seriesId)));

    // Shortening a series should take its future bookings with it.
    if (endsOn) await this.cancelOccurrencesFrom(tenantId, seriesId, nextDay(endsOn));

    return this.get(tenantId, seriesId);
  }

  /**
   * Ends a series and cancels its future occurrences.
   *
   * Defaults to cancelling from today onward: bookings already played, or
   * already paid for, are history and stay on the books.
   */
  async end(tenantId: string, seriesId: string, dto: EndSeriesDto) {
    const series = await this.getRaw(tenantId, seriesId);
    const venue = await this.loadVenue(series.venueId);
    const from = dto.fromDate?.slice(0, 10) ?? DateTime.now().setZone(venue.timezone).toISODate()!;

    const cancelled = await this.cancelOccurrencesFrom(tenantId, seriesId, from);

    // ends_on is "the last date the rule applies", and the schema requires it
    // not to precede starts_on. A series killed before its first occurrence
    // would otherwise compute an earlier end date and fail that check, so clamp
    // it: status 'ended' plus zero live occurrences already says it never ran.
    const endsOn = maxDate(previousDay(from), series.startsOn);

    await this.db
      .update(bookingSeries)
      .set({ status: 'ended', endsOn })
      .where(and(eq(bookingSeries.tenantId, tenantId), eq(bookingSeries.id, seriesId)));

    return { ended: true, cancelledFrom: from, cancelledCount: cancelled };
  }

  // ------------------------------------------------------ materialising --

  /**
   * Creates the series' bookings up to a horizon.
   *
   * Every occurrence is inserted on its own rather than inside one
   * transaction: a single clash must not roll back the eleven weeks that
   * *were* bookable. Whatever could not be created comes back in `skipped`, so
   * the owner is told which Tuesdays they still need to sort out rather than
   * discovering it later.
   */
  async materialise(tenantId: string, seriesId: string, through: string): Promise<MaterialiseResult> {
    const series = await this.getRaw(tenantId, seriesId);
    const venue = await this.loadVenue(series.venueId);
    const tz = venue.timezone;

    const dates = occurrenceDates(series.dayOfWeek, series.startsOn, series.endsOn, through);

    const [existing, hourRules, priceRules] = await Promise.all([
      this.db
        .select({ occurrenceDate: reservations.occurrenceDate })
        .from(reservations)
        .where(
          and(
            eq(reservations.tenantId, tenantId),
            eq(reservations.seriesId, seriesId),
            sql`${reservations.status} <> 'cancelled'`,
          ),
        ),
      this.hours.rulesForResources(tenantId, [series.resourceId]),
      this.pricing.rulesForResources(tenantId, [series.resourceId]),
    ]);
    const already = new Set(existing.map((r) => r.occurrenceDate));
    const overrides = dates.length
      ? await this.hours.overridesForRange(tenantId, series.venueId, dates[0], dates.at(-1)!)
      : [];

    const created: MaterialiseResult['created'] = [];
    const skipped: MaterialiseResult['skipped'] = [];

    for (const date of dates) {
      if (already.has(date)) {
        skipped.push({ date, reason: 'already-booked', detail: 'Already on the calendar.' });
        continue;
      }

      const interval = intervalFor(date, tz, series.startsAt, series.durationMinutes);
      const dayOfWeek = DateTime.fromISO(date, { zone: 'utc' }).weekday % 7;
      const opening = openingFor(date, dayOfWeek, series.resourceId, hourRules, overrides);

      if (opening.closed) {
        skipped.push({ date, reason: 'closed', detail: opening.reason ?? 'The court is closed.' });
        continue;
      }
      if (!isWithinOpening(interval, tz, date, opening.windows)) {
        skipped.push({
          date,
          reason: 'outside-hours',
          detail: `Outside opening hours (${opening.windows
            .map((w) => `${w.opensAt.slice(0, 5)}–${w.closesAt.slice(0, 5)}`)
            .join(', ')}).`,
        });
        continue;
      }

      const amountPaise =
        series.amountPaise ??
        this.pricing.priceFor(interval, tz, priceRules.get(series.resourceId) ?? []) ??
        0;

      try {
        const [row] = await this.db
          .insert(reservations)
          .values({
            tenantId,
            venueId: series.venueId,
            resourceId: series.resourceId,
            kind: 'booking',
            status: 'confirmed',
            during: interval,
            customerId: series.customerId,
            amountPaise,
            notes: series.notes,
            seriesId: series.id,
            occurrenceDate: date,
            createdBy: series.createdBy,
          })
          .returning({ id: reservations.id });
        created.push({ date, reservationId: row.id, amountPaise });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === PG_EXCLUSION_VIOLATION) {
          skipped.push({ date, reason: 'clash', detail: 'Something else is already booked then.' });
          continue;
        }
        if (code === PG_UNIQUE_VIOLATION) {
          skipped.push({ date, reason: 'already-booked', detail: 'Already on the calendar.' });
          continue;
        }
        rethrowAsHttp(err);
      }
    }

    await this.db
      .update(bookingSeries)
      .set({ materialisedThrough: through })
      .where(and(eq(bookingSeries.tenantId, tenantId), eq(bookingSeries.id, seriesId)));

    return { created, skipped, materialisedThrough: through };
  }

  /** Rolls every active series forward. Used by the nightly job. */
  async materialiseAllActive(weeks = DEFAULT_HORIZON_WEEKS) {
    const active = await this.db
      .select({ id: bookingSeries.id, tenantId: bookingSeries.tenantId, venueId: bookingSeries.venueId })
      .from(bookingSeries)
      .where(eq(bookingSeries.status, 'active'));

    let created = 0;
    let skipped = 0;
    for (const series of active) {
      try {
        const venue = await this.loadVenue(series.venueId);
        const through = horizonFrom(DateTime.now().setZone(venue.timezone).toISODate()!, weeks);
        const result = await this.materialise(series.tenantId, series.id, through);
        created += result.created.length;
        skipped += result.skipped.filter((s) => s.reason !== 'already-booked').length;
      } catch (err) {
        // One bad series must not stop the rest from rolling forward.
        this.logger.error(
          `Could not extend series ${series.id}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return { series: active.length, created, skipped };
  }

  // ----------------------------------------------------------- queries --

  async list(tenantId: string, query: ListSeriesDto) {
    const filters: SQL[] = [eq(bookingSeries.tenantId, tenantId)];
    if (query.venueId) filters.push(eq(bookingSeries.venueId, query.venueId));
    if (query.resourceId) filters.push(eq(bookingSeries.resourceId, query.resourceId));
    if (query.status) filters.push(eq(bookingSeries.status, query.status));
    return this.selectSeries(filters);
  }

  private selectSeries(filters: SQL[]) {
    return this.db
      .select({
        id: bookingSeries.id,
        dayOfWeek: bookingSeries.dayOfWeek,
        startsAt: bookingSeries.startsAt,
        durationMinutes: bookingSeries.durationMinutes,
        startsOn: bookingSeries.startsOn,
        endsOn: bookingSeries.endsOn,
        amountPaise: bookingSeries.amountPaise,
        notes: bookingSeries.notes,
        status: bookingSeries.status,
        materialisedThrough: bookingSeries.materialisedThrough,
        resourceId: resources.id,
        resourceName: resources.name,
        sport: resources.sport,
        venueId: venues.id,
        timezone: venues.timezone,
        customerId: customers.id,
        customerName: customers.name,
        customerPhone: customers.phone,
        upcoming: sql<number>`(
          SELECT count(*) FROM reservation r
          WHERE r.series_id = ${bookingSeries.id}
            AND r.status NOT IN ('cancelled')
            AND lower(r.during) >= now()
        )`,
      })
      .from(bookingSeries)
      .innerJoin(resources, eq(resources.id, bookingSeries.resourceId))
      .innerJoin(venues, eq(venues.id, bookingSeries.venueId))
      .leftJoin(customers, eq(customers.id, bookingSeries.customerId))
      .where(and(...filters))
      .orderBy(desc(bookingSeries.status), asc(bookingSeries.dayOfWeek), asc(bookingSeries.startsAt));
  }

  async get(tenantId: string, seriesId: string) {
    const [row] = await this.selectSeries([
      eq(bookingSeries.tenantId, tenantId),
      eq(bookingSeries.id, seriesId),
    ]);
    if (!row) throw new NotFoundException('Series not found.');

    const occurrences = await this.db
      .select({
        id: reservations.id,
        occurrenceDate: reservations.occurrenceDate,
        during: reservations.during,
        status: reservations.status,
        amountPaise: reservations.amountPaise,
      })
      .from(reservations)
      .where(and(eq(reservations.tenantId, tenantId), eq(reservations.seriesId, seriesId)))
      .orderBy(asc(reservations.occurrenceDate));

    return { ...row, occurrences };
  }

  async getRaw(tenantId: string, seriesId: string) {
    const [row] = await this.db
      .select()
      .from(bookingSeries)
      .where(and(eq(bookingSeries.tenantId, tenantId), eq(bookingSeries.id, seriesId)))
      .limit(1);
    if (!row) throw new NotFoundException('Series not found.');
    return row;
  }

  // ----------------------------------------------------------- helpers --

  private async cancelOccurrencesFrom(tenantId: string, seriesId: string, fromDate: string) {
    const cancelled = await this.db
      .update(reservations)
      .set({ status: 'cancelled', cancelledAt: new Date() })
      .where(
        and(
          eq(reservations.tenantId, tenantId),
          eq(reservations.seriesId, seriesId),
          gte(reservations.occurrenceDate, fromDate),
          inArray(reservations.status, ['confirmed', 'held'] as ReservationStatus[]),
        ),
      )
      .returning({ id: reservations.id });
    return cancelled.length;
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

  private async loadVenue(venueId: string) {
    const [venue] = await this.db.select().from(venues).where(eq(venues.id, venueId)).limit(1);
    if (!venue) throw new NotFoundException('Venue not found.');
    return venue;
  }
}

function intervalFor(date: string, tz: string, startsAt: string, durationMinutes: number): Interval {
  const dayStart = DateTime.fromISO(date, { zone: tz }).startOf('day');
  const start = dayStart.plus({ minutes: timeToMinutes(startsAt) });
  return { start: start.toJSDate(), end: start.plus({ minutes: durationMinutes }).toJSDate() };
}

const nextDay = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' }).plus({ days: 1 }).toISODate()!;
const maxDate = (a: string, b: string) => (a >= b ? a : b);
const previousDay = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' }).minus({ days: 1 }).toISODate()!;
