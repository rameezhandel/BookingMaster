/**
 * GST arithmetic, in integer paise.
 *
 * Every split here has to reconcile exactly: the tax components must sum to the
 * tax, and the tax plus the taxable value must equal the total, with no rupee
 * appearing or vanishing to rounding. An invoice that is off by one paisa is a
 * document an accountant will not accept, and the error is found a year later
 * during a return.
 *
 * **This implements the mechanics, not tax advice.** The rate and the SAC code
 * are the venue's to set with their accountant; nothing here decides what a
 * particular venue owes.
 */

/** Rates are basis points so 18% is 1800 and there is no float anywhere. */
export type BasisPoints = number;

export interface TaxBreakdown {
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  rateBp: BasisPoints;
}

export interface TaxInput {
  /** What the customer is charged, or what the charge is before tax. */
  amountPaise: number;
  rateBp: BasisPoints;
  /**
   * True when the price on the board already contains the tax, which is how a
   * counter in India nearly always quotes it: "₹500 for the hour" is what the
   * customer hands over, not ₹500 plus tax at the till.
   */
  inclusive: boolean;
  /**
   * Same state as the venue means the tax splits into central and state halves;
   * a different state means one integrated charge. For a sports facility the
   * place of supply is the venue itself, so this is nearly always true — but a
   * business customer registered elsewhere is the exception that makes it a
   * field rather than an assumption.
   */
  intraState: boolean;
}

export function computeTax({ amountPaise, rateBp, inclusive, intraState }: TaxInput): TaxBreakdown {
  if (!Number.isInteger(amountPaise) || amountPaise < 0) {
    throw new Error('Amount must be a whole number of paise, and not negative.');
  }
  if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 10_000) {
    throw new Error('Rate must be between 0 and 10000 basis points.');
  }

  let taxablePaise: number;
  let taxPaise: number;

  if (inclusive) {
    // Work backwards out of the gross amount. The taxable value is rounded and
    // the tax is the remainder, so the two always add back to exactly what the
    // customer paid — the opposite order would leave the total adrift.
    taxablePaise = Math.round((amountPaise * 10_000) / (10_000 + rateBp));
    taxPaise = amountPaise - taxablePaise;
  } else {
    taxablePaise = amountPaise;
    taxPaise = Math.round((amountPaise * rateBp) / 10_000);
  }

  // Halves that sum to the whole: the second component takes the odd paisa
  // rather than both rounding independently and losing or gaining one.
  const cgstPaise = intraState ? Math.floor(taxPaise / 2) : 0;
  const sgstPaise = intraState ? taxPaise - cgstPaise : 0;
  const igstPaise = intraState ? 0 : taxPaise;

  return {
    taxablePaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    totalPaise: taxablePaise + taxPaise,
    rateBp,
  };
}

/**
 * The state a GSTIN belongs to — its first two digits.
 *
 * Returns null for anything that is not the right shape, because a wrong state
 * silently turns a correct CGST/SGST split into a wrong IGST one.
 */
export function stateCodeOfGstin(gstin: string | null | undefined): string | null {
  if (!gstin) return null;
  const trimmed = gstin.trim().toUpperCase();
  return GSTIN_RE.test(trimmed) ? trimmed.slice(0, 2) : null;
}

/**
 * The published format: two state digits, a ten-character PAN, an entity digit,
 * the letter Z, and a checksum character.
 *
 * Shape only. It cannot tell you the number belongs to the person quoting it.
 */
export const GSTIN_RE = /^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function isValidGstin(gstin: string): boolean {
  return GSTIN_RE.test(gstin.trim().toUpperCase());
}

/**
 * The Indian financial year a date falls in, as "2026-27".
 *
 * April to March, which is why an invoice series restarts in April rather than
 * in January. Computed in the venue's timezone: a booking at 00:30 on 1 April
 * belongs to the new year in Kolkata and the old one in UTC.
 */
export function financialYear(date: Date, timeZone = 'Asia/Kolkata'): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(date);
  const year = Number(parts.find((p) => p.type === 'year')!.value);
  const month = Number(parts.find((p) => p.type === 'month')!.value);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * The invoice number as it is printed.
 *
 * Kept inside sixteen characters, which is the published limit, and restricted
 * to characters the format allows.
 */
export function formatInvoiceNumber(prefix: string, financialYearLabel: string, seq: number): string {
  const clean = prefix.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'INV';
  const number = `${clean}/${financialYearLabel}/${String(seq).padStart(4, '0')}`;
  if (number.length > 16) {
    // Only reachable with a long prefix and a five-digit sequence; drop the
    // padding before ever letting the number exceed the legal width.
    return `${clean}/${financialYearLabel}/${seq}`.slice(0, 16);
  }
  return number;
}
