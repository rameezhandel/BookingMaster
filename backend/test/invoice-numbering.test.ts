/**
 * The invoice series, under the two things that break numbering.
 *
 * A gap in a tax invoice series is a question somebody has to answer during a
 * return, and there is no good answer. The two ways to create one are a
 * sequence that hands out numbers outside transaction control — so a rollback
 * burns one — and a `max(seq) + 1` read that two callers make at once.
 *
 * These tests exist so that the fix (a locked counter row, incremented in the
 * transaction that writes the invoice) is not quietly replaced by a Postgres
 * sequence, which is the obvious tool and the wrong one.
 *
 * Requires DATABASE_URL and a migrated database.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../src/db/schema';
import { loadEnv } from '../src/db/env';
import type { Db } from '../src/db/database.module';
import { InvoicesService } from '../src/invoicing/invoices.service';

loadEnv();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
pool.on('connect', (client) => {
  void client.query(`SET app.bypass_rls = 'on'`);
});
const db = drizzle(pool, { schema }) as unknown as Db;
const audit = { record: async () => undefined } as never;
const service = new InvoicesService(db, audit);

let tenantId: string;
let venueId: string;
let courtId: string;
let customerId: string;
let court = 0;

/** A confirmed booking on its own court, so nothing collides. */
async function makeBooking(hoursOut: number, amountPaise = 50_000) {
  const c = await pool.query(
    `INSERT INTO resource (tenant_id, venue_id, name, sport) VALUES ($1, $2, $3, 'badminton') RETURNING id`,
    [tenantId, venueId, `Court ${++court}`],
  );
  const r = await pool.query(
    `INSERT INTO reservation (tenant_id, venue_id, resource_id, customer_id, kind, status, during, amount_paise)
     VALUES ($1, $2, $3, $4, 'booking', 'confirmed',
             tstzrange(now() + make_interval(hours => $5), now() + make_interval(hours => $5 + 1), '[)'), $6)
     RETURNING id`,
    [tenantId, venueId, c.rows[0].id, customerId, hoursOut, amountPaise],
  );
  return r.rows[0].id as string;
}

const numbersIssued = async () =>
  (
    await pool.query(
      'SELECT seq FROM invoice WHERE tenant_id = $1 ORDER BY seq',
      [tenantId],
    )
  ).rows.map((r) => Number(r.seq));

before(async () => {
  const t = await pool.query(`INSERT INTO tenant (name) VALUES ('__invoice_test__') RETURNING id`);
  tenantId = t.rows[0].id;
  const v = await pool.query(
    `INSERT INTO venue (tenant_id, name, timezone, invoicing_enabled, gstin, state_code,
                        gst_rate_bp, prices_include_gst, invoice_prefix, legal_name)
     VALUES ($1, 'Numbering Arena', 'Asia/Kolkata', true, '29AABCU9603R1ZM', '29',
             1800, true, 'NA', 'Numbering Arena Pvt Ltd')
     RETURNING id`,
    [tenantId],
  );
  venueId = v.rows[0].id;
  const cust = await pool.query(
    `INSERT INTO customer (tenant_id, name, phone) VALUES ($1, 'Arjun Nair', '+919845000111') RETURNING id`,
    [tenantId],
  );
  customerId = cust.rows[0].id;
});

after(async () => {
  if (tenantId) await pool.query('DELETE FROM tenant WHERE id = $1', [tenantId]);
  await pool.end();
});

