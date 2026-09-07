import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hoursUntil, quoteRefund, type CancellationTier } from '../src/cancellation/resolve';

/** The policy most venues describe: full refund a day out, half within, none late. */
const STANDARD: CancellationTier[] = [
  { minHoursBefore: 24, refundPct: 100 },
  { minHoursBefore: 12, refundPct: 50 },
  { minHoursBefore: 0, refundPct: 0 },
];

describe('cancellation refunds', () => {
  it('reports "no policy" rather than a zero refund when nothing is configured', () => {
    const q = quoteRefund([], 48, 90000, 90000);
    assert.equal(q.configured, false);
    assert.equal(q.refundPct, null);
    assert.equal(q.refundPaise, 0);
  });

  it('gives a full refund well outside the window', () => {
    const q = quoteRefund(STANDARD, 48, 90000, 90000);
    assert.equal(q.refundPct, 100);
    assert.equal(q.refundPaise, 90000);
  });

  it('applies the tier exactly on its boundary', () => {
    assert.equal(quoteRefund(STANDARD, 24, 90000, 90000).refundPct, 100);
    assert.equal(quoteRefund(STANDARD, 12, 90000, 90000).refundPct, 50);
  });

  it('drops to the next tier just inside the boundary', () => {
    assert.equal(quoteRefund(STANDARD, 23, 90000, 90000).refundPct, 50);
    assert.equal(quoteRefund(STANDARD, 11, 90000, 90000).refundPct, 0);
  });

  it('refunds nothing once the booking has started', () => {
    const q = quoteRefund(STANDARD, -2, 90000, 90000);
    assert.equal(q.refundPct, 0);
    assert.equal(q.refundPaise, 0);
  });

  it('never refunds more than was actually collected', () => {
    // Billed Rs 900, only Rs 200 paid, full-refund tier.
    const q = quoteRefund(STANDARD, 48, 90000, 20000);
    assert.equal(q.refundPct, 100);
    assert.equal(q.refundPaise, 20000);
    assert.equal(q.cappedByPaid, true);
  });

  it('does not flag a cap when the policy amount is affordable', () => {
    assert.equal(quoteRefund(STANDARD, 48, 90000, 90000).cappedByPaid, false);
  });

  it('refunds nothing on an unpaid booking, whatever the tier', () => {
    const q = quoteRefund(STANDARD, 72, 90000, 0);
    assert.equal(q.refundPaise, 0);
    assert.equal(q.cappedByPaid, true);
  });

  it('rounds a half-refund to whole paise', () => {
    assert.equal(quoteRefund(STANDARD, 18, 75001, 75001).refundPaise, 37501);
  });

  it('handles a policy with a single tier', () => {
    const q = quoteRefund([{ minHoursBefore: 48, refundPct: 100 }], 12, 90000, 90000);
    assert.equal(q.refundPct, 0, 'below the only threshold means no refund');
    assert.equal(q.tier, null);
  });

  it('picks the most generous threshold that still applies, whatever the order', () => {
    const shuffled: CancellationTier[] = [
      { minHoursBefore: 0, refundPct: 0 },
      { minHoursBefore: 24, refundPct: 100 },
      { minHoursBefore: 12, refundPct: 50 },
    ];
    assert.equal(quoteRefund(shuffled, 30, 90000, 90000).refundPct, 100);
  });

  it('measures hours until the booking in whole hours', () => {
    const now = new Date('2026-11-14T10:00:00Z');
    assert.equal(hoursUntil(new Date('2026-11-15T10:00:00Z'), now), 24);
    assert.equal(hoursUntil(new Date('2026-11-14T21:30:00Z'), now), 11);
    assert.equal(hoursUntil(new Date('2026-11-14T08:00:00Z'), now), -2);
  });
});
