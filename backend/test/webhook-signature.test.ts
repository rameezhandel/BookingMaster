import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { RazorpayGateway } from '../src/payments/gateway/razorpay.gateway';
import { StubGateway } from '../src/payments/gateway/stub.gateway';

/** Minimal stand-in for ConfigService. */
const config = (values: Record<string, string>) =>
  ({ get: (key: string) => values[key], getOrThrow: (key: string) => values[key] }) as never;

const SECRET = 'a-webhook-secret';
const razorpay = () =>
  new RazorpayGateway(
    config({
      RAZORPAY_KEY_ID: 'rzp_test_key',
      RAZORPAY_KEY_SECRET: 'secret',
      RAZORPAY_WEBHOOK_SECRET: SECRET,
    }),
  );

const sign = (body: Buffer, secret = SECRET) =>
  createHmac('sha256', secret).update(body).digest('hex');

const BODY = Buffer.from(
  JSON.stringify({
    id: 'evt_123',
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 90000 } } },
  }),
);

describe('webhook signature verification', () => {
  it('accepts a body signed with the webhook secret', () => {
    assert.equal(razorpay().verifyWebhook(BODY, sign(BODY)), true);
  });

  it('rejects a body that was altered after signing', () => {
    const signature = sign(BODY);
    const tampered = Buffer.from(BODY.toString().replace('90000', '100'));
    assert.equal(razorpay().verifyWebhook(tampered, signature), false);
  });

  it('rejects a signature made with a different secret', () => {
    assert.equal(razorpay().verifyWebhook(BODY, sign(BODY, 'someone-elses-secret')), false);
  });

  it('rejects a missing or malformed signature rather than throwing', () => {
    assert.equal(razorpay().verifyWebhook(BODY, ''), false);
    assert.equal(razorpay().verifyWebhook(BODY, 'not-hex-at-all'), false);
    assert.equal(razorpay().verifyWebhook(BODY, 'abcd'), false);
  });

  it('is byte-exact: re-serialised JSON does not verify', () => {
    const signature = sign(BODY);
    // Same data, different key order and spacing — which is exactly what
    // happens if you sign the parsed body instead of the raw bytes.
    const reserialised = Buffer.from(
      JSON.stringify({
        event: 'payment.captured',
        id: 'evt_123',
        payload: { payment: { entity: { amount: 90000, order_id: 'order_1', id: 'pay_1' } } },
      }),
    );
    assert.notEqual(reserialised.toString(), BODY.toString());
    assert.equal(
      razorpay().verifyWebhook(reserialised, signature),
      false,
      'this is why the handler must be given req.rawBody',
    );
  });

  it('refuses everything when no webhook secret is configured', () => {
    const unconfigured = new RazorpayGateway(config({}));
    assert.equal(unconfigured.configured, false);
    assert.equal(unconfigured.verifyWebhook(BODY, sign(BODY)), false);
  });

  it('never exposes the secret key as the public key', () => {
    const gateway = razorpay();
    assert.equal(gateway.publicKey, 'rzp_test_key');
    assert.ok(!JSON.stringify(gateway.publicKey).includes('secret'));
  });
});

describe('event parsing', () => {
  it('extracts the ids and amount a captured payment carries', () => {
    const event = razorpay().parseEvent(JSON.parse(BODY.toString()));
    assert.equal(event?.kind, 'payment.captured');
    assert.equal(event?.orderId, 'order_1');
    assert.equal(event?.paymentId, 'pay_1');
    assert.equal(event?.amountPaise, 90000);
    assert.equal(event?.eventId, 'evt_123');
  });

  it('marks unrelated event types as other rather than guessing', () => {
    const event = razorpay().parseEvent({ id: 'evt_9', event: 'refund.processed', payload: {} });
    assert.equal(event?.kind, 'other');
  });

  it('returns null for a body that is not an event at all', () => {
    assert.equal(razorpay().parseEvent({ hello: 'world' }), null);
    assert.equal(razorpay().parseEvent(null), null);
  });

  it('still produces an idempotency key when the body carries no id', () => {
    const event = razorpay().parseEvent({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_7', order_id: 'order_7', amount: 100 } } },
    });
    assert.ok(event?.eventId, 'an event without a key could be applied twice');
    assert.ok(event!.eventId.includes('pay_7'));
  });
});

describe('the stub gateway', () => {
  it('signs the way the real one verifies, so the flow is genuinely exercised', () => {
    const stub = new StubGateway(config({ STUB_GATEWAY_SECRET: SECRET, NODE_ENV: 'test' }));
    assert.equal(stub.verifyWebhook(BODY, stub.sign(BODY)), true);
    // And the real gateway agrees, which is the point of the arrangement.
    assert.equal(razorpay().verifyWebhook(BODY, stub.sign(BODY)), true);
  });

  it('refuses to operate in production', async () => {
    const stub = new StubGateway(config({ NODE_ENV: 'production' }));
    assert.equal(stub.configured, false);
    assert.equal(stub.publicKey, null);
    await assert.rejects(
      () => stub.createOrder({ amountPaise: 100, currency: 'INR', receipt: 'r' }),
      /never be used in production/,
    );
  });
});
