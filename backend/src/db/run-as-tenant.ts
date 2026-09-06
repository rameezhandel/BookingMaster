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
