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
import {
  cancellationTiers,
  customers,
  payments,
  priceRules,
  reservations,
  resourceHourRules,
  resources,
  tenants,
  users,
  venueDateOverrides,
  venues,
} from './schema';

loadEnv();

const DEMO_EMAIL = 'owner@smasharena.test';
const DEMO_PASSWORD = 'bookingmaster';
const TZ = 'Asia/Kolkata';

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set.');

  // One connection, because the RLS bypass below is a session setting and
  // would not follow the seed onto a second pooled connection.
  const pool = new Pool({ connectionString, max: 1 });
  const db = drizzle(pool, { schema });

  try {
    // Seeding creates tenants, so it cannot be scoped to one. Row-level
    // security is opted out of explicitly rather than by accident.
    await pool.query(`SET app.bypass_rls = 'on'`);

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
        slug: 'smash-arena-hsr',
        isPublished: true,
      })
      .returning();

    const courtSpecs = [
      { name: 'Court 1', sport: 'badminton', slotMinutes: 60, weekday: ['06:00', '23:00'], weekend: ['05:00', '23:00'] },
      { name: 'Court 2', sport: 'badminton', slotMinutes: 60, weekday: ['06:00', '23:00'], weekend: ['05:00', '23:00'] },
      // Blocked out for a school every weekday afternoon: the split day the old
      // single opens/closes pair could not express.
      { name: 'Court 3', sport: 'badminton', slotMinutes: 60, weekday: ['06:00', '13:00'], weekdayEvening: ['17:00', '23:00'], weekend: ['06:00', '23:00'] },
      { name: 'Box Cricket Turf', sport: 'cricket', slotMinutes: 60, weekday: ['06:00', '24:00'], weekend: ['06:00', '24:00'] },
      { name: 'Tennis Court', sport: 'tennis', slotMinutes: 60, weekday: ['06:00', '22:00'], weekend: ['06:00', '22:00'] },
    ];

    const courts = await db
      .insert(resources)
      .values(
        courtSpecs.map((spec, i) => ({
          tenantId: tenant.id,
          venueId: venue.id,
          sortOrder: i,
          name: spec.name,
          sport: spec.sport,
          slotMinutes: spec.slotMinutes,
        })),
      )
      .returning();

    // Weekday and weekend hours differ, which is true of nearly every venue.
    for (const [i, court] of courts.entries()) {
      const spec = courtSpecs[i];
      const windows: { dayOfWeek: number; opensAt: string; closesAt: string }[] = [];

      for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        if (isWeekend) {
          windows.push({ dayOfWeek, opensAt: spec.weekend[0], closesAt: spec.weekend[1] });
        } else {
          windows.push({ dayOfWeek, opensAt: spec.weekday[0], closesAt: spec.weekday[1] });
          if (spec.weekdayEvening) {
            windows.push({
              dayOfWeek,
              opensAt: spec.weekdayEvening[0],
              closesAt: spec.weekdayEvening[1],
            });
          }
        }
      }

      await db.insert(resourceHourRules).values(
        windows.map((w) => ({ tenantId: tenant.id, resourceId: court.id, ...w })),
      );
    }

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

    // The policy most venues describe out loud: full refund a day out, half
    // inside that, nothing once it is close.
    await db.insert(cancellationTiers).values([
      { tenantId: tenant.id, venueId: venue.id, minHoursBefore: 24, refundPct: 100 },
      { tenantId: tenant.id, venueId: venue.id, minHoursBefore: 12, refundPct: 50 },
      { tenantId: tenant.id, venueId: venue.id, minHoursBefore: 0, refundPct: 0 },
    ]);

    // A holiday closure and a court that opens late that day, so the override
    // layering is visible in the seeded data.
    const holiday = today.plus({ days: 5 });
    await db.insert(venueDateOverrides).values({
      tenantId: tenant.id,
      venueId: venue.id,
      onDate: holiday.toISODate()!,
      isClosed: true,
      reason: 'Diwali',
    });
    await db.insert(venueDateOverrides).values({
      tenantId: tenant.id,
      venueId: venue.id,
      resourceId: courts[3].id,
      onDate: holiday.toISODate()!,
      isClosed: false,
      opensAt: '18:00',
      closesAt: '23:00',
      reason: 'Evening only',
    });

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
    console.log(`  closed   ${holiday.toISODate()} (Diwali), turf open 18:00-23:00`);
    console.log(`  login    ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
    console.log(`  public   /v/${venue.slug}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
