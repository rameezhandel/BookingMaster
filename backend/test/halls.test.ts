/**
 * Halls: the rules that make them different from courts.
 *
 * The one worth stating is that an enquiry must not block the date. Venues let
 * three families consider the same November Saturday and take whoever commits;
 * a system that blocked on enquiry would either cost them bookings or teach
 * them to keep the real pipeline on paper. Only a tentative hold blocks, and it
 * expires in days rather than minutes.
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
import { EnquiriesService } from '../src/halls/enquiries.service';
import { CustomersService } from '../src/customers/customers.service';

loadEnv();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
pool.on('connect', (client) => {
  void client.query(`SET app.bypass_rls = 'on'`);
});
const db = drizzle(pool, { schema }) as unknown as Db;
const audit = { record: async () => undefined } as never;
const service = new EnquiriesService(db, audit, new CustomersService(db));

let tenantId: string;
let venueId: string;
let hallId: string;
let courtId: string;
let unique = 0;

/** A date far enough out that nothing else in the suite is near it. */
const dayAt = (offset: number) => {
  const d = new Date(Date.now() + (500 + offset) * 864e5);
  return d.toISOString().slice(0, 10);
};
const at = (day: string, hour: number) => `${day}T${String(hour).padStart(2, '0')}:00:00+05:30`;

const newEnquiry = (over: Record<string, unknown> = {}) =>
  service.create(tenantId, venueId, {
    contactName: `Family ${++unique}`,
    contactPhone: `+9198450${String(10000 + unique)}`,
    ...over,
  } as never);

before(async () => {
  const t = await pool.query(`INSERT INTO tenant (name) VALUES ('__halls_test__') RETURNING id`);
  tenantId = t.rows[0].id;
  const v = await pool.query(
    `INSERT INTO venue (tenant_id, name, timezone) VALUES ($1, 'Grand Gardens', 'Asia/Kolkata') RETURNING id`,
    [tenantId],
  );
  venueId = v.rows[0].id;
  const h = await pool.query(
    `INSERT INTO resource (tenant_id, venue_id, name, kind) VALUES ($1, $2, 'Banquet Lawn', 'hall') RETURNING id`,
    [tenantId, venueId],
  );
  hallId = h.rows[0].id;
  const c = await pool.query(
    `INSERT INTO resource (tenant_id, venue_id, name, kind, sport) VALUES ($1, $2, 'Court 1', 'court', 'badminton') RETURNING id`,
    [tenantId, venueId],
  );
  courtId = c.rows[0].id;
});

beforeEach(async () => {
  await pool.query('DELETE FROM enquiry WHERE tenant_id = $1', [tenantId]);
  await pool.query('DELETE FROM reservation WHERE tenant_id = $1', [tenantId]);
});

after(async () => {
  if (tenantId) await pool.query('DELETE FROM tenant WHERE id = $1', [tenantId]);
  await pool.end();
});

describe('an enquiry does not block the date', () => {
  it('lets three families enquire about the same Saturday', async () => {
    const saturday = dayAt(0);
    const all = await Promise.all([
      newEnquiry({ eventDate: saturday, resourceId: hallId }),
      newEnquiry({ eventDate: saturday, resourceId: hallId }),
      newEnquiry({ eventDate: saturday, resourceId: hallId }),
    ]);
    assert.equal(all.length, 3);

    // And none of them has touched the calendar.
    const held = await pool.query(
      `SELECT count(*)::int AS n FROM reservation WHERE tenant_id = $1`,
      [tenantId],
    );
    assert.equal(held.rows[0].n, 0, 'an enquiry must not create a reservation');
  });

  it('blocks only once one of them is held', async () => {
    const saturday = dayAt(1);
    const first = await newEnquiry({ eventDate: saturday });
    const second = await newEnquiry({ eventDate: saturday });

    await service.book(tenantId, first.id, {
      resourceId: hallId,
      eventStart: at(saturday, 18),
      eventEnd: at(saturday, 23),
      tentative: true,
      holdUntil: dayAt(-5),
    });

    // The second family can still be quoted — but not given the same date.
    await assert.rejects(
      () =>
        service.book(tenantId, second.id, {
          resourceId: hallId,
          eventStart: at(saturday, 18),
          eventEnd: at(saturday, 23),
        }),
      /already taken/i,
    );
  });
});

