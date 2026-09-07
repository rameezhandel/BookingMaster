import { sql } from 'drizzle-orm';
import type { Db } from './database.module';
import { tenantStorage } from './tenant-context';

/**
 * Runs work for one tenant outside a request — background jobs, mainly.
 *
 * Jobs cross tenants, so rather than bypassing row-level security wholesale
 * they adopt each tenant in turn and stay subject to the same policies as a
 * request would be.
 */
export async function runAsTenant<T>(db: Db, tenantId: string, fn: () => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return tenantStorage.run({ tenantId, tx }, fn);
  });
}

/**
 * Runs work that legitimately spans tenants — the hold sweeper, housekeeping —
 * with row-level security bypassed for the duration.
 *
 * The transaction has to be put into AsyncLocalStorage, not merely opened.
 * `db` resolves to the ambient transaction or, failing that, to the pool: a
 * bypass set on a transaction that the service never actually uses does
 * nothing, and the job silently sees zero rows. That is exactly how the hold
 * sweeper first failed — no error, no log line, just holds that never expired.
 */
export async function runAsSystem<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.bypass_rls', 'on', true)`);
    return tenantStorage.run({ tenantId: '', tx }, fn);
  });
}
