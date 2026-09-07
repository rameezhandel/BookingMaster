/**
 * The message outbox, against a real database.
 *
 * The parts worth testing here are the ones that go wrong quietly: a customer
 * messaged twice because two webhook retries both queued, a customer who asked
 * not to be messaged getting messaged anyway, or a provider outage turning into
 * an infinite retry loop. None of those raise an error at the time.
 *
 * Requires DATABASE_URL and a migrated database.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../src/db/schema';
import { loadEnv } from '../src/db/env';
import type { Db } from '../src/db/database.module';
import type { NotificationChannel, OutboundMessage, SendOutcome } from '../src/notifications/channels/channel';
import { MAX_ATTEMPTS, NotificationsService } from '../src/notifications/notifications.service';

loadEnv();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
pool.on('connect', (client) => {
  void client.query(`SET app.bypass_rls = 'on'`);
});
const db = drizzle(pool, { schema }) as unknown as Db;

/** Records what it was asked to send, and answers however the test needs. */
class FakeChannel implements NotificationChannel {
  readonly name = 'fake';
  readonly configured = true;
  sent: OutboundMessage[] = [];
  outcome: SendOutcome = { ok: true, providerMessageId: 'wamid.fake' };

  async send(message: OutboundMessage): Promise<SendOutcome> {
    this.sent.push(message);
    return this.outcome;
  }
}

let tenantId: string;
let venueId: string;
let customerId: string;
let channel: FakeChannel;
let service: NotificationsService;

/**
 * A booking, some hours out, for a customer who can be messaged.
 *
 * Each one gets its own court: the exclusion constraint is doing its job, and
 * tests that happen to pick the same hour should not fight over a slot.
 */
let courtNumber = 0;
async function makeBooking(hoursFromNow: number, status = 'confirmed'): Promise<string> {
  const c = await pool.query(
    `INSERT INTO resource (tenant_id, venue_id, name, sport) VALUES ($1, $2, $3, 'badminton') RETURNING id`,
    [tenantId, venueId, `Court ${++courtNumber}`],
  );
  const r = await pool.query(
    `INSERT INTO reservation (tenant_id, venue_id, resource_id, customer_id, kind, status, during, amount_paise)
     VALUES ($1, $2, $3, $4, 'booking', $5,
             tstzrange(now() + make_interval(mins => $6), now() + make_interval(mins => $6 + 60), '[)'),
             50000)
     RETURNING id`,
    [tenantId, venueId, c.rows[0].id, customerId, status, Math.round(hoursFromNow * 60)],
  );
  return r.rows[0].id;
}

const countFor = async (reservationId: string) =>
  Number(
    (await pool.query('SELECT count(*) FROM notification WHERE reservation_id = $1', [reservationId]))
      .rows[0].count,
  );

before(async () => {
  const t = await pool.query(`INSERT INTO tenant (name) VALUES ('__notify_test__') RETURNING id`);
  tenantId = t.rows[0].id;
  const v = await pool.query(
    `INSERT INTO venue (tenant_id, name, timezone) VALUES ($1, 'Notify Arena', 'Asia/Kolkata') RETURNING id`,
    [tenantId],
  );
  venueId = v.rows[0].id;
  const cust = await pool.query(
    `INSERT INTO customer (tenant_id, name, phone) VALUES ($1, 'Arjun Nair', '+919845000001') RETURNING id`,
    [tenantId],
  );
  customerId = cust.rows[0].id;
});

beforeEach(async () => {
  await pool.query('DELETE FROM notification WHERE tenant_id = $1', [tenantId]);
  await pool.query(
    `UPDATE venue SET notifications_enabled = true, reminder_hours_before = 3 WHERE id = $1`,
    [venueId],
  );
  await pool.query(`UPDATE customer SET notifications_opted_out = false WHERE id = $1`, [customerId]);
  channel = new FakeChannel();
  service = new NotificationsService(db, channel);
});

after(async () => {
  if (tenantId) await pool.query('DELETE FROM tenant WHERE id = $1', [tenantId]);
  await pool.end();
});

