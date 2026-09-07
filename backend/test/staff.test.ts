/**
 * Staff accounts: who can be let in, who can be locked out, and what a locked
 * account can still reach.
 *
 * The parts worth testing are the ones that fail open. An invitation that can
 * be redeemed twice makes two accounts from one invite; an owner who can demote
 * the last owner locks the whole business out of its own settings; and a
 * deactivated login that keeps working is not deactivated at all.
 *
 * Requires DATABASE_URL and a migrated database.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../src/db/schema';
import { loadEnv } from '../src/db/env';
import type { Db } from '../src/db/database.module';
import { StaffService } from '../src/staff/staff.service';

loadEnv();

const RLS_VIOLATION = '42501';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
pool.on('connect', (client) => {
  void client.query(`SET app.bypass_rls = 'on'`);
});
const db = drizzle(pool, { schema }) as unknown as Db;

/** The audit service writes on the ambient transaction; here there is none. */
const audit = { record: async () => undefined } as never;

let tenantId: string;
let otherTenantId: string;
let ownerId: string;
let service: StaffService;
const spawnedTenants: string[] = [];
let unique = 0;
const email = () => `staff${++unique}.${Date.now()}@example.test`;

before(async () => {
  const t = await pool.query(`INSERT INTO tenant (name) VALUES ('__staff_test__') RETURNING id`);
  tenantId = t.rows[0].id;
  const o = await pool.query(`INSERT INTO tenant (name) VALUES ('__staff_other__') RETURNING id`);
  otherTenantId = o.rows[0].id;

  const u = await pool.query(
    `INSERT INTO app_user (tenant_id, email, password_hash, name, role)
     VALUES ($1, $2, 'x', 'The Owner', 'owner') RETURNING id`,
    [tenantId, `owner.${Date.now()}@example.test`],
  );
  ownerId = u.rows[0].id;
});

beforeEach(() => {
  service = new StaffService(db, audit);
});

after(async () => {
  for (const id of [tenantId, otherTenantId, ...spawnedTenants].filter(Boolean)) {
    await pool.query('DELETE FROM tenant WHERE id = $1', [id]);
  }
  await pool.end();
});

