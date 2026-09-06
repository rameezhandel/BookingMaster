/**
 * Seeds a demo venue so the calendar has something in it on first run.
 * Safe to re-run: it removes the previous demo tenant first.
 */
import * as bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { DateTime } from 'luxon';
import { Pool } from 'pg';
import { loadEnv } from './env';
import * as schema from './schema';
import { customers, priceRules, reservations, resources, tenants, users, venues, payments } from './schema';

loadEnv();

const DEMO_EMAIL = 'owner@smasharena.test';
const DEMO_PASSWORD = 'bookingmaster';
const TZ = 'Asia/Kolkata';

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set.');

  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  try {
    const [existing] = await db.select().from(users).where(eq(users.email, DEMO_EMAIL)).limit(1);
    if (existing) {
      await db.delete(tenants).where(eq(tenants.id, existing.tenantId));
      console.log('Removed previous demo tenant.');
    }

    const [tenant] = await db.insert(tenants).values({ name: 'Smash Arena' }).returning();
    await db.insert(users).values({
      tenantId: tenant.id,
      email: DEMO_EMAIL,
      passwordHash: await bcrypt.hash(DEMO_PASSWORD, 12),
      name: 'Rameez',
      role: 'owner',
    });

    const [venue] = await db
      .insert(venues)
      .values({
        tenantId: tenant.id,
        name: 'Smash Arena, HSR Layout',
        timezone: TZ,
        address: '27th Main, HSR Layout Sector 2, Bengaluru 560102',
        phone: '+919876500000',
      })
      .returning();

    const courtSpecs = [
      { name: 'Court 1', sport: 'badminton', slotMinutes: 60, opensAt: '06:00', closesAt: '23:00' },
      { name: 'Court 2', sport: 'badminton', slotMinutes: 60, opensAt: '06:00', closesAt: '23:00' },
      { name: 'Court 3', sport: 'badminton', slotMinutes: 60, opensAt: '06:00', closesAt: '23:00' },
      { name: 'Box Cricket Turf', sport: 'cricket', slotMinutes: 60, opensAt: '06:00', closesAt: '24:00' },
      { name: 'Tennis Court', sport: 'tennis', slotMinutes: 60, opensAt: '06:00', closesAt: '22:00' },
    ];

    const courts = await db
      .insert(resources)
      .values(
        courtSpecs.map((spec, i) => ({
          tenantId: tenant.id,
          venueId: venue.id,
          sortOrder: i,
          ...spec,
        })),
      )
      .returning();

    // Base rate everywhere, then evening peak and a weekend premium on top.
    // Higher priority wins, so the layering reads the way an owner describes it.
    for (const court of courts) {
      const base = court.sport === 'cricket' ? 120000 : court.sport === 'tennis' ? 60000 : 50000;
      await db.insert(priceRules).values([
        {
          tenantId: tenant.id,
          resourceId: court.id,
          name: 'Base rate',
          dowMask: 127,
          startsAt: '00:00',
          endsAt: '24:00',
          pricePerHourPaise: base,
          priority: 0,
        },
        {
          tenantId: tenant.id,
          resourceId: court.id,
          name: 'Evening peak',
          dowMask: 127,
          startsAt: '18:00',
          endsAt: '23:00',
          pricePerHourPaise: Math.round(base * 1.5),
          priority: 10,
        },
        {
          tenantId: tenant.id,
          resourceId: court.id,
          name: 'Weekend',
          // Saturday (6) and Sunday (0).
          dowMask: (1 << 0) | (1 << 6),
          startsAt: '06:00',
          endsAt: '23:00',
          pricePerHourPaise: Math.round(base * 1.8),
          priority: 20,
        },
      ]);
    }

    const people = await db
      .insert(customers)
      .values([
        { tenantId: tenant.id, name: 'Arjun Nair', phone: '+919845012345' },
        { tenantId: tenant.id, name: 'Priya Sharma', phone: '+919845067890' },
        { tenantId: tenant.id, name: 'Faisal Khan', phone: '+919845011223', notes: 'Books every Tuesday' },
        { tenantId: tenant.id, name: 'Deepa Rao', phone: '+919845099887' },
      ])
      .returning();

    const today = DateTime.now().setZone(TZ).startOf('day');
    const slot = (dayOffset: number, hour: number, minutes = 60) => ({
      start: today.plus({ days: dayOffset, hours: hour }).toJSDate(),
      end: today.plus({ days: dayOffset, hours: hour, minutes }).toJSDate(),
    });

    const plan = [
      { court: 0, day: 0, hour: 7, person: 0, status: 'confirmed' as const, paid: true },
      { court: 0, day: 0, hour: 19, person: 1, status: 'confirmed' as const, paid: true },
      { court: 0, day: 0, hour: 20, person: 2, status: 'confirmed' as const, paid: false },
      { court: 1, day: 0, hour: 19, person: 3, status: 'confirmed' as const, paid: true },
      { court: 3, day: 0, hour: 21, person: 0, status: 'confirmed' as const, paid: false },
      { court: 0, day: 1, hour: 18, person: 2, status: 'confirmed' as const, paid: false },
      { court: 1, day: 1, hour: 20, person: 1, status: 'confirmed' as const, paid: true },
      { court: 4, day: 2, hour: 8, person: 3, status: 'confirmed' as const, paid: false },
      { court: 0, day: -1, hour: 19, person: 0, status: 'completed' as const, paid: true },
      { court: 1, day: -1, hour: 20, person: 1, status: 'no_show' as const, paid: false },
    ];

    for (const entry of plan) {
      const court = courts[entry.court];
      const interval = slot(entry.day, entry.hour);
      const isWeekend = [0, 6].includes(DateTime.fromJSDate(interval.start, { zone: TZ }).weekday % 7);
      const base = court.sport === 'cricket' ? 120000 : court.sport === 'tennis' ? 60000 : 50000;
      const amountPaise = isWeekend
        ? Math.round(base * 1.8)
        : entry.hour >= 18
          ? Math.round(base * 1.5)
          : base;

      const [booking] = await db
        .insert(reservations)
        .values({
          tenantId: tenant.id,
          venueId: venue.id,
          resourceId: court.id,
          kind: 'booking',
          status: entry.status,
          during: interval,
          customerId: people[entry.person].id,
          amountPaise,
        })
        .returning();

      if (entry.paid) {
        await db.insert(payments).values({
          tenantId: tenant.id,
          reservationId: booking.id,
          amountPaise,
          method: entry.hour % 2 === 0 ? 'upi' : 'cash',
          direction: 'in',
          receivedAt: interval.start,
        });
      }
    }

    // A maintenance block, so the calendar shows both kinds of occupancy.
    await db.insert(reservations).values({
      tenantId: tenant.id,
      venueId: venue.id,
      resourceId: courts[2].id,
      kind: 'block',
      status: 'blocked',
      during: {
        start: today.plus({ days: 1, hours: 6 }).toJSDate(),
        end: today.plus({ days: 1, hours: 12 }).toJSDate(),
      },
      blockReason: 'Floor re-taping',
    });

    console.log('\nSeeded demo data.');
    console.log(`  venue    ${venue.name}`);
    console.log(`  courts   ${courts.length}`);
    console.log(`  login    ${DEMO_EMAIL} / ${DEMO_PASSWORD}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