describe('queueing', () => {
  it('renders the booking into the message', async () => {
    const id = await makeBooking(30);
    await service.enqueue({ tenantId, reservationId: id, templateKey: 'booking_confirmed' });

    const [row] = (await pool.query('SELECT * FROM notification WHERE reservation_id = $1', [id])).rows;
    assert.equal(row.status, 'pending');
    assert.equal(row.to_phone, '+919845000001');
    // First name only, and the venue and price the customer will be asked for.
    assert.match(row.preview, /Hi Arjun,/);
    assert.match(row.preview, /Notify Arena/);
    assert.match(row.preview, /₹500/);
    assert.equal(row.params[0], 'Arjun');
  });

  it('queues one message however many times the same event arrives', async () => {
    const id = await makeBooking(30);
    // Two webhook deliveries, a double-clicked button: same message either way.
    await service.enqueue({ tenantId, reservationId: id, templateKey: 'booking_confirmed' });
    await service.enqueue({ tenantId, reservationId: id, templateKey: 'booking_confirmed' });
    assert.equal(await countFor(id), 1);
  });

  it('separates messages about the same booking by their suffix', async () => {
    const id = await makeBooking(30);
    await service.enqueue({ tenantId, reservationId: id, templateKey: 'booking_confirmed' });
    await service.enqueue({
      tenantId,
      reservationId: id,
      templateKey: 'booking_cancelled',
      dedupeSuffix: 'customer',
    });
    assert.equal(await countFor(id), 2);
  });

  it('says nothing to a customer who asked not to be messaged', async () => {
    await pool.query(`UPDATE customer SET notifications_opted_out = true WHERE id = $1`, [customerId]);
    const id = await makeBooking(30);
    await service.enqueue({ tenantId, reservationId: id, templateKey: 'booking_confirmed' });
    assert.equal(await countFor(id), 0);
  });

  it('says nothing when the venue has messaging turned off', async () => {
    await pool.query(`UPDATE venue SET notifications_enabled = false WHERE id = $1`, [venueId]);
    const id = await makeBooking(30);
    await service.enqueue({ tenantId, reservationId: id, templateKey: 'booking_confirmed' });
    assert.equal(await countFor(id), 0);
  });

  it('says nothing about a walk-in with no customer on it', async () => {
    const walkInCourt = await pool.query(
      `INSERT INTO resource (tenant_id, venue_id, name, sport) VALUES ($1, $2, 'Walk-in court', 'badminton') RETURNING id`,
      [tenantId, venueId],
    );
    const r = await pool.query(
      `INSERT INTO reservation (tenant_id, venue_id, resource_id, kind, status, during, amount_paise)
       VALUES ($1, $2, $3, 'booking', 'confirmed',
               tstzrange(now() + interval '40 hours', now() + interval '41 hours', '[)'), 50000)
       RETURNING id`,
      [tenantId, venueId, walkInCourt.rows[0].id],
    );
    await service.enqueue({ tenantId, reservationId: r.rows[0].id, templateKey: 'booking_confirmed' });
    assert.equal(await countFor(r.rows[0].id), 0);
  });

  it('does not throw when the booking is not there to describe', async () => {
    await service.enqueue({
      tenantId,
      reservationId: '00000000-0000-0000-0000-000000000000',
      templateKey: 'booking_confirmed',
    });
  });

  it('carries the refund wording a cancellation needs', async () => {
    const id = await makeBooking(30, 'cancelled');
    await service.enqueue({
      tenantId,
      reservationId: id,
      templateKey: 'booking_cancelled',
      extra: '₹500 has been refunded to your original payment method.',
    });
    const [row] = (await pool.query('SELECT * FROM notification WHERE reservation_id = $1', [id])).rows;
    assert.match(row.preview, /refunded to your original payment method/);
  });
});

