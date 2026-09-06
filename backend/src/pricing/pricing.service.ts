import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { DB, type Db } from '../db/database.module';
import { priceRules } from '../db/schema';
import { durationMinutes, timeToMinutes, type Interval } from '../common/time';
import { resolvePrice, type PriceRule } from './resolve';
import { VenuesService } from '../venues/venues.service';
import type { CreatePriceRuleDto, UpdatePriceRuleDto } from './dto';

export function daysToMask(days: number[]): number {
  return days.reduce((mask, day) => mask | (1 << day), 0);
}

export function maskToDays(mask: number): number[] {
  return [0, 1, 2, 3, 4, 5, 6].filter((day) => (mask & (1 << day)) !== 0);
}

@Injectable()
export class PricingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly venues: VenuesService,
  ) {}

  // ------------------------------------------------------------- lookup --

  async rulesForResources(tenantId: string, resourceIds: string[]): Promise<Map<string, PriceRule[]>> {
    const byResource = new Map<string, PriceRule[]>();
    if (resourceIds.length === 0) return byResource;

    const rows = await this.db
      .select()
      .from(priceRules)
      .where(
        and(
          eq(priceRules.tenantId, tenantId),
          inArray(priceRules.resourceId, resourceIds),
          eq(priceRules.isActive, true),
        ),
      )
      .orderBy(desc(priceRules.priority), desc(priceRules.createdAt));

    for (const rule of rows) {
      const list = byResource.get(rule.resourceId) ?? [];
      list.push(rule);
      byResource.set(rule.resourceId, list);
    }
    return byResource;
  }

  /** @see resolvePrice — kept as a method so callers need not import both. */
  priceFor(interval: Interval, timezone: string, rules: PriceRule[]): number | null {
    return resolvePrice(interval, timezone, rules);
  }

  async quote(tenantId: string, resourceId: string, interval: Interval) {
    const resource = await this.venues.getResource(tenantId, resourceId);
    const venue = await this.venues.get(tenantId, resource.venueId);
    const rules = (await this.rulesForResources(tenantId, [resourceId])).get(resourceId) ?? [];
    const pricePaise = this.priceFor(interval, venue.timezone, rules);
    return {
      resourceId,
      start: interval.start.toISOString(),
      end: interval.end.toISOString(),
      minutes: durationMinutes(interval),
      pricePaise,
    };
  }

  // ---------------------------------------------------------- rule CRUD --

  async list(tenantId: string, resourceId: string) {
    await this.venues.getResource(tenantId, resourceId);
    const rows = await this.db
      .select()
      .from(priceRules)
      .where(and(eq(priceRules.tenantId, tenantId), eq(priceRules.resourceId, resourceId)))
      .orderBy(desc(priceRules.priority), asc(priceRules.startsAt));
    return rows.map(present);
  }

  async create(tenantId: string, resourceId: string, dto: CreatePriceRuleDto) {
    await this.venues.getResource(tenantId, resourceId);
    const startsAt = dto.startsAt ?? '00:00';
    const endsAt = dto.endsAt ?? '24:00';
    assertWindow(startsAt, endsAt);
    assertDates(dto.validFrom, dto.validTo);

    const [rule] = await this.db
      .insert(priceRules)
      .values({
        tenantId,
        resourceId,
        name: dto.name,
        dowMask: dto.days ? daysToMask(dto.days) : 127,
        startsAt,
        endsAt,
        pricePerHourPaise: dto.pricePerHourPaise,
        priority: dto.priority ?? 0,
        validFrom: dto.validFrom ?? null,
        validTo: dto.validTo ?? null,
      })
      .returning();
    return present(rule);
  }

  async update(tenantId: string, ruleId: string, dto: UpdatePriceRuleDto) {
    const existing = await this.getRule(tenantId, ruleId);
    const startsAt = dto.startsAt ?? existing.startsAt;
    const endsAt = dto.endsAt ?? existing.endsAt;
    assertWindow(startsAt, endsAt);
    assertDates(dto.validFrom ?? existing.validFrom, dto.validTo ?? existing.validTo);

    const { days, ...rest } = dto;
    const [rule] = await this.db
      .update(priceRules)
      .set({ ...rest, ...(days ? { dowMask: daysToMask(days) } : {}) })
      .where(and(eq(priceRules.tenantId, tenantId), eq(priceRules.id, ruleId)))
      .returning();
    return present(rule);
  }

  async remove(tenantId: string, ruleId: string) {
    await this.getRule(tenantId, ruleId);
    await this.db
      .delete(priceRules)
      .where(and(eq(priceRules.tenantId, tenantId), eq(priceRules.id, ruleId)));
    return { deleted: true };
  }

  private async getRule(tenantId: string, ruleId: string) {
    const [rule] = await this.db
      .select()
      .from(priceRules)
      .where(and(eq(priceRules.tenantId, tenantId), eq(priceRules.id, ruleId)))
      .limit(1);
    if (!rule) throw new NotFoundException('Price rule not found.');
    return rule;
  }
}

function present(rule: PriceRule) {
  return { ...rule, days: maskToDays(rule.dowMask) };
}

function assertWindow(startsAt: string, endsAt: string) {
  if (timeToMinutes(endsAt) <= timeToMinutes(startsAt)) {
    throw new BadRequestException('Rule end time must be after its start time.');
  }
}

function assertDates(validFrom?: string | null, validTo?: string | null) {
  if (validFrom && validTo && validTo < validFrom) {
    throw new BadRequestException('"Valid to" must not be before "valid from".');
  }
}
