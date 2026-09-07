import { DateTime } from 'luxon';

/** Money is paise everywhere except right here. */
export function rupees(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '—';
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

export function paiseFromRupeeInput(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function timeIn(iso: string, tz: string): string {
  return DateTime.fromISO(iso, { zone: tz }).toFormat('HH:mm');
}

export function rangeIn(startISO: string, endISO: string, tz: string): string {
  return `${timeIn(startISO, tz)}–${timeIn(endISO, tz)}`;
}

export function dayLabel(dateISO: string, tz: string): string {
  const d = DateTime.fromISO(dateISO, { zone: tz });
  const today = DateTime.now().setZone(tz).startOf('day');
  const diff = d.startOf('day').diff(today, 'days').days;
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return d.toFormat('ccc d LLL');
}

export function fullDate(dateISO: string, tz: string): string {
  return DateTime.fromISO(dateISO, { zone: tz }).toFormat('cccc, d LLLL yyyy');
}

export function todayIn(tz: string): string {
  return DateTime.now().setZone(tz).toISODate()!;
}

export function shiftDate(dateISO: string, days: number): string {
  return DateTime.fromISO(dateISO).plus({ days }).toISODate()!;
}

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Tuesdays at 19:00" reads properly; "Tues at 19:00" does not. */
export const DAY_PLURALS = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
];

export function describeDays(days: number[]): string {
  if (days.length === 7) return 'Every day';
  if (days.length === 2 && days.includes(0) && days.includes(6)) return 'Weekends';
  if (days.length === 5 && !days.includes(0) && !days.includes(6)) return 'Weekdays';
  return days.map((d) => DAY_NAMES[d]).join(', ');
}

/** Postgres hands back "19:00:00"; owners read "19:00". */
export function shortTime(value: string): string {
  return value.slice(0, 5);
}