describe('delivery', () => {
  it('sends what is due and records the provider reference', async () => {
    const id = await makeBooking(30);
    await service.enqueue({ tenantId, reservationId: id, templateKey: 'booking_confirmed' });

    const result = await service.deliverDue();
    assert.deepEqual(result, { sent: 1, failed: 0, retrying: 0 });
    assert.equal(channel.sent.length, 1);
    assert.equal(channel.sent[0].templateName, 'booking_confirmed');

    const [row] = (await pool.query('SELECT * FROM notification WHERE reservation_id = $1', [id])).rows;
    assert.equal(row.status, 'sent');
    assert.equal(row.provider, 'fake');
    assert.equal(row.provider_message_id, 'wamid.fake');
    assert.ok(row.sent_at);
  });

  it('does not send the same message on a second run', async () => {
    const id = await makeBooking(30);
    await service.enqueue({ tenantId, reservationId: id, templateKey: 'booking_confirmed' });
    await service.deliverDue();
    const second = await service.deliverDue();
    assert.deepEqual(second, { sent: 0, failed: 0, retrying: 0 });
    assert.equal(channel.sent.length, 1);
  });

  it('backs off a provider blip rather than giving up on it', async () => {
    const id = await makeBooking(30);
    await service.enqueue({ tenantId, reservationId: id, templateKey: 'booking_confirmed' });
    channel.outcome = { ok: false, retryable: true, error: 'HTTP 503' };

    const result = await service.deliverDue();
    assert.deepEqual(result, { sent: 0, failed: 0, retrying: 1 });

    const [row] = (await pool.query('SELECT * FROM notification WHERE reservation_id = $1', [id])).rows;
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    assert.equal(row.error, 'HTTP 503');
    // Pushed into the future, so the next run in ten seconds leaves it alone.
    assert.ok(row.next_attempt_at.getTime() > Date.now() + 30_000);
  });

  it('gives up rather than retrying a message the provider will never accept', async () => {
    const id = await makeBooking(30);
    await service.enqueue({ tenantId, reservationId: id, templateKey: 'booking_confirmed' });
    channel.outcome = { ok: false, retryable: false, error: 'Template not approved' };

    const result = await service.deliverDue();
    assert.deepEqual(result, { sent: 0, failed: 1, retrying: 0 });
    const [row] = (await pool.query('SELECT * FROM notification WHERE reservation_id = $1', [id])).rows;
    assert.equal(row.status, 'failed');
    assert.equal(row.error, 'Template not approved');
  });

  it('stops retrying eventually', async () => {
    const id = await makeBooking(30);
    await service.enqueue({ tenantId, reservationId: id, templateKey: 'booking_confirmed' });
    channel.outcome = { ok: false, retryable: true, error: 'HTTP 503' };

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // The backoff is real time; move the row's due date rather than waiting.
      await pool.query(`UPDATE notification SET next_attempt_at = now() WHERE reservation_id = $1`, [id]);
      await service.deliverDue();
    }

    const [row] = (await pool.query('SELECT * FROM notification WHERE reservation_id = $1', [id])).rows;
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, MAX_ATTEMPTS);
    assert.equal(channel.sent.length, MAX_ATTEMPTS);
  });

  it('leaves a message alone until its backoff has passed', async () => {
    const id = await makeBooking(30);
    await service.enqueue({ tenantId, reservationId: id, templateKey: 'booking_confirmed' });
    channel.outcome = { ok: false, retryable: true, error: 'HTTP 503' };
    await service.deliverDue();

    channel.outcome = { ok: true, providerMessageId: 'wamid.fake' };
    const result = await service.deliverDue();
    assert.deepEqual(result, { sent: 0, failed: 0, retrying: 0 });
  });

  it('fails a message whose template no longer exists instead of crashing the run', async () => {
    const id = await makeBooking(30);
    await service.enqueue({ tenantId, reservationId: id, templateKey: 'booking_confirmed' });
    await pool.query(`UPDATE notification SET template = 'retired_template' WHERE reservation_id = $1`, [id]);

    const result = await service.deliverDue();
    assert.equal(result.failed, 1);
    const [row] = (await pool.query('SELECT * FROM notification WHERE reservation_id = $1', [id])).rows;
    assert.equal(row.status, 'failed');
    assert.match(row.error, /Unknown template/);
  });
});

describe('reminders', () => {
  it('reminds about a booking inside the venue window, once', async () => {
    const soon = await makeBooking(2);
    await service.queueDueReminders();
    await service.queueDueReminders();
    assert.equal(await countFor(soon), 1);
  });

  it('leaves a booking further out than the window alone', async () => {
    const later = await makeBooking(10);
    await service.queueDueReminders();
    assert.equal(await countFor(later), 0);
  });

  it('does not remind about a booking that has already started', async () => {
    const started = await makeBooking(-0.5);
    await service.queueDueReminders();
    assert.equal(await countFor(started), 0);
  });

  it('does not remind about a cancelled booking', async () => {
    const gone = await makeBooking(2, 'cancelled');
    await service.queueDueReminders();
    assert.equal(await countFor(gone), 0);
  });

  it('sends no reminders at all when the venue has turned them off', async () => {
    await pool.query(`UPDATE venue SET reminder_hours_before = 0 WHERE id = $1`, [venueId]);
    const soon = await makeBooking(2);
    await service.queueDueReminders();
    assert.equal(await countFor(soon), 0);
  });
});

describe('the owner-facing log', () => {
  it('shows the message with the customer it went to, newest first', async () => {
    const first = await makeBooking(30);
    const second = await makeBooking(40);
    await service.enqueue({ tenantId, reservationId: first, templateKey: 'booking_confirmed' });
    await service.enqueue({ tenantId, reservationId: second, templateKey: 'booking_confirmed' });

    const rows = await service.list(tenantId, venueId);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].customerName, 'Arjun Nair');
    assert.ok(rows[0].createdAt >= rows[1].createdAt);
  });

  it('shows nothing from another venue', async () => {
    const id = await makeBooking(30);
    await service.enqueue({ tenantId, reservationId: id, templateKey: 'booking_confirmed' });
    const rows = await service.list(tenantId, '00000000-0000-0000-0000-000000000000');
    assert.equal(rows.length, 0);
  });
});
