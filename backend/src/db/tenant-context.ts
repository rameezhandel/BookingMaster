import { AsyncLocalStorage } from 'node:async_hooks';
import type { Tx } from './database.module';

export interface TenantContext {
  tenantId: string;
  /** The transaction the request runs in, which carries the RLS setting. */
  tx: Tx;
  requestId?: string;
  actor?: { id: string; email: string };
}

/**
 * The tenant a request belongs to, and the transaction carrying its RLS
 * setting.
 *
 * AsyncLocalStorage rather than a request-scoped provider: services keep taking
 * a plain injected `db`, and the transaction follows the request through every
 * await without threading a parameter through every call site.
 */
export const tenantStorage = new AsyncLocalStorage<TenantContext>();

export const currentTenant = (): TenantContext | undefined => tenantStorage.getStore();