describe('invitations', () => {
  it('hands back a token once and stores only its hash', async () => {
    const invite = await service.invite(tenantId, ownerId, { email: email(), name: 'Desk One' });
    assert.ok(invite.token);

    const [row] = (await pool.query('SELECT * FROM staff_invite WHERE id = $1', [invite.id])).rows;
    // The raw token must not be recoverable from the database.
    assert.equal(row.token_hash, createHash('sha256').update(invite.token).digest('hex'));
    assert.ok(!JSON.stringify(row).includes(invite.token));
  });

  it('creates the login with the invited role when redeemed', async () => {
    const address = email();
    const invite = await service.invite(tenantId, ownerId, { email: address, name: 'Desk Two' });
    const user = await service.accept({ token: invite.token, password: 'a-long-password' });

    assert.equal(user.email, address);
    assert.equal(user.role, 'staff');
    assert.equal(user.tenantId, tenantId);
    assert.equal(user.isActive, true);
  });

  it('lets the invitation name an owner', async () => {
    const invite = await service.invite(tenantId, ownerId, {
      email: email(),
      name: 'Second Owner',
      role: 'owner',
    });
    const user = await service.accept({ token: invite.token, password: 'a-long-password' });
    assert.equal(user.role, 'owner');
  });

  it('cannot be redeemed twice', async () => {
    const invite = await service.invite(tenantId, ownerId, { email: email(), name: 'Desk Three' });
    await service.accept({ token: invite.token, password: 'a-long-password' });
    await assert.rejects(
      () => service.accept({ token: invite.token, password: 'another-password' }),
      /no longer valid|already been used/i,
    );
  });

  it('refuses two people racing the same link', async () => {
    const invite = await service.invite(tenantId, ownerId, { email: email(), name: 'Desk Four' });
    const results = await Promise.allSettled([
      service.accept({ token: invite.token, password: 'a-long-password' }),
      service.accept({ token: invite.token, password: 'a-long-password' }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  });

  it('refuses a revoked invitation', async () => {
    const invite = await service.invite(tenantId, ownerId, { email: email(), name: 'Desk Five' });
    await service.revokeInvite(tenantId, invite.id);
    await assert.rejects(
      () => service.accept({ token: invite.token, password: 'a-long-password' }),
      /no longer valid/i,
    );
  });

  it('refuses an expired invitation', async () => {
    const invite = await service.invite(tenantId, ownerId, { email: email(), name: 'Desk Six' });
    await pool.query(`UPDATE staff_invite SET expires_at = now() - interval '1 day' WHERE id = $1`, [
      invite.id,
    ]);
    await assert.rejects(
      () => service.accept({ token: invite.token, password: 'a-long-password' }),
      /no longer valid/i,
    );
  });

  it('says the same thing about a token that never existed', async () => {
    // Expired, revoked, used and invented must be indistinguishable, or this
    // becomes an oracle for guessing tokens.
    await assert.rejects(
      () => service.accept({ token: randomBytes(32).toString('base64url'), password: 'a-long-password' }),
      /no longer valid/i,
    );
  });

  it('refuses to invite an address that already has a login', async () => {
    const address = email();
    const invite = await service.invite(tenantId, ownerId, { email: address, name: 'Desk Seven' });
    await service.accept({ token: invite.token, password: 'a-long-password' });
    await assert.rejects(
      () => service.invite(tenantId, ownerId, { email: address, name: 'Again' }),
      /already has a login/i,
    );
  });

  it('refuses a second open invitation to the same address', async () => {
    const address = email();
    await service.invite(tenantId, ownerId, { email: address, name: 'Desk Eight' });
    await assert.rejects(
      () => service.invite(tenantId, ownerId, { email: address, name: 'Desk Eight' }),
      /already an invitation/i,
    );
  });

  it('does not list an invitation once it is spent', async () => {
    const invite = await service.invite(tenantId, ownerId, { email: email(), name: 'Desk Nine' });
    assert.ok((await service.pendingInvites(tenantId)).some((i) => i.id === invite.id));
    await service.accept({ token: invite.token, password: 'a-long-password' });
    assert.ok(!(await service.pendingInvites(tenantId)).some((i) => i.id === invite.id));
  });
});

describe('changing who can do what', () => {
  /** A tenant of its own, for the tests that count owners. */
  const freshBusiness = async () => {
    const t = await pool.query(`INSERT INTO tenant (name) VALUES ('__staff_solo__') RETURNING id`);
    const u = await pool.query(
      `INSERT INTO app_user (tenant_id, email, password_hash, name, role)
       VALUES ($1, $2, 'x', 'Sole Owner', 'owner') RETURNING id`,
      [t.rows[0].id, email()],
    );
    spawnedTenants.push(t.rows[0].id);
    return { tenantId: t.rows[0].id as string, ownerId: u.rows[0].id as string };
  };

  const makeStaff = async (role: 'owner' | 'staff' = 'staff') => {
    const invite = await service.invite(tenantId, ownerId, { email: email(), name: 'Someone', role });
    return service.accept({ token: invite.token, password: 'a-long-password' });
  };

  it('switches a login off without deleting the person', async () => {
    const staff = await makeStaff();
    const updated = await service.update(tenantId, ownerId, staff.id, { isActive: false });
    assert.equal(updated.isActive, false);

    const [row] = (await pool.query('SELECT * FROM app_user WHERE id = $1', [staff.id])).rows;
    assert.ok(row, 'the row is kept so their history still has a name against it');
    assert.ok(row.deactivated_at);
  });

  it('promotes and demotes', async () => {
    const staff = await makeStaff();
    assert.equal((await service.update(tenantId, ownerId, staff.id, { role: 'owner' })).role, 'owner');
    assert.equal((await service.update(tenantId, ownerId, staff.id, { role: 'staff' })).role, 'staff');
  });

  it('will not let anyone switch off their own login', async () => {
    await assert.rejects(
      () => service.update(tenantId, ownerId, ownerId, { isActive: false }),
      /your own login/i,
    );
  });

  it('will not let anyone change their own role', async () => {
    // Otherwise the last owner can quietly demote themselves and nobody is left
    // who can put it back.
    await assert.rejects(
      () => service.update(tenantId, ownerId, ownerId, { role: 'staff' }),
      /your own role/i,
    );
  });

  it('refuses to leave an account with no active owner', async () => {
    // Its own tenant: counting owners is only meaningful in a business whose
    // other tests have not left spare ones lying around.
    const solo = await freshBusiness();
    const second = await service.invite(solo.tenantId, solo.ownerId, {
      email: email(),
      name: 'Second Owner',
      role: 'owner',
    });
    const secondUser = await service.accept({ token: second.token, password: 'a-long-password' });

    // Two owners, so switching one off is fine...
    await service.update(solo.tenantId, secondUser.id, solo.ownerId, { isActive: false });

    // ...and now there is one left, so it is not — by deactivating...
    await assert.rejects(
      () => service.update(solo.tenantId, solo.ownerId, secondUser.id, { isActive: false }),
      /last active owner/i,
    );
    // ...or by demoting.
    await assert.rejects(
      () => service.update(solo.tenantId, solo.ownerId, secondUser.id, { role: 'staff' }),
      /last active owner/i,
    );
  });

  it('does not touch someone in another tenant', async () => {
    const stranger = await pool.query(
      `INSERT INTO app_user (tenant_id, email, password_hash, name, role)
       VALUES ($1, $2, 'x', 'Stranger', 'staff') RETURNING id`,
      [otherTenantId, email()],
    );
    await assert.rejects(
      () => service.update(tenantId, ownerId, stranger.rows[0].id, { isActive: false }),
      /No such person/i,
    );
  });
});

describe('row-level security on the new tables', () => {
  // The service scopes every query by tenant. This is the backstop for the
  // query that eventually forgets to.
  const direct = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

  after(() => direct.end());

  it('shows one tenant nothing of another tenant`s staff', async () => {
    await direct.query(`SET app.bypass_rls = 'off'`);
    await direct.query(`SET app.tenant_id = '${otherTenantId}'`);
    const seen = await direct.query('SELECT id FROM app_user WHERE tenant_id = $1', [tenantId]);
    assert.equal(seen.rowCount, 0);
  });

  it('refuses a write that would move a login to another tenant', async () => {
    await direct.query(`SET app.bypass_rls = 'off'`);
    await direct.query(`SET app.tenant_id = '${tenantId}'`);
    await assert.rejects(
      () =>
        direct.query('UPDATE app_user SET tenant_id = $1 WHERE id = $2', [otherTenantId, ownerId]),
      (err: { code?: string }) => err.code === RLS_VIOLATION,
    );
  });

  it('hides invitations from other tenants', async () => {
    await direct.query(`SET app.bypass_rls = 'on'`);
    await direct.query(
      `INSERT INTO staff_invite (tenant_id, email, name, token_hash, expires_at)
       VALUES ($1, $2, 'Theirs', $3, now() + interval '1 day')`,
      [otherTenantId, email(), randomBytes(16).toString('hex')],
    );
    await direct.query(`SET app.bypass_rls = 'off'`);
    await direct.query(`SET app.tenant_id = '${tenantId}'`);
    const seen = await direct.query('SELECT id FROM staff_invite WHERE tenant_id = $1', [
      otherTenantId,
    ]);
    assert.equal(seen.rowCount, 0);
  });

  it('shows nothing at all with no tenant set', async () => {
    await direct.query(`SET app.bypass_rls = 'off'`);
    await direct.query(`RESET app.tenant_id`);
    const seen = await direct.query('SELECT id FROM app_user LIMIT 1');
    assert.equal(seen.rowCount, 0);
  });
});
