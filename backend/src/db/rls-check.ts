import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from './tokens';

/**
 * Verifies at boot that row-level security can actually apply.
 *
 * A superuser, or a role with BYPASSRLS, ignores every policy silently: the
 * tables look protected, `\d` shows the policies, and tenant isolation is not
 * enforced at all. Nothing surfaces that until one venue sees another's
 * customers.
 *
 * In production this refuses to start. A service that will not boot is a much
 * smaller problem than one that boots and leaks.
 */
@Injectable()
export class RlsCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger('RLS');

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationBootstrap() {
    const { rows } = await this.pool.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);

    const role = rows[0];
    if (!role) return;

    if (!role.rolsuper && !role.rolbypassrls) {
      this.logger.log(`Row-level security active for role "${role.rolname}".`);
      return;
    }

    const why = role.rolsuper ? 'is a superuser' : 'has BYPASSRLS';
    const message =
      `Database role "${role.rolname}" ${why}, so row-level security is not enforced ` +
      `and tenants are not isolated at the database level. Grant the application a ` +
      `plain role that owns no bypass.`;

    if (process.env.NODE_ENV === 'production') {
      throw new Error(message);
    }
    this.logger.warn(`${message} (allowed outside production)`);
  }
}
