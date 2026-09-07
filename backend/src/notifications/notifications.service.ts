import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, lt, lte, or, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DB, type Db } from '../db/database.module';
import { customers, notifications, reservations, resources, venues } from '../db/schema';
import { PG_UNIQUE_VIOLATION } from '../common/errors';
import { formatPaise } from '../common/money';
import { NOTIFICATION_CHANNEL, type NotificationChannel } from './channels/channel';
import { TEMPLATES, render, type TemplateKey } from './templates';

/** Roughly 1, 5, 25 minutes, then give up. */
const BACKOFF_MINUTES = [1, 5, 25];
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(NOTIFICATION_CHANNEL) private readonly channel: NotificationChannel,
  ) {}

  /**
   * Queues a message about a booking.
   *
   * Runs on the caller's transaction, so the message and the booking it
   * describes commit together or not at all. Nothing is sent here — the worker
   * does that afterwards, off the request path.
   *
   * Never throws. A notification that cannot be queued must not fail the
   * booking; the customer being at the desk matters more than the message.
   */
  async enqueue(input: {
    tenantId: string;
    reservationId: string;
    templateKey: TemplateKey;
    /** Distinguishes messages about the same booking. */
    dedupeSuffix?: string;
    extra?: string;
  }): Promise<void> {
    try {
      const context = await this.contextFor(input.tenantId, input.reservationId);
      if (!context) return;

      const { params, preview } = render(input.templateKey, {
        ...context.ctx,
        extra: input.extra,
      });

      const dedupeKey = [input.reservationId, input.templateKey, input.dedupeSuffix]
        .filter(Boolean)
        .join(':');

      // The unique index does the deduplication. Insert-and-catch rather than
      // check-then-insert, which would race two webhook retries against each
      // other and send twice.
      await this.db.transaction(async (tx) => {
        try {
          await tx.insert(notifications).values({
            tenantId: input.tenantId,
            venueId: context.venueId,
            customerId: context.customerId,
            reservationId: input.reservationId,
            channel: 'whatsapp',
            template: TEMPLATES[input.templateKey].name,
            params,
            preview,
            toPhone: context.phone,
            dedupeKey,
          });
        } catch (err) {
          if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) return;
          throw err;
        }
      });
    } catch (err) {
      this.logger.error(
        `Could not queue ${input.templateKey} for booking ${input.reservationId}: ` +
          `${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Everything needed to render a message, or null when there is no one to
   * message.
   *
   * Three reasons to say nothing, all checked here rather than at each call
   * site so none of them can be forgotten: the venue has messaging turned off,
   * the customer asked not to be messaged, or there is no phone number.
   */
  private async contextFor(tenantId: string, reservationId: string) {
    const [row] = await this.db
      .select({
        venueId: venues.id,
        venueName: venues.name,
        timezone: venues.timezone,
        notificationsEnabled: venues.notificationsEnabled,
        courtName: resources.name,
        during: reservations.during,
        amountPaise: reservations.amountPaise,
        customerId: customers.id,
        customerName: customers.name,
        phone: customers.phone,
        optedOut: customers.notificationsOptedOut,
      })
      .from(reservations)
      .innerJoin(venues, eq(venues.id, reservations.venueId))
      .innerJoin(resources, eq(resources.id, reservations.resourceId))
      .leftJoin(customers, eq(customers.id, reservations.customerId))
      .where(and(eq(reservations.tenantId, tenantId), eq(reservations.id, reservationId)))
      .limit(1);

    if (!row) return null;
    if (!row.notificationsEnabled) return null;
    if (!row.customerId || !row.phone) return null;
    if (row.optedOut) return null;

    const start = DateTime.fromJSDate(row.during.start, { zone: row.timezone });
    const end = DateTime.fromJSDate(row.during.end, { zone: row.timezone });

    return {
      venueId: row.venueId,
      customerId: row.customerId,
      phone: row.phone,
      ctx: {
        customerName: firstName(row.customerName ?? '') || 'there',
        venueName: row.venueName,
        courtName: row.courtName,
        when: `${start.toFormat('ccc d LLL, HH:mm')}–${end.toFormat('HH:mm')}`,
        amount: formatPaise(Number(row.amountPaise)),
      },
    };
  }

  // ------------------------------------------------------------- sending --

  /**
   * Sends what is due.
   *
   * Rows are claimed with a conditional UPDATE before the provider is called,
   * so two workers cannot pick up the same message. Claiming after sending, or
   * not at all, is how customers get told twice.
   */
  async deliverDue(limit = 25): Promise<{ sent: number; failed: number; retrying: number }> {
    const due = await this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.status, 'pending'), lte(notifications.nextAttemptAt, new Date())))
      .orderBy(asc(notifications.nextAttemptAt))
      .limit(limit);

    let sent = 0;
    let failed = 0;
    let retrying = 0;

    for (const row of due) {
      // Claim it: only one worker can move a row past this point.
      const claimed = await this.db
        .update(notifications)
        .set({ attempts: row.attempts + 1 })
        .where(and(eq(notifications.id, row.id), eq(notifications.attempts, row.attempts)))
        .returning({ id: notifications.id });
      if (claimed.length === 0) continue;

      const templateKey = Object.keys(TEMPLATES).find(
        (k) => TEMPLATES[k as TemplateKey].name === row.template,
      ) as TemplateKey | undefined;

      if (!templateKey) {
        await this.markFailed(row.id, `Unknown template "${row.template}"`);
        failed++;
        continue;
      }

      const outcome = await this.channel.send({
        toPhone: row.toPhone,
        templateKey,
        templateName: TEMPLATES[templateKey].name,
        language: TEMPLATES[templateKey].language,
        params: (row.params as string[]) ?? [],
        preview: row.preview,
      });

      if (outcome.ok) {
        await this.db
          .update(notifications)
          .set({
            status: 'sent',
            sentAt: new Date(),
            provider: this.channel.name,
            providerMessageId: outcome.providerMessageId,
            error: null,
          })
          .where(eq(notifications.id, row.id));
        sent++;
        continue;
      }

      const attempts = row.attempts + 1;
      if (!outcome.retryable || attempts >= MAX_ATTEMPTS) {
        await this.markFailed(row.id, outcome.error);
        failed++;
        continue;
      }

      const waitMinutes = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
      await this.db
        .update(notifications)
        .set({
          nextAttemptAt: new Date(Date.now() + waitMinutes * 60_000),
          error: outcome.error,
        })
        .where(eq(notifications.id, row.id));
      retrying++;
    }

    return { sent, failed, retrying };
  }

  private async markFailed(id: string, error: string) {
    await this.db
      .update(notifications)
      .set({ status: 'failed', error, provider: this.channel.name })
      .where(eq(notifications.id, id));
  }

  /**
   * Queues reminders for bookings starting soon.
   *
   * The dedupe key carries the reservation and the template, so a reminder is
   * queued once however often this runs.
   */
  async queueDueReminders(): Promise<number> {
    const upcoming = await this.db
      .select({
        id: reservations.id,
        tenantId: reservations.tenantId,
      })
      .from(reservations)
      .innerJoin(venues, eq(venues.id, reservations.venueId))
      .where(
        and(
          eq(reservations.status, 'confirmed'),
          eq(venues.notificationsEnabled, true),
          sql`${venues.reminderHoursBefore} > 0`,
          // Starting inside the venue's reminder window, and not yet started.
          sql`lower(${reservations.during}) > now()`,
          sql`lower(${reservations.during}) <= now() + make_interval(hours => ${venues.reminderHoursBefore})`,
        ),
      )
      .limit(200);

    for (const booking of upcoming) {
      await this.enqueue({
        tenantId: booking.tenantId,
        reservationId: booking.id,
        templateKey: 'booking_reminder',
      });
    }
    return upcoming.length;
  }

  // ------------------------------------------------------------ reading --

  /** The owner's message log for a venue. */
  async list(tenantId: string, venueId: string, limit = 50) {
    return this.db
      .select({
        id: notifications.id,
        template: notifications.template,
        preview: notifications.preview,
        toPhone: notifications.toPhone,
        status: notifications.status,
        attempts: notifications.attempts,
        error: notifications.error,
        provider: notifications.provider,
        createdAt: notifications.createdAt,
        sentAt: notifications.sentAt,
        customerName: customers.name,
      })
      .from(notifications)
      .leftJoin(customers, eq(customers.id, notifications.customerId))
      .where(and(eq(notifications.tenantId, tenantId), eq(notifications.venueId, venueId)))
      .orderBy(desc(notifications.createdAt))
      .limit(Math.min(limit, 200));
  }

  /** Housekeeping: delivered messages older than a quarter are not worth keeping. */
  async purgeOld(): Promise<number> {
    const removed = await this.db
      .delete(notifications)
      .where(
        and(
          or(eq(notifications.status, 'sent'), eq(notifications.status, 'delivered')),
          lt(notifications.createdAt, DateTime.now().minus({ days: 90 }).toJSDate()),
        ),
      )
      .returning({ id: notifications.id });
    return removed.length;
  }
}

/** "Hi Arjun" reads better than "Hi Arjun Nair" in a message. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}