describe('a tentative hold', () => {
  it('expires in days, at the end of the day it names', async () => {
    const saturday = dayAt(10);
    const releaseOn = dayAt(3);
    const enquiry = await newEnquiry({ eventDate: saturday });

    const { reservation, enquiry: after } = await service.book(tenantId, enquiry.id, {
      resourceId: hallId,
      eventStart: at(saturday, 18),
      eventEnd: at(saturday, 23),
      tentative: true,
      holdUntil: releaseOn,
    });

    assert.equal(reservation.status, 'held');
    assert.ok(reservation.expiresAt);
    // "Held until the 12th" means through the 12th, not from midnight at its start.
    const expiry = reservation.expiresAt!.toISOString().slice(0, 10);
    assert.ok(
      expiry === releaseOn || expiry === dayAt(4),
      `expected the hold to run to the end of ${releaseOn}, got ${expiry}`,
    );
    // A hold is not a win. The family can still walk.
    assert.equal(after.status, 'quoted');
  });

  it('will not outlast the event it is holding', async () => {
    const saturday = dayAt(20);
    const enquiry = await newEnquiry({ eventDate: saturday });
    await assert.rejects(
      () =>
        service.book(tenantId, enquiry.id, {
          resourceId: hallId,
          eventStart: at(saturday, 18),
          eventEnd: at(saturday, 23),
          tentative: true,
          holdUntil: dayAt(25),
        }),
      /cannot outlast/i,
    );
  });

  it('will not be released on a date already gone', async () => {
    const saturday = dayAt(30);
    const enquiry = await newEnquiry({ eventDate: saturday });
    await assert.rejects(
      () =>
        service.book(tenantId, enquiry.id, {
          resourceId: hallId,
          eventStart: at(saturday, 18),
          eventEnd: at(saturday, 23),
          tentative: true,
          holdUntil: '2020-01-01',
        }),
      /already passed/i,
    );
  });
});

describe('the hall is held for longer than the event runs', () => {
  it('keeps the decorator’s evening and the event as separate facts', async () => {
    const saturday = dayAt(40);
    const friday = dayAt(39);
    const enquiry = await newEnquiry({ eventDate: saturday });

    const { reservation } = await service.book(tenantId, enquiry.id, {
      resourceId: hallId,
      eventStart: at(saturday, 18),
      eventEnd: at(saturday, 23),
      // The decorator wants it from six the evening before.
      accessStart: at(friday, 18),
      accessEnd: at(saturday, 23),
    });

    assert.ok(reservation.eventDuring, 'the event window is what an invoice quotes');
    assert.equal(reservation.eventDuring!.start.toISOString(), new Date(at(saturday, 18)).toISOString());
    // And the calendar is blocked from the evening before.
    assert.equal(reservation.during.start.toISOString(), new Date(at(friday, 18)).toISOString());
  });

  it('blocks the setup evening against anyone else', async () => {
    const saturday = dayAt(50);
    const friday = dayAt(49);
    const first = await newEnquiry({ eventDate: saturday });
    const second = await newEnquiry({ eventDate: friday });

    await service.book(tenantId, first.id, {
      resourceId: hallId,
      eventStart: at(saturday, 18),
      eventEnd: at(saturday, 23),
      accessStart: at(friday, 18),
      accessEnd: at(saturday, 23),
    });

    // A Friday-evening party now clashes with somebody's stage being built.
    await assert.rejects(
      () =>
        service.book(tenantId, second.id, {
          resourceId: hallId,
          eventStart: at(friday, 19),
          eventEnd: at(friday, 22),
        }),
      /already taken/i,
    );
  });

  it('refuses an event that falls outside the window it is held for', async () => {
    const saturday = dayAt(60);
    const enquiry = await newEnquiry({ eventDate: saturday });
    await assert.rejects(
      () =>
        service.book(tenantId, enquiry.id, {
          resourceId: hallId,
          eventStart: at(saturday, 10),
          eventEnd: at(saturday, 23),
          accessStart: at(saturday, 18),
          accessEnd: at(saturday, 23),
        }),
      /inside the window/i,
    );
  });
});

