import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, lt, type SQL } from 'drizzle-orm';
import { DB, type Db } from '../db/database.module';
import { auditEvents } from '../db/schema';
import { currentTenant } from '../db/tenant-context';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  data?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Records an action against the current request's tenant and actor.
   *
   * Runs on the ambient transaction, so the trail commits with the change it
   * describes: no audit entry for a booking that rolled back, and no silent
   * change without an entry.
   *
   * Never throws. An audit write failing is worth a log line, but it must not
   * turn a completed booking into a 500 for the owner standing at the desk.
   */
  async record(entry: AuditEntry): Promise<void> {
    const ctx = currentTenant();
    if (!ctx) return;

    try {
      await this.db.insert(auditEvents).values({
        tenantId: ctx.tenantId,
        actorUserId: ctx.actor?.id ?? null,
        actorEmail: ctx.actor?.email ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        summary: entry.summary,
        data: entry.data ?? null,
        requestId: ctx.requestId ?? null,
      });
    } catch (err) {
      this.logger.error(
        `Could not write audit entry ${entry.action}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  async list(tenantId: string, options: { limit?: number; before?: number; entityId?: string } = {}) {
    const filters: SQL[] = [eq(auditEvents.tenantId, tenantId)];
    if (options.before) filters.push(lt(auditEvents.id, options.before));
    if (options.entityId) filters.push(eq(auditEvents.entityId, options.entityId));

    const limit = Math.min(options.limit ?? 50, 200);
    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(and(...filters))
      .orderBy(desc(auditEvents.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }
}
