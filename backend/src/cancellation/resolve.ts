export interface CancellationTier {
  minHoursBefore: number;
  refundPct: number;
}

export interface RefundQuote {
  /** False when the venue has no policy at all, which is not the same as 0%. */
  configured: boolean;
  refundPct: number | null;
  refundPaise: number;
  hoursBefore: number;
  /** The tier that applied, for showing the owner why. */
  tier: CancellationTier | null;
  /** Set when the policy would give back more than was ever collected. */
  cappedByPaid: boolean;
}

/**
 * What a cancellation is worth back.
 *
 * The percentage applies to what was *billed*, but the payout is capped at what
 * was actually *collected*: a booking billed ₹900 with ₹200 paid cannot refund
 * ₹900 however generous the policy is. That cap is reported so the UI can
 * explain the number rather than just show a smaller one.
 *
 * Pure, because refunds are the part customers argue about.
 */
export function quoteRefund(
  tiers: CancellationTier[],
  hoursBefore: number,
  amountPaise: number,
  paidPaise: number,
): RefundQuote {
  if (tiers.length === 0) {
    return {
      configured: false,
      refundPct: null,
      refundPaise: 0,
      hoursBefore,
      tier: null,
      cappedByPaid: false,
    };
  }

  // The most generous threshold this cancellation still clears.
  const eligible = tiers
    .filter((t) => hoursBefore >= t.minHoursBefore)
    .sort((a, b) => b.minHoursBefore - a.minHoursBefore);

  const tier = eligible[0] ?? null;
  const refundPct = tier?.refundPct ?? 0;

  const byPolicy = Math.round((Math.max(amountPaise, 0) * refundPct) / 100);
  const collected = Math.max(paidPaise, 0);
  const refundPaise = Math.min(byPolicy, collected);

  return {
    configured: true,
    refundPct,
    refundPaise,
    hoursBefore,
    tier,
    cappedByPaid: byPolicy > collected,
  };
}

/** Whole hours between now and the booking start; negative once it has begun. */
export function hoursUntil(start: Date, now: Date): number {
  return Math.floor((start.getTime() - now.getTime()) / 3_600_000);
}
