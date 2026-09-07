import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/database.module';
import { runAsSystem, runAsTenant } from '../db/run-as-tenant';
import {
  gatewayEvents,
  paymentIntents,
  payments,
  reservations,
  venues,
} from '../db/schema';
import { PG_EXCLUSION_VIOLATION, PG_UNIQUE_VIOLATION } from '../common/errors';
import { formatPaise } from '../common/money';
import { AuditService } from '../audit/audit.service';
import { PAYMENT_GATEWAY, type GatewayEvent, type PaymentGateway } from './gateway/gateway';

export type WebhookOutcome =
  | 'processed'
  | 'duplicate'
  | 'ignored'
  | 'unmatched'
  | 'refunded-late'
  | 'failed';

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly audit: AuditService,
  ) {}

  /**
   * Starts a payment for a held slot.
   *
   * The intent is written before the order is created at the gateway, so an
   * order we never hear about again still has a local record. The opposite
   * order would leave money collectable against nothing.
   */
  async startPayment(tenantId: string, holdId: string, customerId: string) {
    if (!this.gateway.configured) {
      throw new ServiceUnavailableException('Online payment is not set up for this venue.');
    }

    const [hold] = await this.db
      .select()
      .from(reservations)
      .where(and(eq(reservations.tenantId, tenantId), eq(reservations.id, holdId)))
      .limit(1);

    if (!hold || hold.customerId !== customerId) throw new NotFoundException('No such booking.');
    if (hold.status !== 'held') throw new ConflictException('That booking is no longer held.');
    if (hold.expiresAt && hold.expiresAt < new Date()) {
      throw new ConflictException('That hold has expired. Please pick the slot again.');
    }

    const amountPaise = Number(hold.amountPaise);
    if (amountPaise <= 0) throw new ConflictException('That slot has no price to pay.');

    const order = await this.gateway.createOrder({
      amountPaise,
      currency: 'INR',
      receipt: hold.id,
      notes: { reservationId: hold.id },
    });

    const [intent] = await this.db
      .insert(paymentIntents)
      .values({
        tenantId,
        venueId: hold.venueId,
        reservationId: hold.id,
        gateway: this.gateway.name,
        gatewayOrderId: order.orderId,
        amountPaise,
        currency: order.currency,
      })
      .returning();

    await this.audit.record({
      action: 'payment.started',
      entityType: 'reservation',
      entityId: hold.id,
      summary: `Started online payment of ${formatPaise(amountPaise)}`,
      data: { gateway: this.gateway.name, orderId: order.orderId },
    });

    return {
      intentId: intent.id,
      orderId: order.orderId,
      amountPaise,
      currency: order.currency,
      gateway: this.gateway.name,
      publicKey: this.gateway.publicKey,
      expiresAt: hold.expiresAt?.toISOString() ?? null,
    };
  }

  /**
   * Handles a webhook. This, not the browser, decides that money arrived.
   *
   * The signature is checked against the raw bytes before anything is parsed or
   * stored. Then the event is recorded, and the unique key on (gateway,
   * event_id) is what makes retries safe: gateways retry on timeouts and on any
   * non-2xx, and without that a retry would confirm a booking twice and record
   * the money twice.
   */
  async handleWebhook(rawBody: Buffer, signature: string, headerEventId?: string): Promise<WebhookOutcome> {
    if (!this.gateway.verifyWebhook(rawBody, signature)) {
      // Deliberately terse: an attacker probing signatures learns nothing.
      this.logger.warn('Rejected a webhook with an invalid signature.');
      throw new NotFoundException();
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      this.logger.warn('Rejected a webhook with an unparseable body.');
      throw new NotFoundException();
    }

    const event = this.gateway.parseEvent(payload);
    if (!event) return 'ignored';
    const eventId = headerEventId || event.eventId;

    // Record first, act second. An event we cannot process is still evidence.
    const stored = await runAsSystem(this.db, async () => {
      try {
        const [row] = await this.db
          .insert(gatewayEvents)
          .values({
            gateway: this.gateway.name,
            eventId,
            eventType: event.rawType,
            payload: payload as Record<string, unknown>,
          })
          .returning({ id: gatewayEvents.id });
        return row;
      } catch (err) {
        if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) return null;
        throw err;
      }
    });

    if (!stored) {
      this.logger.log(`Ignoring a repeat of gateway event ${eventId}.`);
      return 'duplicate';
    }

    if (event.kind === 'other') {
      await this.markProcessed(stored.id, null);
      return 'ignored';
    }

    try {
      const outcome = await this.apply(event);
      await this.markProcessed(stored.id, null);
      return outcome;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.markProcessed(stored.id, message);
      this.logger.error(`Failed to apply gateway event ${eventId}: ${message}`);
      // Rethrow so the gateway retries; the event row records the attempt and
      // the unique key still stops a double-apply if the failure was partial.
      throw err;
    }
  }

  private async apply(event: GatewayEvent): Promise<WebhookOutcome> {
    if (event.kind === 'other') return 'ignored';
    if (!event.orderId) return 'unmatched';

    const intent = await runAsSystem(this.db, async () => {
      const [row] = await this.db
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.gateway, this.gateway.name),
            eq(paymentIntents.gatewayOrderId, event.orderId!),
          ),
        )
        .limit(1);
      return row;
    });

    if (!intent) {
      this.logger.warn(`Gateway event referenced unknown order ${event.orderId}.`);
      return 'unmatched';
    }

    if (event.kind === 'payment.failed') {
      await runAsTenant(this.db, intent.tenantId, async () => {
        await this.db
          .update(paymentIntents)
          .set({ status: 'failed', gatewayPaymentId: event.paymentId })
          .where(eq(paymentIntents.id, intent.id));
      });
      return 'failed';
    }

    // Never trust an amount that came through the browser; compare against what
    // we asked the gateway for.
    if (event.amountPaise !== null) {
      const paid = Number(event.amountPaise);
      const expected = Number(intent.amountPaise);

      // A short payment is not a paid booking. Send it back rather than
      // confirming a court for less than it costs.
      if (paid < expected) {
        this.logger.error(`Order ${event.orderId} paid ${paid} against ${expected} expected.`);
        await this.refundLate(intent, event.paymentId, 'Amount did not match the booking');
        return 'refunded-late';
      }

      // An overpayment still confirms — refusing the booking would be worse for
      // the customer — but it must not pass unnoticed, because the difference
      // is owed back and only a person can decide how.
      if (paid > expected) {
        this.logger.warn(
          `Order ${event.orderId} paid ${paid} against ${expected} expected; ` +
            `${formatPaise(paid - expected)} is owed back to the customer.`,
        );
      }
    }

    return runAsTenant(this.db, intent.tenantId, async () => {
      if (intent.status === 'paid') return 'duplicate' as const;

      const [reservation] = intent.reservationId
        ? await this.db
            .select()
            .from(reservations)
            .where(eq(reservations.id, intent.reservationId))
            .limit(1)
        : [];

      // The hold expired and was swept, or the slot went to someone else while
      // the customer was on the payment page. The money has to go back; leaving
      // it is the one outcome nobody forgives.
      if (!reservation || reservation.status === 'cancelled') {
        await this.refundLate(intent, event.paymentId, 'The slot was no longer held');
        return 'refunded-late' as const;
      }

      try {
        await this.db
          .update(reservations)
          .set({ status: 'confirmed', expiresAt: null })
          .where(and(eq(reservations.id, reservation.id), eq(reservations.status, 'held')));
      } catch (err) {
        if ((err as { code?: string }).code === PG_EXCLUSION_VIOLATION) {
          await this.refundLate(intent, event.paymentId, 'The slot had been taken');
          return 'refunded-late' as const;
        }
        throw err;
      }

      await this.db.insert(payments).values({
        tenantId: intent.tenantId,
        reservationId: reservation.id,
        paymentIntentId: intent.id,
        amountPaise: Number(intent.amountPaise),
        direction: 'in',
        method: 'upi',
        reference: event.paymentId,
        note: `Paid online via ${this.gateway.name}`,
      });

      await this.db
        .update(paymentIntents)
        .set({ status: 'paid', gatewayPaymentId: event.paymentId })
        .where(eq(paymentIntents.id, intent.id));

      const overpaidPaise =
        event.amountPaise !== null ? Number(event.amountPaise) - Number(intent.amountPaise) : 0;

      await this.audit.record({
        action: 'payment.recorded',
        entityType: 'reservation',
        entityId: reservation.id,
        summary:
          overpaidPaise > 0
            ? `Paid ${formatPaise(Number(intent.amountPaise))} online, overpaid by ${formatPaise(overpaidPaise)}`
            : `Paid ${formatPaise(Number(intent.amountPaise))} online`,
        data: {
          gateway: this.gateway.name,
          paymentId: event.paymentId,
          ...(overpaidPaise > 0 ? { overpaidPaise } : {}),
        },
      });

      return 'processed' as const;
    });
  }

  /**
   * Sends money back for a payment that arrived too late to honour.
   *
   * A refund failing here is the worst case in the whole system — the customer
   * has paid for nothing — so it is logged at error level with everything
   * needed to do it by hand, and the intent keeps the reason.
   */
  private async refundLate(
    intent: { id: string; tenantId: string; amountPaise: number; gatewayOrderId: string },
    gatewayPaymentId: string | null,
    reason: string,
  ) {
    const amountPaise = Number(intent.amountPaise);

    if (!gatewayPaymentId) {
      this.logger.error(
        `Cannot refund order ${intent.gatewayOrderId}: the event carried no payment id. ` +
          `${formatPaise(amountPaise)} needs refunding by hand.`,
      );
    } else {
      try {
        await this.gateway.refund(gatewayPaymentId, amountPaise, reason);
        this.logger.warn(
          `Refunded ${formatPaise(amountPaise)} for order ${intent.gatewayOrderId}: ${reason}`,
        );
      } catch (err) {
        this.logger.error(
          `REFUND FAILED for payment ${gatewayPaymentId} (order ${intent.gatewayOrderId}, ` +
            `${formatPaise(amountPaise)}): ${err instanceof Error ? err.message : err}. ` +
            `This must be refunded by hand.`,
        );
      }
    }

    await runAsSystem(this.db, async () => {
      await this.db
        .update(paymentIntents)
        .set({ status: 'refunded', gatewayPaymentId, refundReason: reason })
        .where(eq(paymentIntents.id, intent.id));
    });
  }

  private async markProcessed(eventRowId: number, error: string | null) {
    await runAsSystem(this.db, async () => {
      await this.db
        .update(gatewayEvents)
        .set({ processedAt: new Date(), error })
        .where(eq(gatewayEvents.id, eventRowId));
    });
  }

  /** Lets the browser poll for the outcome instead of trusting its own callback. */
  async statusFor(tenantId: string, holdId: string, customerId: string) {
    const [row] = await this.db
      .select({
        reservationStatus: reservations.status,
        intentStatus: paymentIntents.status,
        amountPaise: paymentIntents.amountPaise,
        refundReason: paymentIntents.refundReason,
        customerId: reservations.customerId,
      })
      .from(reservations)
      .leftJoin(paymentIntents, eq(paymentIntents.reservationId, reservations.id))
      .where(and(eq(reservations.tenantId, tenantId), eq(reservations.id, holdId)))
      .orderBy(sql`${paymentIntents.createdAt} DESC NULLS LAST`)
      .limit(1);

    if (!row || row.customerId !== customerId) throw new NotFoundException('No such booking.');

    return {
      bookingStatus: row.reservationStatus,
      paymentStatus: row.intentStatus,
      amountPaise: row.amountPaise ? Number(row.amountPaise) : null,
      refundReason: row.refundReason,
    };
  }

  /**
   * Sends money back for a cancelled booking that was paid through the gateway.
   *
   * Returns whether the refund actually left, because the caller must not tell
   * a customer they have been refunded when they have not. A failure here is
   * money the venue still owes, so it is logged with everything needed to
   * settle it by hand.
   */
  async refundForCancellation(
    tenantId: string,
    reservationId: string,
    amountPaise: number,
    reason: string,
  ): Promise<{ issued: boolean; detail: string }> {
    if (amountPaise <= 0) return { issued: false, detail: 'Nothing to refund.' };

    const [intent] = await this.db
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, tenantId),
          eq(paymentIntents.reservationId, reservationId),
          eq(paymentIntents.status, 'paid'),
        ),
      )
      .limit(1);

    // Paid in cash at the counter, or not paid at all: there is nothing for the
    // gateway to send back, and the venue settles it in person.
    if (!intent?.gatewayPaymentId) {
      return { issued: false, detail: 'Collect this refund from the venue.' };
    }
    if (intent.gateway !== this.gateway.name) {
      this.logger.warn(
        `Booking ${reservationId} was paid via ${intent.gateway} but ${this.gateway.name} is active; ` +
          `${formatPaise(amountPaise)} must be refunded by hand.`,
      );
      return { issued: false, detail: 'The venue will arrange this refund.' };
    }

    try {
      await this.gateway.refund(intent.gatewayPaymentId, amountPaise, reason);
    } catch (err) {
      this.logger.error(
        `REFUND FAILED for payment ${intent.gatewayPaymentId} (booking ${reservationId}, ` +
          `${formatPaise(amountPaise)}): ${err instanceof Error ? err.message : err}. ` +
          `This must be refunded by hand.`,
      );
      return { issued: false, detail: 'The venue will arrange this refund.' };
    }

    await this.db
      .update(paymentIntents)
      .set({ status: 'refunded', refundReason: reason })
      .where(eq(paymentIntents.id, intent.id));

    return { issued: true, detail: 'Refunded to your original payment method.' };
  }

  /** Whether this venue expects payment before confirming. */
  async requiresPrepayment(venueId: string) {
    const [venue] = await this.db.select().from(venues).where(eq(venues.id, venueId)).limit(1);
    return Boolean(venue?.requiresPrepayment);
  }
}
