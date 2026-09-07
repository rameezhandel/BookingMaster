import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isWithinOpening,
  openingFor,
  slotsForWindows,
  type DateOverride,
  type HourRule,
} from '../src/availability/resolve';

const IST = 'Asia/Kolkata';
const COURT = 'court-1';
const OTHER = 'court-2';

function rule(dayOfWeek: number, opensAt: string, closesAt: string, resourceId = COURT): HourRule {
  return { resourceId, dayOfWeek, opensAt, closesAt };
}

function override(over: Partial<DateOverride>): DateOverride {
  return {
    resourceId: null,
    onDate: '2026-11-14',
    isClosed: true,
    opensAt: null,
    closesAt: null,
    reason: null,
    ...over,
  };
}

describe('opening hours', () => {
  it('uses the weekly rule for the matching day', () => {
    const rules = [rule(6, '06:00', '23:00'), rule(1, '08:00', '20:00')];
    const saturday = openingFor('2026-11-14', 6, COURT, rules, []);
    assert.deepEqual(saturday.windows, [{ opensAt: '06:00', closesAt: '23:00' }]);
    assert.equal(saturday.closed, false);
    assert.equal(saturday.source, 'weekly');
  });

  it('supports different hours per day, which is the point of the table', () => {
    const rules = [rule(0, '05:00', '23:00'), rule(1, '06:00', '22:00')];
    assert.equal(openingFor('2026-11-15', 0, COURT, rules, []).windows[0].opensAt, '05:00');
    assert.equal(openingFor('2026-11-16', 1, COURT, rules, []).windows[0].opensAt, '06:00');
  });

  it('returns both windows of a split day, in order', () => {
    const rules = [rule(1, '16:00', '23:00'), rule(1, '06:00', '12:00')];
    const day = openingFor('2026-11-16', 1, COURT, rules, []);
    assert.deepEqual(day.windows, [
      { opensAt: '06:00', closesAt: '12:00' },
      { opensAt: '16:00', closesAt: '23:00' },
    ]);
  });

  it('treats a weekday with no rule as closed', () => {
    const day = openingFor('2026-11-14', 6, COURT, [rule(1, '06:00', '23:00')], []);
    assert.equal(day.closed, true);
    assert.deepEqual(day.windows, []);
  });

  it('ignores rules belonging to another court', () => {
    const day = openingFor('2026-11-14', 6, COURT, [rule(6, '06:00', '23:00', OTHER)], []);
    assert.equal(day.closed, true);
  });

  it('lets a venue-wide closure beat the weekly rules', () => {
    const rules = [rule(6, '06:00', '23:00')];
    const day = openingFor('2026-11-14', 6, COURT, rules, [
      override({ isClosed: true, reason: 'Diwali' }),
    ]);
    assert.equal(day.closed, true);
    assert.equal(day.reason, 'Diwali');
    assert.equal(day.source, 'venue-override');
  });

  it('lets a venue-wide override set special hours instead of closing', () => {
    const rules = [rule(6, '06:00', '23:00')];
    const day = openingFor('2026-11-14', 6, COURT, rules, [
      override({ isClosed: false, opensAt: '16:00', closesAt: '20:00', reason: 'Half day' }),
    ]);
    assert.deepEqual(day.windows, [{ opensAt: '16:00', closesAt: '20:00' }]);
    assert.equal(day.closed, false);
  });

  it('lets a court override beat a venue-wide closure', () => {
    const rules = [rule(6, '06:00', '23:00')];
    const day = openingFor('2026-11-14', 6, COURT, rules, [
      override({ isClosed: true, reason: 'Republic Day' }),
      override({ resourceId: COURT, isClosed: false, opensAt: '16:00', closesAt: '20:00', reason: 'Evening only' }),
    ]);
    assert.equal(day.closed, false);
    assert.equal(day.source, 'court-override');
    assert.deepEqual(day.windows, [{ opensAt: '16:00', closesAt: '20:00' }]);
  });

  it('applies an override only to its own date', () => {
    const rules = [rule(6, '06:00', '23:00'), rule(0, '06:00', '23:00')];
    const overrides = [override({ isClosed: true, onDate: '2026-11-14' })];
    assert.equal(openingFor('2026-11-14', 6, COURT, rules, overrides).closed, true);
    assert.equal(openingFor('2026-11-15', 0, COURT, rules, overrides).closed, false);
  });
});

describe('slots across windows', () => {
  it('generates a run of slots per window and keeps them ordered', () => {
    const slots = slotsForWindows(
      '2026-11-16',
      IST,
      [
        { opensAt: '06:00', closesAt: '09:00' },
        { opensAt: '16:00', closesAt: '18:00' },
      ],
      60,
    );
    assert.equal(slots.length, 5);
    // 06:00 IST is 00:30 UTC; the midday gap is simply absent.
    assert.equal(slots[0].start.toISOString(), '2026-11-16T00:30:00.000Z');
    assert.equal(slots[2].end.toISOString(), '2026-11-16T03:30:00.000Z'); // 09:00 IST
    assert.equal(slots[3].start.toISOString(), '2026-11-16T10:30:00.000Z'); // 16:00 IST
  });

  it('generates nothing for a closed day', () => {
    assert.deepEqual(slotsForWindows('2026-11-16', IST, [], 60), []);
  });
});

describe('booking against opening hours', () => {
  const windows = [
    { opensAt: '06:00', closesAt: '13:00' },
    { opensAt: '17:00', closesAt: '23:00' },
  ];
  const at = (hhmm: string) => new Date(`2026-11-16T${hhmm}:00+05:30`);

  it('accepts a booking inside a window', () => {
    assert.equal(
      isWithinOpening({ start: at('19:00'), end: at('20:00') }, IST, '2026-11-16', windows),
      true,
    );
  });

  it('accepts a booking flush against the edges of a window', () => {
    assert.equal(
      isWithinOpening({ start: at('06:00'), end: at('07:00') }, IST, '2026-11-16', windows),
      true,
    );
    assert.equal(
      isWithinOpening({ start: at('12:00'), end: at('13:00') }, IST, '2026-11-16', windows),
      true,
    );
  });

  it('rejects a booking in the midday closure', () => {
    assert.equal(
      isWithinOpening({ start: at('14:00'), end: at('15:00') }, IST, '2026-11-16', windows),
      false,
    );
  });

  it('rejects a booking that straddles two windows', () => {
    assert.equal(
      isWithinOpening({ start: at('12:00'), end: at('18:00') }, IST, '2026-11-16', windows),
      false,
    );
  });

  it('rejects a booking that runs past closing', () => {
    assert.equal(
      isWithinOpening({ start: at('22:00'), end: at('23:30') }, IST, '2026-11-16', windows),
      false,
    );
  });

  it('handles a court that closes at midnight', () => {
    const allNight = [{ opensAt: '06:00', closesAt: '24:00' }];
    assert.equal(
      isWithinOpening({ start: at('23:00'), end: at('24:00') }, IST, '2026-11-16', allNight),
      true,
    );
  });

  it('rejects everything on a closed day', () => {
    assert.equal(
      isWithinOpening({ start: at('10:00'), end: at('11:00') }, IST, '2026-11-16', []),
      false,
    );
  });
});
