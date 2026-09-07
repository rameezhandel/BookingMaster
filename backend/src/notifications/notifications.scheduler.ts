import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';
import { DB, type Db } from '../db/database.module';
import { runAsSystem } from '../db/run-as-tenant';
import { NotificationsService } from './notifications.service';

const DELIVER_LOCK = 4711_0003;
const REMIND_LOCK = 4711_0004;

@Injectable()
export class NotificationsScheduler {
  private readonly logger = new Logger(NotificationsScheduler.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Drains the outbox.
   *
   * Frequent, because a booking confirmation that arrives ten minutes late is
   * not a confirmation. The advisory lock is transaction-scoped and taken
   * inside the transaction doing the work, so several replicas do not send the
   * same messages — the per-row claim below it is the real guarantee, but this
   * stops them fighting over the same rows every ten seconds.
   */
  @Interval(10_000)
  async deliver() {
    try {
      await runAsSystem(this.db, async () => {
        const held = await this.db.execute<{ locked: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(${DELIVER_LOCK}) AS locked`,
        );
        if (!held.rows[0]?.locked) return;

        const result = await this.notifications.deliverDue();
        if (result.sent || result.failed || result.retrying) {
          this.logger.log(
            `Messages: ${result.sent} sent, ${result.retrying} retrying, ${result.failed} failed.`,
          );
        }
      });
    } catch (err) {
      this.logger.error(`Delivery run failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Queues reminders for bookings coming up inside each venue's window. */
  @Interval(300_000)
  async queueReminders() {
    try {
      await runAsSystem(this.db, async () => {
        const held = await this.db.execute<{ locked: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(${REMIND_LOCK}) AS locked`,
        );
        if (!held.rows[0]?.locked) return;
        await this.notifications.queueDueReminders();
      });
    } catch (err) {
      this.logger.error(`Reminder run failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async purge() {
    try {
      await runAsSystem(this.db, async () => {
        const removed = await this.notifications.purgeOld();
        if (removed) this.logger.log(`Purged ${removed} old message records.`);
      });
    } catch (err) {
      this.logger.error(`Purge failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
