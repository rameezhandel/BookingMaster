import { sql } from 'drizzle-orm';
import type { Db } from '../db/database.module';
import { payments } from '../db/schema';

/**
 * Per-booking collected total: money in, less refunds.
 *
 * This is a joined aggregate rather than a correlated subquery on purpose. A
 * correlated `sql` fragment referencing ${reservations.id} renders the column
 * *unqualified*, which inside `FROM payment p` silently binds to payment's own
 * id and makes every total read as zero — wrong numbers, no error. Joining an
 * aliased subquery keeps the reference unambiguous, and aggregates once for the
 * whole result set instead of once per row.
 */
export function paidTotals(db: Db) {
  return db
    .select({
      reservationId: payments.reservationId,
      paidPaise: sql<string>`COALESCE(SUM(CASE WHEN ${payments.direction} = 'in' THEN ${payments.amountPaise} ELSE -${payments.amountPaise} END), 0)`.as(
        'paid_paise',
      ),
    })
    .from(payments)
    .groupBy(payments.reservationId)
    .as('paid_totals');
}

/** Postgres returns bigint sums as strings; money crosses into JS as a number here. */
export function toPaise(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}