describe('the invoice series', () => {
  it('numbers consecutively from one', async () => {
    for (let i = 0; i < 3; i++) {
      const invoice = await service.issueForReservation(tenantId, await makeBooking(10 + i));
      assert.equal(invoice.seq, i + 1);
      assert.match(invoice.number, /^NA\/\d{4}-\d{2}\/000\d$/);
    }
    assert.deepEqual(await numbersIssued(), [1, 2, 3]);
  });

  it('leaves no gap when ten invoices are issued at once', async () => {
    const before = (await numbersIssued()).length;
    const bookings = await Promise.all(
      Array.from({ length: 10 }, (_, i) => makeBooking(100 + i)),
    );

    // All at once, on separate connections. A max(seq)+1 read would hand the
    // same number to several of these.
    const issued = await Promise.all(
      bookings.map((id) => service.issueForReservation(tenantId, id)),
    );

    const seqs = issued.map((i) => i.seq).sort((a, b) => a - b);
    assert.equal(new Set(seqs).size, 10, 'a number was handed out twice');

    const all = await numbersIssued();
    assert.equal(all.length, before + 10);
    // The whole series, unbroken, from one to however many exist.
    assert.deepEqual(all, Array.from({ length: all.length }, (_, i) => i + 1));
  });

  it('gives the number back when the transaction that took it rolls back', async () => {
    const before = await numbersIssued();
    const next = before.length + 1;

    // The counter is taken exactly the way the service takes it, on its own
    // connection, and then thrown away. With a Postgres sequence this would
    // burn `next` and the following invoice would skip to `next + 1`.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT next_seq FROM invoice_series
         WHERE tenant_id = $1 AND venue_id = $2 AND financial_year = $3
         FOR UPDATE`,
        [tenantId, venueId, currentYear()],
      );
      assert.equal(Number(locked.rows[0].next_seq), next);
      await client.query(
        `UPDATE invoice_series SET next_seq = next_seq + 1
         WHERE tenant_id = $1 AND venue_id = $2 AND financial_year = $3`,
        [tenantId, venueId, currentYear()],
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // The next real invoice takes the same number: nothing was burned.
    const invoice = await service.issueForReservation(tenantId, await makeBooking(300));
    assert.equal(invoice.seq, next);
    assert.deepEqual(await numbersIssued(), [...before, next]);
  });

  it('refuses a second invoice for the same booking', async () => {
    const booking = await makeBooking(400);
    await service.issueForReservation(tenantId, booking);
    await assert.rejects(
      () => service.issueForReservation(tenantId, booking),
      /already been issued/i,
    );
  });

  it('will not invoice a cancelled booking', async () => {
    const booking = await makeBooking(500);
    await pool.query(`UPDATE reservation SET status = 'cancelled' WHERE id = $1`, [booking]);
    await assert.rejects(() => service.issueForReservation(tenantId, booking), /cancelled/i);
  });

  it('will not invoice at all when the venue has no GSTIN', async () => {
    const booking = await makeBooking(600);
    await pool.query(`UPDATE venue SET invoicing_enabled = false WHERE id = $1`, [venueId]);
    await assert.rejects(
      () => service.issueForReservation(tenantId, booking),
      /not set up to issue tax invoices/i,
    );
    await pool.query(`UPDATE venue SET invoicing_enabled = true WHERE id = $1`, [venueId]);
  });
});

describe('an issued invoice', () => {
  it('cannot be edited or deleted, even directly', async () => {
    const invoice = await service.issueForReservation(tenantId, await makeBooking(700));

    // Under the tenant's own role, not the bypass this suite otherwise uses.
    const asTenant = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    await asTenant.query(`SET app.bypass_rls = 'off'`);
    await asTenant.query(`SET app.tenant_id = '${tenantId}'`);

    const edited = await asTenant.query('UPDATE invoice SET total_paise = 1 WHERE id = $1', [
      invoice.id,
    ]);
    assert.equal(edited.rowCount, 0, 'an issued invoice must not be editable');

    const deleted = await asTenant.query('DELETE FROM invoice WHERE id = $1', [invoice.id]);
    assert.equal(deleted.rowCount, 0, 'an issued invoice must not be deletable');
    await asTenant.end();
  });

  it('is reversed by a credit note that takes the next number', async () => {
    const invoice = await service.issueForReservation(tenantId, await makeBooking(800));
    const note = await service.creditNoteFor(tenantId, invoice.id, 'Booking cancelled');

    assert.equal(note.kind, 'credit_note');
    assert.equal(note.reversesId, invoice.id);
    assert.equal(note.seq, invoice.seq + 1);
    // It reverses the same money, so the two net to nothing.
    assert.equal(note.totalPaise, invoice.totalPaise);
    assert.match(note.description, /Credit note against/);

    await assert.rejects(() => service.creditNoteFor(tenantId, invoice.id), /already been issued/i);
  });

  it('still goes when its tenant does, so an account can be closed', async () => {
    // The no-delete policy must not make a tenant undeletable. Cascades run as
    // the table owner and are not filtered by row policies — checked here
    // because "you can never close an account" would be a nasty thing to
    // discover from a customer.
    const t = await pool.query(`INSERT INTO tenant (name) VALUES ('__cascade__') RETURNING id`);
    const other = t.rows[0].id;
    const v = await pool.query(
      `INSERT INTO venue (tenant_id, name) VALUES ($1, 'Cascade Venue') RETURNING id`,
      [other],
    );
    await pool.query(
      `INSERT INTO invoice (tenant_id, venue_id, financial_year, seq, number, supplier_name,
                            description, gst_rate_bp, taxable_paise, cgst_paise, sgst_paise, total_paise)
       VALUES ($1, $2, '2026-27', 1, 'CC/2026-27/0001', 'Cascade Ltd', 'test', 1800, 100, 9, 9, 118)`,
      [other, v.rows[0].id],
    );

    await pool.query('DELETE FROM tenant WHERE id = $1', [other]);
    const left = await pool.query('SELECT count(*)::int AS n FROM invoice WHERE tenant_id = $1', [other]);
    assert.equal(left.rows[0].n, 0);
  });

  it('records the supplier as it was, not as it later becomes', async () => {
    const invoice = await service.issueForReservation(tenantId, await makeBooking(900));
    assert.equal(invoice.supplierName, 'Numbering Arena Pvt Ltd');

    await pool.query(`UPDATE venue SET legal_name = 'Renamed Sports LLP' WHERE id = $1`, [venueId]);
    const [after] = await pool.query('SELECT supplier_name FROM invoice WHERE id = $1', [invoice.id])
      .then((r) => r.rows);
    assert.equal(
      after.supplier_name,
      'Numbering Arena Pvt Ltd',
      'a document already handed over must not change when the venue does',
    );
  });
});

function currentYear() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === 'year')!.value);
  const m = Number(parts.find((p) => p.type === 'month')!.value);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
