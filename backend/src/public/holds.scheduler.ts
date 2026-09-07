import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';
import { DB, type Db } from '../db/database.module';
import { runAsSystem } from '../db/run-as-tenant';
import { HoldsService } from './holds.service';
import { OtpService } from './otp/otp.service';

const SWEEP_LOCK = 4711_0002;

@Injectable()
export class HoldsScheduler {
  private readonly logger = new Logger(HoldsScheduler.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly holds: HoldsService,
    private readonly otp: OtpService,
  ) {}

  /**
   * Releases expired holds.
   *
   * This runs often because the sweeper is what turns a deadline into free
   * inventory. It is not the only line of defence, though: the exclusion
   * constraint cannot evaluate now(), so a booking that collides with an
   * expired-but-unswept hold sweeps that interval itself and retries. The timer
   * keeps the calendar honest; the retry keeps a customer from being told a
   * visibly free slot is taken.
   */
  @Interval(30_000)
  async sweep() {
    try {
      await runAsSystem(this.db, async () => {
        // A transaction-scoped lock, taken inside the transaction that does the
        // work: taking it in a separate transaction would release it before the
        // sweep even started.
        const held = await this.db.execute<{ locked: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(${SWEEP_LOCK}) AS locked`,
        );
        if (!held.rows[0]?.locked) return;

        const result = await this.holds.sweepExpired();
        if (result.released > 0 || result.keptWithPayments > 0) {
          this.logger.log(
            `Released ${result.released} expired hold(s)` +
              (result.keptWithPayments ? `, kept ${result.keptWithPayments} with payments` : ''),
          );
        }
      });
    } catch (err) {
      this.logger.error(`Hold sweep failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Spent verification codes are not worth keeping around. */
  @Interval(3_600_000)
  async purgeOtp() {
    try {
      await runAsSystem(this.db, () => this.otp.purgeExpired());
    } catch (err) {
      this.logger.error(`OTP purge failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
