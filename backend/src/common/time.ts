import { BadRequestException } from '@nestjs/common';
import { DateTime } from 'luxon';

export interface Interval {
  start: Date;
  end: Date;
}

/** Parses a Postgres `time` literal ("19:00", "19:00:00", "24:00:00") to minutes past midnight. */
export function timeToMinutes(value: string): number {
  const parts = value.split(':');
  const hours = Number(parts[0]);
  const minutes = Number(parts[1] ?? 0);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    throw new BadRequestException(`Invalid time value: ${value}`);
  }
  return hours * 60 + minutes;
}

export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Start of the given calendar date in the venue's own timezone. */
export function startOfDay(dateISO: string, timezone: string): DateTime {
  const dt = DateTime.fromISO(dateISO, { zone: timezone }).startOf('day');
  if (!dt.isValid) {
    throw new BadRequestException(`Invalid date "${dateISO}" for timezone "${timezone}"`);
  }
  return dt;
}

/**
 * Generates the bookable slots for one resource on one day.
 *
 * Slots are computed from opening-hour rules on every read. There is no
 * materialised slots table: it would be millions of rows, it would go stale the
 * moment a venue changed its hours, and every rule change would become a
 * backfill.
 */
export function generateSlots(
  dateISO: string,
  timezone: string,
  opensAt: string,
  closesAt: string,
  slotMinutes: number,
): Interval[] {
  if (slotMinutes <= 0) throw new BadRequestException('slotMinutes must be positive');

  const dayStart = startOfDay(dateISO, timezone);
  const openMinutes = timeToMinutes(opensAt);
  const closeMinutes = timeToMinutes(closesAt);

  const slots: Interval[] = [];
  for (let cursor = openMinutes; cursor + slotMinutes <= closeMinutes; cursor += slotMinutes) {
    slots.push({
      start: dayStart.plus({ minutes: cursor }).toJSDate(),
      end: dayStart.plus({ minutes: cursor + slotMinutes }).toJSDate(),
    });
  }
  return slots;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function durationMinutes(interval: Interval): number {
  return Math.round((interval.end.getTime() - interval.start.getTime()) / 60000);
}

/** Local wall-clock minutes past midnight, and day-of-week (0 = Sunday). */
export function localParts(instant: Date, timezone: string): { minutes: number; dow: number } {
  const dt = DateTime.fromJSDate(instant, { zone: timezone });
  return { minutes: dt.hour * 60 + dt.minute, dow: dt.weekday % 7 };
}

export function toISODate(instant: Date, timezone: string): string {
  return DateTime.fromJSDate(instant, { zone: timezone }).toISODate()!;
}
