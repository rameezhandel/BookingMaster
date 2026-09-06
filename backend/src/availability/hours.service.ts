import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, between, eq, inArray, sql } from 'drizzle-orm';
import { DB, type Db, type DbExecutor } from '../db/database.module';
import { resourceHourRules, resources, venueDateOverrides } from '../db/schema';
import { timeToMinutes } from '../common/time';
import { rethrowAsHttp } from '../common/errors';
import { VenuesService } from '../venues/venues.service';
import type { CreateOverrideDto, HourWindowDto, ListOverridesDto } from './dto';
import type { DateOverride, HourRule } from './resolve';

@Injectable()
export class HoursService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly venues: VenuesService,
  ) {}

  // ------------------------------------------------------ weekly hours --

  async list(tenantId: string, resourceId: string) {
    await this.venues.getResource(tenantId, resourceId);
    return this.db
      .select()
      .from(resourceHourRules)
      .where(and(eq(resourceHourRules.tenantId, tenantId), eq(resourceHourRules.resourceId, resourceId)))
      .orderBy(asc(resourceHourRules.dayOfWeek), asc(resourceHourRules.opensAt));
  }

  /**
   * Replaces a court's whole week in one transaction.
   *
   * Editing windows individually would let the editor leave a half-saved
   * schedule behind if one window collided; replacing the set means the owner
   * either gets the schedule they submitted or the one they had.
   */
  async replace(tenantId: string, resourceId: string, windows: HourWindowDto[]) {
    await this.venues.getResource(tenantId, resourceId);
    assertWindowsSane(windows);

    try {
      return await this.db.transaction(async (tx) => {
        await tx
          .delete(resourceHourRules)
          .where(
            and(eq(resourceHourRules.tenantId, tenantId), eq(resourceHourRules.resourceId, resourceId)),
          );

        if (windows.length === 0) return [];

        return tx
          .insert(resourceHourRules)
          .values(
            windows.map((w) => ({
              tenantId,
              resourceId,
              dayOfWeek: w.dayOfWeek,
              opensAt: w.opensAt,
              closesAt: w.closesAt,
            })),
          )
          .returning();
      });
    } catch (err) {
      rethrowAsHttp(err);
    }
  }

  /** Used when a court is created: the same window on every day, as a starting point. */
  async seedUniformWeek(
    exec: DbExecutor,
    tenantId: string,
    resourceId: string,
    opensAt: string,
    closesAt: string,
  ) {
    if (timeToMinutes(closesAt) <= timeToMinutes(opensAt)) {
      throw new BadRequestException('Closing time must be after opening time.');
    }
    await exec.insert(resourceHourRules).values(
      [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ tenantId, resourceId, dayOfWeek, opensAt, closesAt })),
    );
  }

  // --------------------------------------------------- date overrides --

  async listOverrides(tenantId: string, venueId: string, query: ListOverridesDto) {
    await this.venues.get(tenantId, venueId);
    const filters = [eq(venueDateOverrides.tenantId, tenantId), eq(venueDateOverrides.venueId, venueId)];
    if (query.from && query.to) {
      filters.push(between(venueDateOverrides.onDate, query.from, query.to));
    } else if (query.from) {
      filters.push(sql`${venueDateOverrides.onDate} >= ${query.from}`);
    } else if (query.to) {
      filters.push(sql`${venueDateOverrides.onDate} <= ${query.to}`);
    }
    return this.db
      .select()
      .from(venueDateOverrides)
      .where(and(...filters))
      .orderBy(asc(venueDateOverrides.onDate));
  }

  async createOverride(tenantId: string, venueId: string, dto: CreateOverrideDto) {
    await this.venues.get(tenantId, venueId);
    if (dto.resourceId) {
      const resource = await this.venues.getResource(tenantId, dto.resourceId);
      if (resource.venueId !== venueId) {
        throw new BadRequestException('That court belongs to a different venue.');
      }
    }

    const isClosed = dto.isClosed ?? true;
    if (!isClosed) {
      if (!dto.opensAt || !dto.closesAt) {
        throw new BadRequestException('Give opening and closing times, or mark the day closed.');
      }
      if (timeToMinutes(dto.closesAt) <= timeToMinutes(dto.opensAt)) {
        throw new BadRequestException('Closing time must be after opening time.');
      }
    }

    try {
      const [created] = await this.db
        .insert(venueDateOverrides)
        .values({
          tenantId,
          venueId,
          resourceId: dto.resourceId ?? null,
          onDate: dto.onDate.slice(0, 10),
          isClosed,
          opensAt: isClosed ? null : dto.opensAt,
          closesAt: isClosed ? null : dto.closesAt,
          reason: dto.reason,
        })
        .returning();
      return created;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'There is already an override for that date. Remove it before adding another.',
        );
      }
      rethrowAsHttp(err);
    }
  }

  async removeOverride(tenantId: string, overrideId: string) {
    const [existing] = await this.db
      .select()
      .from(venueDateOverrides)
      .where(and(eq(venueDateOverrides.tenantId, tenantId), eq(venueDateOverrides.id, overrideId)))
      .limit(1);
    if (!existing) throw new NotFoundException('Override not found.');

    await this.db
      .delete(venueDateOverrides)
      .where(and(eq(venueDateOverrides.tenantId, tenantId), eq(venueDateOverrides.id, overrideId)));
    return { deleted: true };
  }

  // -------------------------------------------- reads for the calendar --

  /** Weekly rules for a set of courts, shaped for the pure resolver. */
  async rulesForResources(tenantId: string, resourceIds: string[]): Promise<HourRule[]> {
    if (resourceIds.length === 0) return [];
    const rows = await this.db
      .select({
        resourceId: resourceHourRules.resourceId,
        dayOfWeek: resourceHourRules.dayOfWeek,
        opensAt: resourceHourRules.opensAt,
        closesAt: resourceHourRules.closesAt,
      })
      .from(resourceHourRules)
      .where(
        and(
          eq(resourceHourRules.tenantId, tenantId),
          inArray(resourceHourRules.resourceId, resourceIds),
        ),
      );
    return rows;
  }

  /** Overrides covering a date range, both venue-wide and court-specific. */
  async overridesForRange(
    tenantId: string,
    venueId: string,
    from: string,
    to: string,
  ): Promise<DateOverride[]> {
    const rows = await this.db
      .select({
        resourceId: venueDateOverrides.resourceId,
        onDate: venueDateOverrides.onDate,
        isClosed: venueDateOverrides.isClosed,
        opensAt: venueDateOverrides.opensAt,
        closesAt: venueDateOverrides.closesAt,
        reason: venueDateOverrides.reason,
      })
      .from(venueDateOverrides)
      .where(
        and(
          eq(venueDateOverrides.tenantId, tenantId),
          eq(venueDateOverrides.venueId, venueId),
          between(venueDateOverrides.onDate, from, to),
        ),
      );
    return rows;
  }
}

function assertWindowsSane(windows: HourWindowDto[]) {
  for (const w of windows) {
    if (timeToMinutes(w.closesAt) <= timeToMinutes(w.opensAt)) {
      throw new BadRequestException(
        `Closing time must be after opening time (${w.opensAt}–${w.closesAt}).`,
      );
    }
  }

  // Caught by the database too, but a clear message beats a constraint name.
  const byDay = new Map<number, HourWindowDto[]>();
  for (const w of windows) {
    const list = byDay.get(w.dayOfWeek) ?? [];
    list.push(w);
    byDay.set(w.dayOfWeek, list);
  }
  for (const [day, list] of byDay) {
    const sorted = [...list].sort((a, b) => a.opensAt.localeCompare(b.opensAt));
    for (let i = 1; i < sorted.length; i++) {
      if (timeToMinutes(sorted[i].opensAt) < timeToMinutes(sorted[i - 1].closesAt)) {
        throw new BadRequestException(
          `Opening windows overlap on day ${day}: ${sorted[i - 1].opensAt}–${sorted[i - 1].closesAt} and ${sorted[i].opensAt}–${sorted[i].closesAt}.`,
        );
      }
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && (err as { code?: string }).code === '23505';
}
