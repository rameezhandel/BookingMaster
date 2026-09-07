/**
 * Tenant isolation, enforced by the database rather than by the application.
 *
 * Every query in the app already filters by tenant_id. This checks the backstop
 * for the one that eventually forgets, because that mistake leaks another
 * venue's customers and revenue.
 *
 * Requires DATABASE_URL and a migrated database.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';
import { loadEnv } from '../src/db/env';

loadEnv();

const RLS_VIOLATION = '42501';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

let alpha: string;
let beta: string;
let alphaVenue: string;

const bypass = () => pool.query(`SET app.bypass_rls = 'on'`);
const asTenant = async (id: string) => {
  await pool.query(`SET app.bypass_rls = 'off'`);
  await pool.query(`SET app.tenant_id = '${id}'`);
};
const asNobody = async () => {
  await pool.query(`SET app.bypass_rls = 'off'`);
  await pool.query(`RESET app.tenant_id`);
};

before(async () => {
  await bypass();
  const a = await pool.query(`INSERT INTO tenant (name) VALUES ('__rls_alpha__') RETURNING id`);
  const b = await pool.query(`INSERT INTO tenant (name) VALUES ('__rls_beta__') RETURNING id`);
  alpha = a.rows[0].id;
  beta = b.rows[0].id;

  const v = await pool.query(
    `INSERT INTO venue (tenant_id, name) VALUES ($1, 'Alpha Arena') RETURNING id`,
    [alpha],
  );
  alphaVenue = v.rows[0].id;
  await pool.query(`INSERT INTO venue (tenant_id, name) VALUES ($1, 'Beta Arena')`, [beta]);
  await pool.query(
    `INSERT INTO customer (tenant_id, name, phone) VALUES ($1, 'Alpha Regular', '+911111111111')`,
    [alpha],
  );
});

after(async () => {
  await bypass();
  if (alpha) await pool.query('DELETE FROM tenant WHERE id = $1', [alpha]);
  if (beta) await pool.query('DELETE FROM tenant WHERE id = $1', [beta]);
  await pool.end();
});

/*
 * The precondition, asserted rather than written in a comment.
 *
 * A superuser, or any role with BYPASSRLS, ignores every policy silently. Every
 * test below would then pass while proving nothing — and a default `postgres`
 * container hands you exactly such a role, so this is the likely state of a
 * fresh continuous-integration run rather than an exotic one. A green suite
 * that cannot fail is worse than no suite: it is a claim of isolation nobody
 * has checked.
 */
describe('the precondition these tests rest on', () => {
  it('connects as a role that row-level security actually applies to', async () => {
    const { rows } = await pool.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    const role = rows[0];
    assert.equal(
      role.rolsuper || role.rolbypassrls,
      false,
      `Connected as "${role?.rolname}", which ${role?.rolsuper ? 'is a superuser' : 'has BYPASSRLS'}. ` +
        'Every isolation test below would pass without proving anything. Point DATABASE_URL at ' +
        'the unprivileged role the application uses in production.',
    );
  });
});

describe('tenant isolation', () => {
  it('shows nothing at all when no tenant is set', async () => {
    await asNobody();
    const venues = await pool.query('SELECT count(*)::int AS n FROM venue');
    const customers = await pool.query('SELECT count(*)::int AS n FROM customer');
    assert.equal(venues.rows[0].n, 0, 'a request without tenant context must fail closed');
    assert.equal(customers.rows[0].n, 0);
  });

  it('shows a tenant only its own rows', async () => {
    await asTenant(alpha);
    const { rows } = await pool.query('SELECT name FROM venue ORDER BY name');
    assert.deepEqual(rows.map((r) => r.name), ['Alpha Arena']);
  });

  it('hides another tenant even when its id is known', async () => {
    await asTenant(beta);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM venue WHERE id = $1', [
      alphaVenue,
    ]);
    assert.equal(rows[0].n, 0, 'naming the row directly must not reveal it');
  });

  it('refuses to write a row belonging to another tenant', async () => {
    await asTenant(beta);
    await assert.rejects(
      () => pool.query(`INSERT INTO venue (tenant_id, name) VALUES ($1, 'Smuggled')`, [alpha]),
      (err: { code?: string }) => err.code === RLS_VIOLATION,
    );
  });

  it('refuses to move an existing row to another tenant', async () => {
    await asTenant(alpha);
    await assert.rejects(
      () => pool.query('UPDATE venue SET tenant_id = $1 WHERE id = $2', [beta, alphaVenue]),
      (err: { code?: string }) => err.code === RLS_VIOLATION,
    );
  });

  it('cannot delete another tenant\'s rows', async () => {
    await asTenant(beta);
    const deleted = await pool.query('DELETE FROM venue WHERE id = $1', [alphaVenue]);
    assert.equal(deleted.rowCount, 0);

    await asTenant(alpha);
    const still = await pool.query('SELECT count(*)::int AS n FROM venue WHERE id = $1', [alphaVenue]);
    assert.equal(still.rows[0].n, 1, 'the row must survive');
  });

  it('protects every tenant-scoped table, not just the obvious ones', async () => {
    await asNobody();
    for (const table of [
      'venue',
      'resource',
      'resource_hour_rule',
      'venue_date_override',
      'price_rule',
      'customer',
      'reservation',
      'payment',
      'booking_series',
      'cancellation_tier',
      'audit_event',
      'otp_challenge',
      'payment_intent',
    ]) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      assert.equal(rows[0].n, 0, `${table} leaked rows with no tenant context`);
    }
  });

  it('keeps gateway events out of reach of any tenant context', async () => {
    // Raw webhook payloads are infrastructure, not tenant data, and nothing
    // reads them through a request. Only a system context may see them at all,
    // so even a correctly scoped tenant gets nothing.
    await asTenant(alpha);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM gateway_event');
    assert.equal(rows[0].n, 0);

    await asNobody();
    const none = await pool.query('SELECT count(*)::int AS n FROM gateway_event');
    assert.equal(none.rows[0].n, 0);
  });

  it('keeps the audit trail append-only', async () => {
    await bypass();
    await pool.query(
      `INSERT INTO audit_event (tenant_id, action, entity_type, summary)
       VALUES ($1, 'test.event', 'test', 'original')`,
      [alpha],
    );
    await asTenant(alpha);

    const updated = await pool.query(`UPDATE audit_event SET summary = 'tampered'`);
    const deleted = await pool.query('DELETE FROM audit_event');
    assert.equal(updated.rowCount, 0, 'audit rows must not be editable');
    assert.equal(deleted.rowCount, 0, 'audit rows must not be deletable');

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM audit_event WHERE summary = 'original'`,
    );
    assert.equal(rows[0].n, 1);
  });
});
