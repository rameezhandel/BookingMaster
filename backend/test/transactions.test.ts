/**
 * Postgres transaction behaviour that two bugs in this codebase depended on.
 *
 * Both were the same mistake: catching a failed statement inside a transaction
 * and carrying on. In Postgres the failed statement aborts the *whole*
 * transaction, and catching the error in JavaScript does not make it usable
 * again — every later statement fails and the commit is a rollback. The request
 * returns 201 while nothing was written.
 *
 * These tests exist so the shape of the fix (a SAVEPOINT, via a nested
 * transaction) is not quietly refactored away.
 *
 * Requires DATABASE_URL and a migrated database.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';
import { loadEnv } from '../src/db/env';

loadEnv();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
pool.on('connect', (client) => {
  void client.query(`SET app.bypass_rls = 'on'`);
});

let tenantId: string;
let venueId: string;
let courtId: string;

const SLOT: [string, string] = ['2027-08-01T19:00:00+05:30', '2027-08-01T20:00:00+05:30'];

before(async () => {
  const t = await pool.query(`INSERT INTO tenant (name) VALUES ('__tx_test__') RETURNING id`);
  tenantId = t.rows[0].id;
  const v = await pool.query(
    `INSERT INTO venue (tenant_id, name) VALUES ($1, 'Tx Venue') RETURNING id`,
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

const insertBooking = (client: { query: Pool['query'] }, status = 'confirmed') =>
  client.query(
    `INSERT INTO reservation (tenant_id, venue_id, resource_id, kind, status, during, expires_at)
     VALUES ($1, $2, $3, 'booking', $4,
             tstzrange($5::timestamptz, $6::timestamptz, '[)'),
             CASE WHEN $4 = 'held' THEN now() + interval '10 minutes' ELSE NULL END)
     RETURNING id`,
    [tenantId, venueId, courtId, status, SLOT[0], SLOT[1]],
  );

describe('a failed statement inside a transaction', () => {
  it('poisons the transaction, so catching the error is not enough', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await insertBooking(client as never);

      // The clash, swallowed exactly the way the buggy code swallowed it.
      await assert.rejects(() => insertBooking(client as never));

      // The transaction is now unusable, which is the part that surprises people.
      await assert.rejects(
        () => client.query('SELECT 1'),
        /current transaction is aborted/i,
        'Postgres refuses further work until the transaction is rolled back',
      );

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM reservation WHERE resource_id = $1`,
      [courtId],
    );
    assert.equal(rows[0].n, 0, 'the first insert was lost too, despite having succeeded');
  });

  it('is confined by a SAVEPOINT, which is how the booking path survives a clash', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const first = await insertBooking(client as never);

      await client.query('SAVEPOINT attempt');
      await assert.rejects(() => insertBooking(client as never));
      await client.query('ROLLBACK TO SAVEPOINT attempt');

      // The outer transaction is still usable: this is what lets the real code
      // sweep expired holds and retry after a conflict.
      const alive = await client.query('SELECT 1 AS ok');
      assert.equal(alive.rows[0].ok, 1);

      await client.query('COMMIT');

      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM reservation WHERE id = $1`,
        [first.rows[0].id],
      );
      assert.equal(rows[0].n, 1, 'the work before the clash survives');
    } finally {
      client.release();
    }
  });
});

describe('expired holds', () => {
  it('still block the constraint until something sweeps them', async () => {
    await pool.query(`DELETE FROM reservation WHERE resource_id = $1`, [courtId]);

    const held = await insertBooking(pool as never, 'held');
    await pool.query(`UPDATE reservation SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      held.rows[0].id,
    ]);

    // The exclusion constraint cannot evaluate now(), so to the database this
    // expired hold still occupies the slot. That gap is why the booking path
    // sweeps and retries rather than trusting the timer.
    await assert.rejects(
      () => insertBooking(pool as never),
      (err: { code?: string }) => err.code === '23P01',
    );

    const swept = await pool.query(
      `DELETE FROM reservation
       WHERE resource_id = $1 AND status = 'held' AND expires_at < now()`,
      [courtId],
    );
    assert.equal(swept.rowCount, 1);

    const retry = await insertBooking(pool as never);
    assert.equal(retry.rowCount, 1, 'the slot is bookable once the expired hold is gone');
  });
});
