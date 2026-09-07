import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { DB, type Db } from '../../db/database.module';
import { otpChallenges } from '../../db/schema';
import { normalisePhone } from '../../customers/dto';
import { TooManyRequestsError } from '../../common/errors';
import { OTP_SENDER, maskPhone, type OtpSender } from './sender';

const CODE_LENGTH = 6;
const CODE_TTL_MINUTES = 5;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 30;

/** Codes are compared as hashes, never stored or logged in the clear. */
function hashCode(code: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

@Injectable()
export class OtpService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OTP_SENDER) private readonly sender: OtpSender,
  ) {}

  /**
   * Issues a code for a phone number.
   *
   * The response never reveals whether the number is already a customer:
   * "we've sent a code" is the answer either way, so the endpoint cannot be
   * used to enumerate a venue's customer list.
   */
  async request(tenantId: string, venueId: string, rawPhone: string) {
    const phone = normalisePhone(rawPhone);
    if (!/^\+?[0-9]{7,15}$/.test(phone)) {
      throw new BadRequestException('Enter a valid phone number.');
    }

    const [recent] = await this.db
      .select({ createdAt: otpChallenges.createdAt })
      .from(otpChallenges)
      .where(and(eq(otpChallenges.venueId, venueId), eq(otpChallenges.phone, phone)))
      .orderBy(desc(otpChallenges.createdAt))
      .limit(1);

    if (recent) {
      const since = (Date.now() - recent.createdAt.getTime()) / 1000;
      if (since < RESEND_COOLDOWN_SECONDS) {
        throw new TooManyRequestsError(
          `Wait ${Math.ceil(RESEND_COOLDOWN_SECONDS - since)} seconds before asking for another code.`,
        );
      }
    }

    // randomInt is drawn from the CSPRNG; Math.random would make codes guessable.
    const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000);

    const [challenge] = await this.db
      .insert(otpChallenges)
      .values({ tenantId, venueId, phone, codeHash: hashCode(code, phone), expiresAt })
      .returning({ id: otpChallenges.id });

    await this.sender.send(phone, code);

    return {
      challengeId: challenge.id,
      phone: maskPhone(phone),
      expiresInSeconds: CODE_TTL_MINUTES * 60,
    };
  }

  /**
   * Checks a code and returns the verified phone number.
   *
   * Attempts are counted on the challenge itself rather than on the phone, so
   * an attacker cannot reset their budget by asking for a fresh code — the
   * resend cooldown governs that separately.
   */
  async verify(venueId: string, challengeId: string, code: string): Promise<string> {
    const [challenge] = await this.db
      .select()
      .from(otpChallenges)
      .where(
        and(
          eq(otpChallenges.id, challengeId),
          eq(otpChallenges.venueId, venueId),
          gt(otpChallenges.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (!challenge || challenge.consumedAt) {
      throw new BadRequestException('That code has expired. Ask for a new one.');
    }
    if (challenge.attempts >= MAX_ATTEMPTS) {
      throw new TooManyRequestsError('Too many wrong codes. Ask for a new one.');
    }

    // Count the attempt before checking it, so a crash mid-verify cannot be
    // used to get unlimited free guesses.
    await this.db
      .update(otpChallenges)
      .set({ attempts: sql`${otpChallenges.attempts} + 1` })
      .where(eq(otpChallenges.id, challengeId));

    const expected = Buffer.from(challenge.codeHash, 'hex');
    const actual = Buffer.from(hashCode(code, challenge.phone), 'hex');
    const ok = expected.length === actual.length && timingSafeEqual(expected, actual);

    if (!ok) throw new BadRequestException('That code is not right.');

    await this.db
      .update(otpChallenges)
      .set({ consumedAt: new Date() })
      .where(eq(otpChallenges.id, challengeId));

    return challenge.phone;
  }

  /** Housekeeping: spent and expired challenges are not worth keeping. */
  async purgeExpired() {
    const removed = await this.db
      .delete(otpChallenges)
      .where(sql`${otpChallenges.expiresAt} < now() - interval '1 day'`)
      .returning({ id: otpChallenges.id });
    return removed.length;
  }
}
