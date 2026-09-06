import { Global, Inject, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { tenantStorage } from './tenant-context';
import { RlsCheck } from './rls-check';

import { DB, PG_POOL } from './tokens';

export { DB, PG_POOL };
export type Db = NodePgDatabase<typeof schema>;

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const pool = new Pool({
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
          max: Number(config.get('DB_POOL_MAX') ?? 10),
          // Requests each hold a connection for their whole transaction, so a
          // stuck client must not hold one forever.
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 10_000,
        });

        pool.on('connect', (client) => {
          // A runaway query should fail rather than pin a connection until
          // something else notices. Well above any legitimate request here.
          void client.query(`SET statement_timeout = '15s'`);
          void client.query(`SET idle_in_transaction_session_timeout = '30s'`);
        });

        pool.on('error', (err) => {
          new Logger('Pool').error(`Idle client error: ${err.message}`);
        });

        return pool;
      },
    },
    RlsCheck,
    {
      provide: DB,
      inject: [PG_POOL],
      useFactory: (pool: Pool) => {
        const root = drizzle(pool, { schema });

        // Every query inside a request must run on the connection that carries
        // that request's `app.tenant_id`, or row-level security sees no tenant
        // and returns nothing. Rather than thread a transaction handle through
        // every service, `db` resolves to the ambient one when there is a
        // request in flight, and to the pool otherwise (migrations, jobs,
        // scripts).
        return new Proxy(root, {
          get(target, prop, receiver) {
            const active = (tenantStorage.getStore()?.tx as unknown as typeof target) ?? target;
            const value = Reflect.get(active as object, prop, active);
            return typeof value === 'function' ? value.bind(active) : value;
          },
        });
      },
    },
  ],
  exports: [DB, PG_POOL],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Release connections on shutdown so a restart does not leak them. */
  async onModuleDestroy() {
    await this.pool.end();
  }
}

// Transaction handle, so services can take either the pool or an open
// transaction and callers decide the boundary.
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbExecutor = Db | Tx;
