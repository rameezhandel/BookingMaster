import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { horizonFrom, occurrenceDates } from '../src/series/occurrences';

// 2026-11-16 is a Monday; 2026-11-17 a Tuesday.
describe('series occurrences', () => {
  it('starts on the first matching weekday on or after the start date', () => {
    const dates = occurrenceDates(2, '2026-11-16', null, '2026-12-10');
    assert.equal(dates[0], '2026-11-17');
    assert.deepEqual(dates, ['2026-11-17', '2026-11-24', '2026-12-01', '2026-12-08']);
  });

  it('includes the start date itself when it already matches', () => {
    const dates = occurrenceDates(1, '2026-11-16', null, '2026-11-30');
    assert.equal(dates[0], '2026-11-16');
  });

  it('stops at the end date when that comes first', () => {
    const dates = occurrenceDates(2, '2026-11-16', '2026-12-01', '2027-06-01');
    assert.deepEqual(dates, ['2026-11-17', '2026-11-24', '2026-12-01']);
  });

  it('includes an end date that lands exactly on an occurrence', () => {
    const dates = occurrenceDates(2, '2026-11-16', '2026-11-24', '2027-06-01');
    assert.equal(dates.at(-1), '2026-11-24');
  });

  it('stops at the horizon when the series is open-ended', () => {
    const dates = occurrenceDates(2, '2026-11-16', null, '2026-11-24');
    assert.deepEqual(dates, ['2026-11-17', '2026-11-24']);
  });

  it('returns nothing when the horizon is before the start', () => {
    assert.deepEqual(occurrenceDates(2, '2026-11-16', null, '2026-11-01'), []);
  });

  it('returns nothing when the series already ended', () => {
    assert.deepEqual(occurrenceDates(2, '2026-11-16', '2026-11-10', '2027-01-01'), []);
  });

  it('handles every weekday, including Sunday as 0', () => {
    assert.equal(occurrenceDates(0, '2026-11-16', null, '2026-11-30')[0], '2026-11-22');
    assert.equal(occurrenceDates(6, '2026-11-16', null, '2026-11-30')[0], '2026-11-21');
  });

  it('crosses a month and a year boundary cleanly', () => {
    const dates = occurrenceDates(4, '2026-12-28', null, '2027-01-20');
    assert.deepEqual(dates, ['2026-12-31', '2027-01-07', '2027-01-14']);
  });

  it('respects the cap, so a runaway horizon cannot generate forever', () => {
    assert.equal(occurrenceDates(2, '2026-01-01', null, '2100-01-01', 10).length, 10);
  });

  it('computes a horizon in whole weeks', () => {
    assert.equal(horizonFrom('2026-11-16', 12), '2027-02-08');
  });
});
