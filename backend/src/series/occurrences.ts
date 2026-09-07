import { DateTime } from 'luxon';

/**
 * The dates a weekly series falls on, from its start up to a horizon.
 *
 * Pure and date-only: which dates recur is a calendar question, not a timezone
 * one. Turning a date into an actual interval happens later, in the venue's own
 * timezone, so a series survives a DST boundary as "still 8pm on Tuesday"
 * rather than drifting by an hour.
 */
export function occurrenceDates(
  dayOfWeek: number,
  startsOn: string,
  endsOn: string | null,
  through: string,
  cap = 520,
): string[] {
  const limit = endsOn && endsOn < through ? endsOn : through;
  if (limit < startsOn) return [];

  let cursor = DateTime.fromISO(startsOn, { zone: 'utc' });
  if (!cursor.isValid) throw new Error(`Invalid start date: ${startsOn}`);

  // Luxon weekdays run 1 = Monday .. 7 = Sunday; ours run 0 = Sunday.
  const advance = (dayOfWeek - (cursor.weekday % 7) + 7) % 7;
  cursor = cursor.plus({ days: advance });

  const dates: string[] = [];
  while (dates.length < cap) {
    const iso = cursor.toISODate()!;
    if (iso > limit) break;
    dates.push(iso);
    cursor = cursor.plus({ weeks: 1 });
  }
  return dates;
}

/** The horizon a series should be materialised to: today plus a number of weeks. */
export function horizonFrom(todayISO: string, weeks: number): string {
  return DateTime.fromISO(todayISO, { zone: 'utc' }).plus({ weeks }).toISODate()!;
}
