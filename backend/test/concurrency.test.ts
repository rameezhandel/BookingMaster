/**
 * Integration tests against a real Postgres.
 *
 * These exist because the double-booking guarantee is a property of the
 * database, not of the application, and the only honest way to check it is to
 * race real connections against it.
 *
 * Requires DATABASE_URL (see backend/.env) and a migrated database.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';
import { loadEnv } from '../src/db/env';

loadEnv();

const PG_EXCLUSION_VIOLATION = '23P01';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 25 });

// These tests are about the database constraints, not tenant isolation, and
// they build their fixtures with raw SQL rather than through the API. They opt
// out of row-level security on every connection, explicitly. Isolation has its
// own test in rls.test.ts.
pool.on('connect', (client) => {
  void client.query(`SET app.bypass_rls = 'on'`);
});

let tenantId: string;
let venueId: string;
let courtId: string;

async function bookSlot(from: string, to: string, status = 'confirmed', kind = 'booking') {
  return pool.query(
    `INSERT INTO reservation (tenant_id, venue_id, resource_id, kind, status, during)
     VALUES ($1, $2, $3, $4, $5, tstzrange($6::timestamptz, $7::timestamptz, '[)'))
     RETURNING id`,
    [tenantId, venueId, courtId, kind, status, from, to],
  );
}

before(async () => {
  const t = await pool.query(`INSERT INTO tenant (name) VALUES ('__test__') RETURNING id`);
  tenantId = t.rows[0].id;
  const v = await pool.query(
    `INSERT INTO venue (tenant_id, name) VALUES ($1, 'Test Venue') RETURNING id`,
    [tenantId],
  );
  venueId = v.rows[0].id;
  const c = await pool.query(
    `INSERT INTO resource (tenant_id, venue_id, name, sport) VALUES ($1, $2, 'Court 1', 'badminton') RETURNING id`,
    [tenantId, venueId],
  );
  courtId = c.rows[0].id;
});

after(async () => {
  if (tenantId) await pool.query('DELETE FROM tenant WHERE id = $1', [tenantId]);
  await pool.end();
});

describe('double booking', () => {
  it('lets exactly one of many simultaneous bookings win the same slot', async () => {
    const CONTENDERS = 20;
    const results = await Promise.allSettled(
      Array.from({ length: CONTENDERS }, () =>
        bookSlot('2027-01-09T19:00:00+05:30', '2027-01-09T20:00:00+05:30'),
      ),
    );

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter(
      (r) => r.status === 'rejected' && (r.reason as { code?: string }).code === PG_EXCLUSION_VIOLATION,
    );

    assert.equal(won.length, 1, 'exactly one booking should be accepted');
    assert.equal(lost.length, CONTENDERS - 1, 'every other attempt must fail on the constraint');

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM reservation
       WHERE resource_id = $1 AND status IN ('held','confirmed','completed','blocked')`,
      [courtId],
    );
    assert.equal(rows[0].n, 1);
  });

  it('rejects a partially overlapping booking', async () => {
    await assert.rejects(
      () => bookSlot('2027-01-09T19:30:00+05:30', '2027-01-09T20:30:00+05:30'),
      (err: { code?: string }) => err.code === PG_EXCLUSION_VIOLATION,
    );
  });

  it('accepts an adjacent booking, because ranges are half-open', async () => {
    const res = await bookSlot('2027-01-09T20:00:00+05:30', '2027-01-09T21:00:00+05:30');
    assert.equal(res.rowCount, 1);
  });

  it('rejects a maintenance block laid over a booked slot', async () => {
    await assert.rejects(
      () => bookSlot('2027-01-09T19:00:00+05:30', '2027-01-09T20:00:00+05:30', 'blocked', 'block'),
      (err: { code?: string }) => err.code === PG_EXCLUSION_VIOLATION,
    );
  });

  it('frees the slot once a booking is cancelled', async () => {
    await pool.query(
      `UPDATE reservation SET status = 'cancelled', cancelled_at = now()
       WHERE resource_id = $1 AND lower(during) = '2027-01-09T19:00:00+05:30'::timestamptz`,
      [courtId],
    );
    const res = await bookSlot('2027-01-09T19:00:00+05:30', '2027-01-09T20:00:00+05:30');
    assert.equal(res.rowCount, 1);
  });

  it('frees the slot on a no-show, so it can be resold while the hour runs', async () => {
    await bookSlot('2027-01-10T07:00:00+05:30', '2027-01-10T08:00:00+05:30');
    await pool.query(
      `UPDATE reservation SET status = 'no_show'
       WHERE resource_id = $1 AND lower(during) = '2027-01-10T07:00:00+05:30'::timestamptz`,
      [courtId],
    );
    const res = await bookSlot('2027-01-10T07:00:00+05:30', '2027-01-10T08:00:00+05:30');
    assert.equal(res.rowCount, 1);
  });

  it('keeps different courts independent', async () => {
    const other = await pool.query(
      `INSERT INTO resource (tenant_id, venue_id, name, sport) VALUES ($1, $2, 'Court 2', 'badminton') RETURNING id`,
      [tenantId, venueId],
    );
    const res = await pool.query(
      `INSERT INTO reservation (tenant_id, venue_id, resource_id, kind, status, during)
       VALUES ($1, $2, $3, 'booking', 'confirmed', tstzrange($4::timestamptz, $5::timestamptz, '[)'))
       RETURNING id`,
      [tenantId, venueId, other.rows[0].id, '2027-01-09T19:00:00+05:30', '2027-01-09T20:00:00+05:30'],
    );
    assert.equal(res.rowCount, 1);
  });
});

describe('payment ledger', () => {
  it('nets refunds against receipts per booking', async () => {
    const booking = await pool.query(
      `INSERT INTO reservation (tenant_id, venue_id, resource_id, kind, status, during, amount_paise)
       VALUES ($1, $2, $3, 'booking', 'confirmed', tstzrange($4::timestamptz, $5::timestamptz, '[)'), 90000)
       RETURNING id`,
      [tenantId, venueId, courtId, '2027-02-01T19:00:00+05:30', '2027-02-01T20:00:00+05:30'],
    );
    const id = booking.rows[0].id;

    for (const [amount, direction] of [
      [50000, 'in'],
      [40000, 'in'],
      [20000, 'refund'],
    ] as const) {
      await pool.query(
        `INSERT INTO payment (tenant_id, reservation_id, amount_paise, direction, method)
         VALUES ($1, $2, $3, $4, 'cash')`,
        [tenantId, id, amount, direction],
      );
    }

    // The shape the app uses: a grouped aggregate joined on, never a correlated
    // subquery referencing reservation.id from inside FROM payment (which binds
    // to payment's own id and silently reports zero).
    const { rows } = await pool.query(
      `SELECT r.amount_paise::bigint AS billed, COALESCE(paid.paid_paise, 0)::bigint AS paid
       FROM reservation r
       LEFT JOIN (
         SELECT reservation_id,
                SUM(CASE WHEN direction = 'in' THEN amount_paise ELSE -amount_paise END) AS paid_paise
         FROM payment GROUP BY reservation_id
       ) paid ON paid.reservation_id = r.id
       WHERE r.id = $1`,
      [id],
    );

    assert.equal(Number(rows[0].billed), 90000);
    assert.equal(Number(rows[0].paid), 70000, 'Rs 500 + Rs 400 in, Rs 200 refunded');
  });
});
