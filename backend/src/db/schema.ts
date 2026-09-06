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
    // Opening hours live in resourceHourRules; a court can keep different hours
    // on each weekday and more than one window per day.
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ venueIdx: index('resource_venue_idx').on(t.venueId, t.sortOrder) }),
);

export const resourceHourRules = pgTable(
  'resource_hour_rule',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    resourceId: uuid('resource_id').notNull(),
    /** 0 = Sunday .. 6 = Saturday. */
    dayOfWeek: smallint('day_of_week').notNull(),
    opensAt: time('opens_at').notNull(),
    closesAt: time('closes_at').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ resourceIdx: index('resource_hour_rule_resource_idx').on(t.resourceId, t.dayOfWeek) }),
);

/** A holiday, an early close, a tournament day. resourceId null = whole venue. */
export const venueDateOverrides = pgTable(
  'venue_date_override',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    venueId: uuid('venue_id').notNull(),
    resourceId: uuid('resource_id'),
    onDate: date('on_date').notNull(),
    isClosed: boolean('is_closed').notNull().default(true),
    opensAt: time('opens_at'),
    closesAt: time('closes_at'),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ lookupIdx: index('venue_date_override_lookup_idx').on(t.venueId, t.onDate) }),
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
    /** Set when this booking was produced by a recurring series. */
    seriesId: uuid('series_id'),
    occurrenceDate: date('occurrence_date'),
    createdBy: uuid('created_by'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /** What the policy decided at the moment of cancelling, kept for the record. */
    cancellationRefundPct: smallint('cancellation_refund_pct'),
    cancellationRefundPaise: bigint('cancellation_refund_paise', { mode: 'number' }),
    cancellationReason: text('cancellation_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ tenantCreatedIdx: index('reservation_tenant_created_idx').on(t.tenantId, t.createdAt) }),
);

export const cancellationTiers = pgTable(
  'cancellation_tier',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    venueId: uuid('venue_id').notNull(),
    /** "Cancel at least this many hours before the start..." */
    minHoursBefore: integer('min_hours_before').notNull(),
    /** "...and get this percentage back." */
    refundPct: smallint('refund_pct').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ venueIdx: index('cancellation_tier_venue_idx').on(t.venueId, t.minHoursBefore) }),
);

export const bookingSeries = pgTable(
  'booking_series',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    venueId: uuid('venue_id').notNull(),
    resourceId: uuid('resource_id').notNull(),
    customerId: uuid('customer_id'),
    /** 0 = Sunday .. 6 = Saturday. */
    dayOfWeek: smallint('day_of_week').notNull(),
    startsAt: time('starts_at').notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on'),
    /** null = price each occurrence from the price rules as it is created. */
    amountPaise: bigint('amount_paise', { mode: 'number' }),
    notes: text('notes'),
    status: text('status').$type<'active' | 'ended'>().notNull().default('active'),
    materialisedThrough: date('materialised_through'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ tenantIdx: index('booking_series_tenant_idx').on(t.tenantId, t.status) }),
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
