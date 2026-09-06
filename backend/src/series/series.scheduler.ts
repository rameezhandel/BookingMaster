import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';
import { DB, type Db } from '../db/database.module';
import { SeriesService } from './series.service';

/**
 * An arbitrary but fixed key. Postgres advisory locks are per-database, so this
 * only has to be unique within this application.
 */
const EXTEND_SERIES_LOCK = 4711_0001;

@Injectable()
export class SeriesScheduler {
  private readonly logger = new Logger(SeriesScheduler.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly series: SeriesService,
  ) {}

  /**
   * Rolls every active series forward so a weekly group never runs out of
   * bookings.
   *
   * Guarded by a Postgres advisory lock rather than assuming one instance:
   * with several replicas this would otherwise run concurrently, and while the
   * unique index on (series, date) makes that safe, it would still burn work
   * and log a pile of spurious conflicts.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async extendActiveSeries() {
    const locked = await this.db.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_lock(${EXTEND_SERIES_LOCK}) AS locked`,
    );
    if (!locked.rows[0]?.locked) {
      this.logger.log('Another instance is extending series; skipping.');
      return;
    }

    try {
      const result = await this.series.materialiseAllActive();
      if (result.created > 0 || result.skipped > 0) {
        this.logger.log(
          `Extended ${result.series} series: ${result.created} booked, ${result.skipped} could not be.`,
        );
      }
    } finally {
      await this.db.execute(sql`SELECT pg_advisory_unlock(${EXTEND_SERIES_LOCK})`);
    }
  }
}
