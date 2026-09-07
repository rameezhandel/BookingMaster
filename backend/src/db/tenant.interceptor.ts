import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Observable, from, lastValueFrom } from 'rxjs';
import { DB, type Db } from './database.module';
import { tenantStorage } from './tenant-context';
import type { AuthUser } from '../common/current-user.decorator';
import { maskPhone } from '../public/otp/sender';

/**
 * Runs each authenticated request inside one transaction with `app.tenant_id`
 * set, which is what makes the row-level security policies apply.
 *
 * A whole request in a transaction also means a handler that fails partway
 * leaves nothing behind — a booking without its customer, a cancellation
 * without its refund. The cost is one pooled connection held for the request,
 * which is the right trade for an admin console.
 *
 * Unauthenticated routes (login, health) run outside it and touch only tables
 * that are not tenant-scoped.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(@Inject(DB) private readonly db: Db) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const user = request.user as (AuthUser & { phone?: string }) | undefined;

    if (!user?.tenantId) return next.handle();

    // A customer session has a phone rather than an email and no app_user row.
    const actor = user.email
      ? ({ kind: 'staff', id: user.id, label: user.email } as const)
      : ({ kind: 'customer', label: maskPhone(user.phone ?? '') } as const);

    return from(
      this.db.transaction(async (tx) => {
        // `true` scopes the setting to this transaction, so a pooled connection
        // never carries one tenant's id into the next request.
        await tx.execute(sql`SELECT set_config('app.tenant_id', ${user.tenantId}, true)`);

        return tenantStorage.run(
          {
            tenantId: user.tenantId,
            tx,
            requestId: request.id,
            actor,
          },
          () => lastValueFrom(next.handle()),
        );
      }),
    );
  }
}
