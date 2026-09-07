/**
 * The arithmetic an accountant checks.
 *
 * The invariants matter more than any single figure: the components must sum to
 * the total exactly, at every amount and every rate. A paisa lost to rounding
 * is not a rounding error on an invoice, it is a document that does not add up.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeTax,
  financialYear,
  formatInvoiceNumber,
  isValidGstin,
  stateCodeOfGstin,
} from '../src/invoicing/gst';

describe('tax on an inclusive price', () => {
  it('splits ₹500 at 18% the way the counter means it', () => {
    // The customer hands over ₹500. That is the total, not the base.
    const t = computeTax({ amountPaise: 50_000, rateBp: 1800, inclusive: true, intraState: true });
    assert.equal(t.totalPaise, 50_000);
    assert.equal(t.taxablePaise, 42_373); // 500 / 1.18
    assert.equal(t.cgstPaise + t.sgstPaise, 7_627);
    assert.equal(t.igstPaise, 0);
  });

  it('gives the odd paisa to one half rather than losing it', () => {
    // A tax of an odd number of paise cannot be halved evenly.
    const t = computeTax({ amountPaise: 50_000, rateBp: 1800, inclusive: true, intraState: true });
    const tax = t.totalPaise - t.taxablePaise;
    assert.equal(tax % 2, 1, 'this amount is chosen because the tax is odd');
    assert.equal(t.cgstPaise, 3_813);
    assert.equal(t.sgstPaise, 3_814);
    assert.equal(t.cgstPaise + t.sgstPaise, tax);
  });

  it('charges one integrated amount across state lines', () => {
    const t = computeTax({ amountPaise: 50_000, rateBp: 1800, inclusive: true, intraState: false });
    assert.equal(t.cgstPaise, 0);
    assert.equal(t.sgstPaise, 0);
    assert.equal(t.igstPaise, 7_627);
    assert.equal(t.taxablePaise + t.igstPaise, t.totalPaise);
  });
});

describe('tax added on top', () => {
  it('adds 18% to a base price', () => {
    const t = computeTax({ amountPaise: 50_000, rateBp: 1800, inclusive: false, intraState: true });
    assert.equal(t.taxablePaise, 50_000);
    assert.equal(t.totalPaise, 59_000);
    assert.equal(t.cgstPaise, 4_500);
    assert.equal(t.sgstPaise, 4_500);
  });
});

describe('the invariants, across the whole range', () => {
  const RATES = [0, 500, 1200, 1800, 2800];

  it('never loses or invents a paisa, inclusive or exclusive', () => {
    for (const rateBp of RATES) {
      for (const intraState of [true, false]) {
        for (const inclusive of [true, false]) {
          // Every amount from nothing to a large hall booking, plus the awkward
          // ones just off a round number.
          for (let paise = 0; paise <= 200_000; paise += 37) {
            const t = computeTax({ amountPaise: paise, rateBp, inclusive, intraState });
            const tax = t.cgstPaise + t.sgstPaise + t.igstPaise;
            assert.equal(
              t.taxablePaise + tax,
              t.totalPaise,
              `components do not sum at ${paise}p, rate ${rateBp}, inclusive=${inclusive}`,
            );
            if (inclusive) {
              assert.equal(t.totalPaise, paise, `an inclusive price must not change: ${paise}p`);
            } else {
              assert.equal(t.taxablePaise, paise, `an exclusive base must not change: ${paise}p`);
            }
            assert.ok(Number.isInteger(t.cgstPaise) && Number.isInteger(t.sgstPaise));
            assert.ok(t.taxablePaise >= 0 && tax >= 0);
          }
        }
      }
    }
  });

  it('splits nothing into nothing', () => {
    const t = computeTax({ amountPaise: 0, rateBp: 1800, inclusive: true, intraState: true });
    assert.deepEqual(
      { ...t, rateBp: undefined },
      { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 0, rateBp: undefined },
    );
  });

  it('charges nothing at a zero rate', () => {
    const t = computeTax({ amountPaise: 50_000, rateBp: 0, inclusive: true, intraState: true });
    assert.equal(t.taxablePaise, 50_000);
    assert.equal(t.cgstPaise + t.sgstPaise + t.igstPaise, 0);
  });

  it('refuses fractional paise and impossible rates', () => {
    assert.throws(() => computeTax({ amountPaise: 1.5, rateBp: 1800, inclusive: true, intraState: true }));
    assert.throws(() => computeTax({ amountPaise: -1, rateBp: 1800, inclusive: true, intraState: true }));
    assert.throws(() => computeTax({ amountPaise: 100, rateBp: 10_001, inclusive: true, intraState: true }));
  });
});

describe('GSTIN', () => {
  const KARNATAKA = '29AABCU9603R1ZM';

  it('accepts a well-formed number and reads its state', () => {
    assert.equal(isValidGstin(KARNATAKA), true);
    assert.equal(stateCodeOfGstin(KARNATAKA), '29');
    assert.equal(stateCodeOfGstin(KARNATAKA.toLowerCase()), '29');
  });

  it('rejects anything the wrong shape rather than guessing a state', () => {
    for (const bad of ['', '29AABCU9603R1Z', 'AABCU9603R1ZM29', '99AABCU9603R1ZM ', 'not a gstin']) {
      assert.equal(isValidGstin(bad), false, `${bad} should not validate`);
      assert.equal(stateCodeOfGstin(bad), null);
    }
    assert.equal(stateCodeOfGstin(null), null);
    assert.equal(stateCodeOfGstin(undefined), null);
  });
});

describe('the financial year', () => {
  it('runs April to March', () => {
    assert.equal(financialYear(new Date('2026-04-01T00:00:00+05:30')), '2026-27');
    assert.equal(financialYear(new Date('2027-03-31T23:59:00+05:30')), '2026-27');
    assert.equal(financialYear(new Date('2027-04-01T00:00:00+05:30')), '2027-28');
  });

  it('turns over in the venue’s timezone, not UTC', () => {
    // 31 March 20:00 UTC is already 1 April in Kolkata, and the invoice series
    // that restarts is the venue's, not the server's.
    const boundary = new Date('2027-03-31T20:00:00Z');
    assert.equal(financialYear(boundary, 'Asia/Kolkata'), '2027-28');
    assert.equal(financialYear(boundary, 'UTC'), '2026-27');
  });
});

describe('the printed invoice number', () => {
  it('reads as a series a person can quote over the phone', () => {
    assert.equal(formatInvoiceNumber('SA', '2026-27', 1), 'SA/2026-27/0001');
  });

  it('stays inside the sixteen characters the format allows', () => {
    for (const [prefix, seq] of [['SMASH', 1], ['SA', 99_999], ['X', 123_456]] as const) {
      const number = formatInvoiceNumber(prefix, '2026-27', seq);
      assert.ok(number.length <= 16, `${number} is ${number.length} characters`);
      assert.match(number, /^[A-Z0-9/-]+$/);
    }
  });

  it('falls back to something usable when the prefix is unusable', () => {
    assert.equal(formatInvoiceNumber('', '2026-27', 7), 'INV/2026-27/0007');
    assert.equal(formatInvoiceNumber('!!', '2026-27', 7), 'INV/2026-27/0007');
  });
});