describe('the pipeline', () => {
  it('is won by producing a booking, not by saying so', async () => {
    const saturday = dayAt(70);
    const enquiry = await newEnquiry({ eventDate: saturday });

    // `won` is deliberately not settable: the pipeline and the calendar have to
    // agree, and the calendar is the one that is true.
    await assert.rejects(
      () => service.update(tenantId, enquiry.id, { status: 'won' as never }),
      /./,
    );

    const { enquiry: booked } = await service.book(tenantId, enquiry.id, {
      resourceId: hallId,
      eventStart: at(saturday, 18),
      eventEnd: at(saturday, 23),
    });
    assert.equal(booked.status, 'won');
    assert.ok(booked.reservationId);
  });

  it('will not be edited once it is booked', async () => {
    const saturday = dayAt(80);
    const enquiry = await newEnquiry({ eventDate: saturday });
    await service.book(tenantId, enquiry.id, {
      resourceId: hallId,
      eventStart: at(saturday, 18),
      eventEnd: at(saturday, 23),
    });
    await assert.rejects(
      () => service.update(tenantId, enquiry.id, { guestCount: 300 }),
      /booked/i,
    );
  });

  it('insists on a reason when one is lost', async () => {
    const enquiry = await newEnquiry();
    await assert.rejects(
      () => service.update(tenantId, enquiry.id, { status: 'lost' }),
      /why it was lost/i,
    );
    const lost = await service.update(tenantId, enquiry.id, {
      status: 'lost',
      lostReason: 'Went with a cheaper hall',
    });
    assert.equal(lost.status, 'lost');
  });

  it('schedules a visit without needing the status said twice', async () => {
    const enquiry = await newEnquiry();
    const updated = await service.update(tenantId, enquiry.id, {
      visitAt: new Date(Date.now() + 3 * 864e5).toISOString(),
    });
    assert.equal(updated.status, 'visit_scheduled');
  });

  it('shows the open ones by default and the rest on request', async () => {
    await newEnquiry();
    const lost = await newEnquiry();
    await service.update(tenantId, lost.id, { status: 'lost', lostReason: 'Budget' });

    const open = await service.list(tenantId, venueId);
    assert.equal(open.length, 1);
    const all = await service.list(tenantId, venueId, { includeClosed: true });
    assert.equal(all.length, 2);
  });

  it('refuses to book a court as though it were a hall', async () => {
    const saturday = dayAt(90);
    const enquiry = await newEnquiry({ eventDate: saturday });
    await assert.rejects(
      () =>
        service.book(tenantId, enquiry.id, {
          resourceId: courtId,
          eventStart: at(saturday, 18),
          eventEnd: at(saturday, 23),
        }),
      /is a court, not a hall/i,
    );
  });
});

describe('availability', () => {
  it('answers "is the 14th free?" per hall', async () => {
    const saturday = dayAt(100);
    const enquiry = await newEnquiry({ eventDate: saturday });
    await service.book(tenantId, enquiry.id, {
      resourceId: hallId,
      eventStart: at(saturday, 18),
      eventEnd: at(saturday, 23),
    });

    const result = await service.availability(tenantId, venueId, dayAt(95), dayAt(105));
    const hall = result.halls.find((h) => h.id === hallId)!;
    assert.equal(hall.bookings.length, 1);
    assert.equal(hall.bookings[0].from, saturday);
    assert.equal(hall.bookings[0].status, 'confirmed');
    // Courts are not halls and do not belong in this answer.
    assert.ok(!result.halls.some((h) => h.id === courtId));
  });

  /**
   * The range in the database is half-open; the answer on the phone is not.
   * Reporting the first free day as taken would lose the venue the next
   * evening's booking, every time a reception runs past midnight.
   */
  it('reports the last day the hall is occupied, not the first day it is free', async () => {
    const friday = dayAt(140);
    const saturday = dayAt(141);
    const enquiry = await newEnquiry({ eventDate: friday });
    await service.book(tenantId, enquiry.id, {
      resourceId: hallId,
      eventStart: at(friday, 20),
      // Ends at midnight exactly: the hall is free all of Saturday.
      eventEnd: at(saturday, 0),
    });

    const result = await service.availability(tenantId, venueId, dayAt(138), dayAt(145));
    const booking = result.halls.find((h) => h.id === hallId)!.bookings[0];
    assert.equal(booking.from, friday);
    assert.equal(booking.to, friday);
  });

  it('says when a tentative hold is released', async () => {
    const saturday = dayAt(120);
    const enquiry = await newEnquiry({ eventDate: saturday });
    await service.book(tenantId, enquiry.id, {
      resourceId: hallId,
      eventStart: at(saturday, 18),
      eventEnd: at(saturday, 23),
      tentative: true,
      holdUntil: dayAt(110),
    });

    const result = await service.availability(tenantId, venueId, dayAt(115), dayAt(125));
    const booking = result.halls.find((h) => h.id === hallId)!.bookings[0];
    assert.equal(booking.status, 'held');
    assert.ok(booking.holdUntil, 'a held date should say when it frees up');
  });
});
