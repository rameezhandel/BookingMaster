import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolvePrice, type PriceRule } from '../src/pricing/resolve';

const IST = 'Asia/Kolkata';

/** 2026-11-14 is a Saturday, 2026-11-17 a Tuesday. */
const saturdayEvening = {
  start: new Date('2026-11-14T13:30:00Z'), // 19:00 IST
  end: new Date('2026-11-14T14:30:00Z'),
};
const tuesdayMorning = {
  start: new Date('2026-11-17T01:30:00Z'), // 07:00 IST
  end: new Date('2026-11-17T02:30:00Z'),
};

function rule(over: Partial<PriceRule>): PriceRule {
  return {
    id: 'r', tenantId: 't', resourceId: 'c', name: 'rule',
    dowMask: 127, startsAt: '00:00', endsAt: '24:00',
    pricePerHourPaise: 50000, priority: 0,
    validFrom: null, validTo: null, isActive: true,
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
    ...over,
  } as PriceRule;
}

describe('price resolution', () => {
  it('returns null when no rule covers the slot, rather than charging zero', () => {
    assert.equal(resolvePrice(saturdayEvening, IST, []), null);
    const morningOnly = rule({ startsAt: '06:00', endsAt: '12:00' });
    assert.equal(resolvePrice(saturdayEvening, IST, [morningOnly]), null);
  });

  it('applies the base rate when nothing else matches', () => {
    assert.equal(resolvePrice(tuesdayMorning, IST, [rule({})]), 50000);
  });

  it('lets a higher-priority rule win over the base rate', () => {
    const rules = [
      rule({ id: 'base', priority: 0, pricePerHourPaise: 50000 }),
      rule({ id: 'peak', priority: 10, startsAt: '18:00', endsAt: '23:00', pricePerHourPaise: 75000 }),
    ];
    assert.equal(resolvePrice(saturdayEvening, IST, rules), 75000);
    assert.equal(resolvePrice(tuesdayMorning, IST, rules), 50000);
  });

  it('respects the day mask', () => {
    // Saturday is bit 6, Sunday bit 0.
    const weekendOnly = rule({ dowMask: (1 << 0) | (1 << 6), pricePerHourPaise: 90000, priority: 20 });
    const rules = [rule({ id: 'base' }), weekendOnly];
    assert.equal(resolvePrice(saturdayEvening, IST, rules), 90000);
    assert.equal(resolvePrice(tuesdayMorning, IST, rules), 50000);
  });

  it('breaks a priority tie towards the narrower window', () => {
    const rules = [
      rule({ id: 'wide', startsAt: '06:00', endsAt: '23:00', pricePerHourPaise: 50000, priority: 5 }),
      rule({ id: 'narrow', startsAt: '18:00', endsAt: '20:00', pricePerHourPaise: 88000, priority: 5 }),
    ];
    assert.equal(resolvePrice(saturdayEvening, IST, rules), 88000);
  });

  it('honours validity dates for a season or a one-off', () => {
    const diwali = rule({ pricePerHourPaise: 120000, priority: 50, validFrom: '2026-11-10', validTo: '2026-11-16' });
    assert.equal(resolvePrice(saturdayEvening, IST, [rule({}), diwali]), 120000);
    assert.equal(resolvePrice(tuesdayMorning, IST, [rule({}), diwali]), 50000);
  });

  it('ignores deactivated rules', () => {
    const off = rule({ pricePerHourPaise: 99000, priority: 99, isActive: false });
    assert.equal(resolvePrice(saturdayEvening, IST, [rule({}), off]), 50000);
  });

  it('prices part-hours pro rata', () => {
    const half = { start: saturdayEvening.start, end: new Date('2026-11-14T14:00:00Z') };
    assert.equal(resolvePrice(half, IST, [rule({ pricePerHourPaise: 50000 })]), 25000);

    const ninety = { start: saturdayEvening.start, end: new Date('2026-11-14T15:00:00Z') };
    assert.equal(resolvePrice(ninety, IST, [rule({ pricePerHourPaise: 50000 })]), 75000);
  });

  it('uses the slot start to decide which window applies', () => {
    // 19:00-20:00 starts inside the peak window even though it ends at its edge.
    const rules = [rule({ id: 'base' }), rule({ id: 'peak', priority: 10, startsAt: '19:00', endsAt: '20:00', pricePerHourPaise: 70000 })];
    assert.equal(resolvePrice(saturdayEvening, IST, rules), 70000);
  });
});
