import {
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * A Postgres `tstzrange`, surfaced to TypeScript as a half-open [start, end)
 * interval. Half-open is what makes 19:00-20:00 and 20:00-21:00 adjacent rather
 * than overlapping, so it is hardcoded here on purpose.
 */
export const tstzrange = customType<{
  data: { start: Date; end: Date };
  driverData: string;
}>({
  dataType() {
    return 'tstzrange';
  },
  toDriver(value) {
    return `[${value.start.toISOString()},${value.end.toISOString()})`;
  },
  fromDriver(value) {
    const match = /^[[(](.*),(.*)[\])]$/.exec(value);
    if (!match) throw new Error(`Unparseable tstzrange: ${value}`);
    const unquote = (s: string) => s.replace(/^"|"$/g, '');
    return {
      start: new Date(unquote(match[1])),
      end: new Date(unquote(match[2])),
    };
  },
});

export const tenants = pgTable('tenant', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  'app_user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    role: text('role').$type<'owner' | 'staff'>().notNull().default('owner'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ tenantIdx: index('app_user_tenant_idx').on(t.tenantId) }),
);

export const venues = pgTable(
  'venue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    address: text('address'),
    phone: text('phone'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ tenantIdx: index('venue_tenant_idx').on(t.tenantId) }),
);

export const resources = pgTable(
  'resource',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    venueId: uuid('venue_id').notNull(),
    name: text('name').notNull(),
    sport: text('sport').notNull(),
    slotMinutes: integer('slot_minutes').notNull().default(60),
    opensAt: time('opens_at').notNull().default('06:00'),
    closesAt: time('closes_at').notNull().default('23:00'),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ venueIdx: index('resource_venue_idx').on(t.venueId, t.sortOrder) }),
);

export const priceRules = pgTable(
  'price_rule',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    resourceId: uuid('resource_id').notNull(),
    name: text('name').notNull(),
    /** Bit 0 = Sunday .. bit 6 = Saturday. 127 = every day. */
    dowMask: smallint('dow_mask').notNull().default(127),
    startsAt: time('starts_at').notNull().default('00:00'),
    endsAt: time('ends_at').notNull().default('24:00'),
    pricePerHourPaise: bigint('price_per_hour_paise', { mode: 'number' }).notNull(),
    priority: integer('priority').notNull().default(0),
    validFrom: date('valid_from'),
    validTo: date('valid_to'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ resourceIdx: index('price_rule_resource_idx').on(t.resourceId, t.priority) }),
);

export const customers = pgTable(
  'customer',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    phone: text('phone').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ tenantPhoneKey: uniqueIndex('customer_tenant_phone_key').on(t.tenantId, t.phone) }),
);

export type ReservationStatus =
  | 'held'
  | 'confirmed'
  | 'completed'
  | 'cancelled'
  | 'no_show'
  | 'blocked';

export const reservations = pgTable(
  'reservation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    venueId: uuid('venue_id').notNull(),
    resourceId: uuid('resource_id').notNull(),
    kind: text('kind').$type<'booking' | 'block'>().notNull(),
    status: text('status').$type<ReservationStatus>().notNull(),
    during: tstzrange('during').notNull(),
    customerId: uuid('customer_id'),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull().default(0),
    notes: text('notes'),
    blockReason: text('block_reason'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ tenantCreatedIdx: index('reservation_tenant_created_idx').on(t.tenantId, t.createdAt) }),
);

export const payments = pgTable(
  'payment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    reservationId: uuid('reservation_id').notNull(),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    direction: text('direction').$type<'in' | 'refund'>().notNull().default('in'),
    method: text('method')
      .$type<'cash' | 'upi' | 'card' | 'bank_transfer' | 'other'>()
      .notNull(),
    reference: text('reference'),
    note: text('note'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ reservationIdx: index('payment_reservation_idx').on(t.reservationId) }),
);

/** Statuses that occupy a court, matching the partial exclusion constraint. */
export const OCCUPYING_STATUSES: ReservationStatus[] = ['held', 'confirmed', 'completed', 'blocked'];
