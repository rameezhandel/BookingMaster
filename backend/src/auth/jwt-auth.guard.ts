import {
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { and, eq } from 'drizzle-orm';
import { DB, type Db } from '../db/database.module';
import { runAsTenant } from '../db/run-as-tenant';
import { users } from '../db/schema';
import type { AuthUser } from '../common/current-user.decorator';
import { ROLES_KEY } from './roles.guard';

/**
 * The gate on every staff route: a valid token, an account that still exists
 * and is still active, and the role the route requires.
 *
 * All three live here rather than in separate guards because this guard is
 * already on every authenticated controller. A separate guard is a guard
 * somebody forgets to add to the route they wrote on a Friday, and the hole
 * that leaves is invisible until it is exploited.
 *
 * **The token is not trusted about role or status.** It carries both, but a
 * JWT is a snapshot: deactivating someone who has just left, or demoting them,
 * would otherwise do nothing until their token expired hours later. "Their
 * access is revoked, give or take a few hours" is not revoked. So the row is
 * read on each request — one primary-key lookup, which is the right price for
 * being able to lock someone out and mean it.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DB) private readonly db: Db,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const authenticated = (await super.canActivate(context)) as boolean;
    if (!authenticated) return false;

    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthUser;

    // The tenant comes from the signed token, so this reads under that tenant's
    // own row-level security rather than bypassing it.
    const fresh = await runAsTenant(this.db, user.tenantId, async () => {
      const [row] = await this.db
        .select({ role: users.role, isActive: users.isActive })
        .from(users)
        .where(and(eq(users.id, user.id), eq(users.tenantId, user.tenantId)))
        .limit(1);
      return row;
    });

    if (!fresh || !fresh.isActive) {
      throw new UnauthorizedException('This login is no longer active.');
    }

    // Whatever the token says, the database is the authority.
    user.role = fresh.role;

    const required = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required?.length && !required.includes(user.role)) {
      throw new ForbiddenException('Only an account owner can do that.');
    }

    return true;
  }
}
