export interface CreateOrderInput {
  amountPaise: number;
  currency: string;
  /** Our own reference, echoed back by the gateway. */
  receipt: string;
  notes?: Record<string, string>;
}

export interface CreatedOrder {
  orderId: string;
  amountPaise: number;
  currency: string;
}

export type GatewayEventKind = 'payment.captured' | 'payment.failed' | 'other';

export interface GatewayEvent {
  /** The gateway's own id for this notification. The idempotency key. */
  eventId: string;
  kind: GatewayEventKind;
  rawType: string;
  orderId: string | null;
  paymentId: string | null;
  amountPaise: number | null;
}

export interface RefundResult {
  refundId: string;
  amountPaise: number;
}

export interface PaymentGateway {
  readonly name: string;
  /** False when no credentials are configured, so callers can refuse cleanly. */
  readonly configured: boolean;
  /** Public key the browser checkout needs. Never the secret. */
  readonly publicKey: string | null;

  createOrder(input: CreateOrderInput): Promise<CreatedOrder>;

  /**
   * Verifies a webhook against the *raw* body.
   *
   * It must be the exact bytes received: re-serialising parsed JSON reorders
   * keys and changes whitespace, and the signature stops matching. This is the
   * single most common way webhook verification gets quietly disabled.
   */
  verifyWebhook(rawBody: Buffer, signature: string): boolean;

  parseEvent(payload: unknown): GatewayEvent | null;

  refund(paymentId: string, amountPaise: number, reason: string): Promise<RefundResult>;
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
