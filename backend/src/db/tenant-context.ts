import { AsyncLocalStorage } from 'node:async_hooks';
import type { Tx } from './database.module';

export interface TenantContext {
  /** Empty for a system context, which spans tenants deliberately. */
  tenantId: string;
  /** The transaction the request runs in, which carries the RLS setting. */
  tx: Tx;
  requestId?: string;
  /**
   * Who is acting. A staff member has a row in app_user; a customer has only a
   * verified phone, and the audit trail records them differently.
   */
  actor?: { kind: 'staff'; id: string; label: string } | { kind: 'customer'; label: string };
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
