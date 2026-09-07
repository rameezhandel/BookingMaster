import { DateTime } from 'luxon';
import { generateSlots, timeToMinutes, type Interval } from '../common/time';

export interface OpeningWindow {
  opensAt: string;
  closesAt: string;
}

export interface HourRule {
  resourceId: string;
  dayOfWeek: number;
  opensAt: string;
  closesAt: string;
}

export interface DateOverride {
  resourceId: string | null;
  onDate: string;
  isClosed: boolean;
  opensAt: string | null;
  closesAt: string | null;
  reason: string | null;
}

export type OpeningSource = 'weekly' | 'venue-override' | 'court-override';

export interface DayOpening {
  windows: OpeningWindow[];
  closed: boolean;
  reason: string | null;
  source: OpeningSource;
}

/**
 * What hours a court actually keeps on one date.
 *
 * Three layers, most specific first: an override for this court on this date,
 * then an override for the whole venue on this date, then the weekly rules.
 *
 * An override replaces the day's hours rather than blocking part of them, so a
 * closed day generates no slots at all — there is nothing to book into, which
 * is different from a `block` reservation sitting on a slot that does exist.
 */
export function openingFor(
  date: string,
  dayOfWeek: number,
  resourceId: string,
  rules: HourRule[],
  overrides: DateOverride[],
): DayOpening {
  const onDate = overrides.filter((o) => o.onDate === date);

  const courtOverride = onDate.find((o) => o.resourceId === resourceId);
  const venueOverride = onDate.find((o) => o.resourceId === null);
  const override = courtOverride ?? venueOverride;

  if (override) {
    const source: OpeningSource = courtOverride ? 'court-override' : 'venue-override';
    if (override.isClosed || !override.opensAt || !override.closesAt) {
      return { windows: [], closed: true, reason: override.reason, source };
    }
    return {
      windows: [{ opensAt: override.opensAt, closesAt: override.closesAt }],
      closed: false,
      reason: override.reason,
      source,
    };
  }

  const windows = rules
    .filter((r) => r.resourceId === resourceId && r.dayOfWeek === dayOfWeek)
    .map((r) => ({ opensAt: r.opensAt, closesAt: r.closesAt }))
    .sort((a, b) => a.opensAt.localeCompare(b.opensAt));

  return {
    windows,
    // A weekday with no rule is a day the court simply does not open.
    closed: windows.length === 0,
    reason: null,
    source: 'weekly',
  };
}

/** Slots across every open window of a day, in order. A split day yields two runs. */
export function slotsForWindows(
  dateISO: string,
  timezone: string,
  windows: OpeningWindow[],
  slotMinutes: number,
): Interval[] {
  return windows
    .flatMap((w) => generateSlots(dateISO, timezone, w.opensAt, w.closesAt, slotMinutes))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * Whether a booking falls entirely inside one of the day's open windows.
 *
 * Minutes are measured from the venue-local start of the date, so a court that
 * closes at 24:00 and a booking ending at midnight compare correctly, and a
 * booking that spills into the next day reads as outside hours.
 *
 * A booking must sit inside a *single* window: 12:00-17:00 across a midday
 * closure is not "mostly open", it is booking a court that is shut.
 */
export function isWithinOpening(
  interval: Interval,
  timezone: string,
  dateISO: string,
  windows: OpeningWindow[],
): boolean {
  const dayStart = DateTime.fromISO(dateISO, { zone: timezone }).startOf('day').toMillis();
  const startMinutes = (interval.start.getTime() - dayStart) / 60_000;
  const endMinutes = (interval.end.getTime() - dayStart) / 60_000;

  return windows.some(
    (w) => startMinutes >= timeToMinutes(w.opensAt) && endMinutes <= timeToMinutes(w.closesAt),
  );
}
