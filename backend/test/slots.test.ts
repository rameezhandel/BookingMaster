import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateSlots, overlaps, timeToMinutes } from '../src/common/time';

const IST = 'Asia/Kolkata';

describe('slot generation', () => {
  it('generates one slot per hour between opening and closing', () => {
    const slots = generateSlots('2026-11-14', IST, '06:00', '23:00', 60);
    assert.equal(slots.length, 17);
    assert.equal(slots[0].start.toISOString(), '2026-11-14T00:30:00.000Z'); // 06:00 IST
    assert.equal(slots.at(-1)!.end.toISOString(), '2026-11-14T17:30:00.000Z'); // 23:00 IST
  });

  it('handles a venue that closes at midnight', () => {
    const slots = generateSlots('2026-11-14', IST, '06:00', '24:00', 60);
    assert.equal(slots.length, 18);
    assert.equal(timeToMinutes('24:00:00'), 1440);
  });

  it('supports half-hour slots', () => {
    assert.equal(generateSlots('2026-11-14', IST, '06:00', '08:00', 30).length, 4);
  });

  it('never emits a slot that runs past closing time', () => {
    // 06:00-07:30 cannot fit a second 60-minute slot.
    const slots = generateSlots('2026-11-14', IST, '06:00', '07:30', 60);
    assert.equal(slots.length, 1);
    assert.equal(slots[0].end.toISOString(), '2026-11-14T01:30:00.000Z');
  });

  it('treats adjacent slots as non-overlapping', () => {
    const [first, second] = generateSlots('2026-11-14', IST, '19:00', '21:00', 60);
    assert.equal(first.end.getTime(), second.start.getTime());
    assert.equal(overlaps(first, second), false);
  });

  it('detects a partial overlap', () => {
    const a = { start: new Date('2026-11-14T13:30:00Z'), end: new Date('2026-11-14T14:30:00Z') };
    const b = { start: new Date('2026-11-14T14:00:00Z'), end: new Date('2026-11-14T15:00:00Z') };
    assert.equal(overlaps(a, b), true);
  });
});
