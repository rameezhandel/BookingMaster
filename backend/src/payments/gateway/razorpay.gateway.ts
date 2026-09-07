import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CreateOrderInput,
  CreatedOrder,
  GatewayEvent,
  PaymentGateway,
  RefundResult,
} from './gateway';

const API = 'https://api.razorpay.com/v1';

/**
 * Razorpay.
 *
 * NOT VERIFIED AGAINST THE LIVE API. The environment this was written in has no
 * outbound access to Razorpay and no credentials, so the HTTP calls below are
 * written from the documented API and have never received a real response.
 * Signature verification and the webhook handling around it *are* exercised, by
 * the stub gateway, which signs identically.
 *
 * Treat the order and refund calls as needing a pass against the test keys
 * before going live.
 */
@Injectable()
export class RazorpayGateway implements PaymentGateway {
  readonly name = 'razorpay';
  private readonly logger = new Logger(RazorpayGateway.name);
  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly webhookSecret: string;

  constructor(config: ConfigService) {
    this.keyId = config.get<string>('RAZORPAY_KEY_ID') ?? '';
    this.keySecret = config.get<string>('RAZORPAY_KEY_SECRET') ?? '';
    this.webhookSecret = config.get<string>('RAZORPAY_WEBHOOK_SECRET') ?? '';
  }

  get configured() {
    return Boolean(this.keyId && this.keySecret && this.webhookSecret);
  }

  get publicKey() {
    return this.keyId || null;
  }

  async createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
    const res = await this.call('/orders', {
      amount: input.amountPaise,
      currency: input.currency,
      receipt: input.receipt,
      notes: input.notes ?? {},
      payment_capture: 1,
    });

    return {
      orderId: String(res.id),
      amountPaise: Number(res.amount),
      currency: String(res.currency),
    };
  }

  verifyWebhook(rawBody: Buffer, signature: string): boolean {
    if (!this.webhookSecret || !signature) return false;
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, 'hex');
    } catch {
      return false;
    }
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  parseEvent(payload: unknown): GatewayEvent | null {
    const body = payload as {
      id?: string;
      event?: string;
      payload?: { payment?: { entity?: Record<string, unknown> } };
    };
    if (!body?.event) return null;

    const entity = body.payload?.payment?.entity ?? {};
    const kind =
      body.event === 'payment.captured'
        ? ('payment.captured' as const)
        : body.event === 'payment.failed'
          ? ('payment.failed' as const)
          : ('other' as const);

    return {
      // Razorpay sends x-razorpay-event-id as a header; the body id is the
      // fallback so an event is never processed without an idempotency key.
      eventId: String(body.id ?? `${body.event}:${entity.id ?? ''}`),
      kind,
      rawType: body.event,
      orderId: entity.order_id ? String(entity.order_id) : null,
      paymentId: entity.id ? String(entity.id) : null,
      amountPaise: entity.amount != null ? Number(entity.amount) : null,
    };
  }

  async refund(paymentId: string, amountPaise: number, reason: string): Promise<RefundResult> {
    const res = await this.call(`/payments/${encodeURIComponent(paymentId)}/refund`, {
      amount: amountPaise,
      speed: 'normal',
      notes: { reason },
    });
    return { refundId: String(res.id), amountPaise: Number(res.amount) };
  }

  private async call(path: string, body: unknown): Promise<Record<string, unknown>> {
    if (!this.configured) {
      throw new ServiceUnavailableException('Online payment is not configured.');
    }

    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64');
    let res: Response;
    try {
      res = await fetch(API + path, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      this.logger.error(`Razorpay ${path} unreachable: ${err instanceof Error ? err.message : err}`);
      throw new ServiceUnavailableException('The payment provider is not responding.');
    }

    const text = await res.text();
    if (!res.ok) {
      // Never log the body verbatim: gateway errors echo request fields back.
      this.logger.error(`Razorpay ${path} returned ${res.status}`);
      throw new ServiceUnavailableException('The payment provider rejected the request.');
    }
    return JSON.parse(text) as Record<string, unknown>;
  }
}
