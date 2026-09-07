import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  CreateOrderInput,
  CreatedOrder,
  GatewayEvent,
  PaymentGateway,
  RefundResult,
} from './gateway';

/**
 * A gateway that behaves like the real one without leaving the building.
 *
 * It is not a mock in the testing sense: it signs webhooks with the same
 * HMAC-SHA256-over-raw-body scheme Razorpay uses, so every part of the flow
 * that actually carries risk — signature verification, replay rejection,
 * idempotency, confirming the booking, refunding a payment that arrived too
 * late — runs against real code paths.
 *
 * Used when no gateway credentials are configured. It refuses to be used in
 * production, because a stub that silently accepts money is worse than no
 * payments at all.
 */
@Injectable()
export class StubGateway implements PaymentGateway {
  readonly name = 'stub';
  private readonly logger = new Logger(StubGateway.name);
  private readonly secret: string;
  private readonly allowed: boolean;

  constructor(config: ConfigService) {
    this.secret = config.get<string>('STUB_GATEWAY_SECRET') ?? 'stub-webhook-secret';
    this.allowed = config.get<string>('NODE_ENV') !== 'production';
  }

  get configured() {
    return this.allowed;
  }

  get publicKey() {
    return this.allowed ? 'stub_key' : null;
  }

  async createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
    this.assertAllowed();
    const orderId = `order_stub_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    this.logger.warn(
      `Stub payment order ${orderId} for ${input.amountPaise} paise — no money will move.`,
    );
    return { orderId, amountPaise: input.amountPaise, currency: input.currency };
  }

  verifyWebhook(rawBody: Buffer, signature: string): boolean {
    if (!signature) return false;
    const expected = createHmac('sha256', this.secret).update(rawBody).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, 'hex');
    } catch {
      return false;
    }
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /** Exposed so tests and local tooling can sign a body the way the gateway would. */
  sign(rawBody: Buffer): string {
    return createHmac('sha256', this.secret).update(rawBody).digest('hex');
  }

  parseEvent(payload: unknown): GatewayEvent | null {
    const body = payload as {
      id?: string;
      event?: string;
      payload?: { payment?: { entity?: Record<string, unknown> } };
    };
    if (!body?.event) return null;

    const entity = body.payload?.payment?.entity ?? {};
    return {
      eventId: String(body.id ?? randomUUID()),
      kind:
        body.event === 'payment.captured'
          ? 'payment.captured'
          : body.event === 'payment.failed'
            ? 'payment.failed'
            : 'other',
      rawType: body.event,
      orderId: entity.order_id ? String(entity.order_id) : null,
      paymentId: entity.id ? String(entity.id) : null,
      amountPaise: entity.amount != null ? Number(entity.amount) : null,
    };
  }

  async refund(paymentId: string, amountPaise: number, reason: string): Promise<RefundResult> {
    this.assertAllowed();
    this.logger.warn(`Stub refund of ${amountPaise} paise against ${paymentId}: ${reason}`);
    return { refundId: `rfnd_stub_${randomUUID().replace(/-/g, '').slice(0, 14)}`, amountPaise };
  }

  private assertAllowed() {
    if (!this.allowed) {
      throw new Error('The stub payment gateway must never be used in production.');
    }
  }
}
