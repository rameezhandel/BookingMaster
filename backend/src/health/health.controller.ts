import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Db } from '../db/database.module';

@Controller('health')
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Liveness: the process is up. Deliberately does not touch the database. */
  @Get()
  live() {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  /**
   * Readiness: the process can actually serve traffic. Load balancers should
   * poll this one, so an instance that has lost its database stops receiving
   * requests instead of failing them.
   */
  @Get('ready')
  async ready() {
    try {
      await this.db.execute(sql`SELECT 1`);
    } catch {
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'NotReady',
        message: 'Database is unreachable.',
      });
    }
    return { status: 'ready' };
  }
}
