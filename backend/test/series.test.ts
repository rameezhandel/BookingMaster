/**
 * Database-level guarantees the series code depends on.
 * Requires DATABASE_URL and a migrated database.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';
import { loadEnv } from '../src/db/env';

loadEnv();

const PG_CHECK_VIOLATION = '23514';
const PG_UNIQUE_VIOLATION = '23505';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

// See concurrency.test.ts: fixtures are built in raw SQL, so row-level
// security is opted out of explicitly. Isolation is covered in rls.test.ts.
pool.on('connect', (client) => {
  void client.query(`SET app.bypass_rls = 'on'`);
});

let tenantId: string;
let venueId: string;
let courtId: string;

before(async () => {
  const t = await pool.query(`INSERT INTO tenant (name) VALUES ('__series_test__') RETURNING id`);
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

async function makeSeries(startsOn: string) {
  const { rows } = await pool.query(
    `INSERT INTO booking_series
       (tenant_id, venue_id, resource_id, day_of_week, starts_at, duration_minutes, starts_on)
     VALUES ($1, $2, $3, 2, '20:00', 60, $4) RETURNING id`,
    [tenantId, venueId, courtId, startsOn],
  );
  return rows[0].id as string;
}

describe('booking series', () => {
  it('refuses an end date before the start date', async () => {
    const id = await makeSeries('2027-03-02');
    await assert.rejects(
      () => pool.query(`UPDATE booking_series SET ends_on = '2027-03-01' WHERE id = $1`, [id]),
      (err: { code?: string }) => err.code === PG_CHECK_VIOLATION,
      'this is why ending a not-yet-started series clamps ends_on to starts_on',
    );
  });

  it('accepts an end date clamped to the start date', async () => {
    const id = await makeSeries('2027-03-09');
    const res = await pool.query(
      `UPDATE booking_series SET ends_on = starts_on, status = 'ended' WHERE id = $1`,
      [id],
    );
    assert.equal(res.rowCount, 1);
  });

  it('allows only one live booking per series per date', async () => {
    const id = await makeSeries('2027-04-06');
    const insert = () =>
      pool.query(
        `INSERT INTO reservation
           (tenant_id, venue_id, resource_id, kind, status, during, series_id, occurrence_date)
         VALUES ($1, $2, $3, 'booking', 'confirmed',
                 tstzrange($4::timestamptz, $5::timestamptz, '[)'), $6, '2027-04-06')`,
        [
          tenantId,
          venueId,
          courtId,
          '2027-04-06T20:00:00+05:30',
          '2027-04-06T21:00:00+05:30',
          id,
        ],
      );

    await insert();
    // The second attempt is rejected by the overlap constraint before the
    // series index is even reached; either way, re-materialising is safe.
    await assert.rejects(insert, (err: { code?: string }) =>
      [PG_UNIQUE_VIOLATION, '23P01'].includes(err.code ?? ''),
    );
  });

  it('frees the date again once the occurrence is cancelled', async () => {
    const id = await makeSeries('2027-05-04');
    const insert = () =>
      pool.query(
        `INSERT INTO reservation
           (tenant_id, venue_id, resource_id, kind, status, during, series_id, occurrence_date)
         VALUES ($1, $2, $3, 'booking', 'confirmed',
                 tstzrange($4::timestamptz, $5::timestamptz, '[)'), $6, '2027-05-04')
         RETURNING id`,
        [tenantId, venueId, courtId, '2027-05-04T20:00:00+05:30', '2027-05-04T21:00:00+05:30', id],
      );

    const first = await insert();
    await pool.query(`UPDATE reservation SET status = 'cancelled' WHERE id = $1`, [first.rows[0].id]);
    const second = await insert();
    assert.equal(second.rowCount, 1, 'a cancelled occurrence must not block re-booking that week');
  });
});
