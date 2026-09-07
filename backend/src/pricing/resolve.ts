import { durationMinutes, localParts, timeToMinutes, toISODate, type Interval } from '../common/time';
import type { priceRules } from '../db/schema';

export type PriceRule = typeof priceRules.$inferSelect;

/**
 * Resolves the price of one interval against a resource's rules.
 *
 * Pure on purpose: pricing is the part owners argue about, so it must be
 * testable without a database.
 *
 * The highest-priority rule whose day, date window and time window contain the
 * slot's start wins. Ties break towards the narrower window, which is what an
 * owner means when they add "Saturday evening" on top of "Saturday".
 *
 * Returns null when no rule covers the slot, so the UI can say "no price set"
 * rather than quietly charging zero.
 */
export function resolvePrice(
  interval: Interval,
  timezone: string,
  rules: PriceRule[],
): number | null {
  const { minutes, dow } = localParts(interval.start, timezone);
  const date = toISODate(interval.start, timezone);

  const candidates = rules.filter((rule) => {
    if (!rule.isActive) return false;
    if ((rule.dowMask & (1 << dow)) === 0) return false;
    if (rule.validFrom && date < rule.validFrom) return false;
    if (rule.validTo && date > rule.validTo) return false;
    const from = timeToMinutes(rule.startsAt);
    const to = timeToMinutes(rule.endsAt);
    return minutes >= from && minutes < to;
  });

  if (candidates.length === 0) return null;

  const best = candidates.reduce((a, b) => {
    if (b.priority !== a.priority) return b.priority > a.priority ? b : a;
    const widthA = timeToMinutes(a.endsAt) - timeToMinutes(a.startsAt);
    const widthB = timeToMinutes(b.endsAt) - timeToMinutes(b.startsAt);
    if (widthA !== widthB) return widthB < widthA ? b : a;
    return b.createdAt > a.createdAt ? b : a;
  });

  // Rules are quoted per hour; a 30-minute slot costs half, a 90-minute one 1.5x.
  return Math.round((best.pricePerHourPaise * durationMinutes(interval)) / 60);
}
