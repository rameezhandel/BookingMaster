import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';

export const OWNER = { email: 'owner@smasharena.test', password: 'bookingmaster' };
export const VENUE_SLUG = 'smash-arena-hsr';
/** Matches the stub gateway the app falls back to with no Razorpay keys. */
export const STUB_WEBHOOK_SECRET = 'stub-webhook-secret';

const SERVER_LOG = resolve(__dirname, '.server.log');

export async function signIn(page: Page, email = OWNER.email, password = OWNER.password) {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await page.waitForSelector('table.grid, .empty', { timeout: 30_000 });
}

/**
 * The one-time code, read back out of the server log.
 *
 * There is no SMS provider, so the code is logged rather than sent. Reading it
 * here keeps the product honest: no test-only endpoint that returns the code,
 * because such an endpoint is one config mistake away from being live.
 */
export function latestOtp(): string {
  const log = readFileSync(SERVER_LOG, 'utf8');
  const codes = [...log.matchAll(/is (\d{6}) \(no provider/g)].map((m) => m[1]);
  const code = codes.at(-1);
  if (!code) throw new Error('No OTP found in the server log.');
  return code;
}

/** The stub gateway's order id for the payment just started. */
export function latestStubOrder(): string {
  const log = readFileSync(SERVER_LOG, 'utf8');
  const ids = [...log.matchAll(/Stub payment order (order_stub_\w+)/g)].map((m) => m[1]);
  const id = ids.at(-1);
  if (!id) throw new Error('No stub payment order found in the server log.');
  return id;
}

/**
 * A gateway webhook, signed the way the real one is.
 *
 * Signed over the exact bytes sent — re-serialising the object would reorder
 * keys and stop matching, which is the mistake the signature test exists to
 * catch.
 */
export async function sendPaymentWebhook(
  baseURL: string,
  orderId: string,
  amountPaise: number,
  event = 'payment.captured',
) {
  const body = JSON.stringify({
    id: `evt_${Date.now()}`,
    event,
    payload: { payment: { entity: { id: `pay_${Date.now()}`, order_id: orderId, amount: amountPaise } } },
  });
  const signature = createHmac('sha256', STUB_WEBHOOK_SECRET).update(Buffer.from(body)).digest('hex');
  const res = await fetch(`${baseURL}/api/webhooks/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature },
    body,
  });
  if (!res.ok) throw new Error(`Webhook rejected: ${res.status} ${await res.text()}`);
}

/** A phone number nobody else in this run will use. */
export const uniquePhone = () => `+91984${String(Date.now()).slice(-7)}`;
