-- BookingMaster :: Phase 0 schema
--
-- Design notes that are load-bearing (see README):
--   * Every tenant-owned row carries tenant_id from the very first migration.
--   * Money is bigint paise. Never floats, never rupees.
--   * Occupancy lives in ONE table (reservation) as a tstzrange, so bookings and
--     maintenance blocks travel the same code path.
--   * Overlap is prevented by the database, not by application code. See
--     reservation_no_overlap at the bottom of this file.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- tenancy --

CREATE TABLE tenant (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER tenant_updated_at BEFORE UPDATE ON tenant
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  email         text NOT NULL,
  password_hash text NOT NULL,
  name          text NOT NULL,
  role          text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'staff')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Login is by email alone, so it has to be unique across tenants.
CREATE UNIQUE INDEX app_user_email_key ON app_user (lower(email));
CREATE INDEX app_user_tenant_idx ON app_user (tenant_id);
CREATE TRIGGER app_user_updated_at BEFORE UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------- venues --

CREATE TABLE venue (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name       text NOT NULL,
  -- IANA zone. India has no DST, but slot maths is done in venue-local time so
  -- that a second market does not require a migration.
  timezone   text NOT NULL DEFAULT 'Asia/Kolkata',
  address    text,
  phone      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX venue_tenant_idx ON venue (tenant_id);
CREATE TRIGGER venue_updated_at BEFORE UPDATE ON venue
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A bookable unit: one court, one turf, one lane.
CREATE TABLE resource (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  venue_id     uuid NOT NULL REFERENCES venue(id) ON DELETE CASCADE,
  name         text NOT NULL,
  sport        text NOT NULL,
  slot_minutes integer NOT NULL DEFAULT 60 CHECK (slot_minutes IN (30, 60, 90, 120)),
  -- Opening hours are stored as rules and slots are generated on read. There is
  -- deliberately no materialised slots table.
  opens_at     time NOT NULL DEFAULT '06:00',
  closes_at    time NOT NULL DEFAULT '23:00',
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resource_hours_ordered CHECK (closes_at > opens_at)
);
CREATE INDEX resource_venue_idx ON resource (venue_id, sort_order);
CREATE INDEX resource_tenant_idx ON resource (tenant_id);
CREATE TRIGGER resource_updated_at BEFORE UPDATE ON resource
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- pricing --

-- Rules as data, not as branches in code. Highest priority match wins.
CREATE TABLE price_rule (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  resource_id         uuid NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  name                text NOT NULL,
  -- Bitmask over days, bit 0 = Sunday .. bit 6 = Saturday. 127 = every day.
  dow_mask            smallint NOT NULL DEFAULT 127 CHECK (dow_mask BETWEEN 0 AND 127),
  starts_at           time NOT NULL DEFAULT '00:00',
  ends_at             time NOT NULL DEFAULT '24:00',
  price_per_hour_paise bigint NOT NULL CHECK (price_per_hour_paise >= 0),
  priority            integer NOT NULL DEFAULT 0,
  valid_from          date,
  valid_to            date,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_rule_window_ordered CHECK (ends_at > starts_at),
  CONSTRAINT price_rule_dates_ordered CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX price_rule_resource_idx ON price_rule (resource_id, priority DESC);
CREATE TRIGGER price_rule_updated_at BEFORE UPDATE ON price_rule
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -------------------------------------------------------------- customers --

CREATE TABLE customer (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name       text NOT NULL,
  phone      text NOT NULL,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Phone is the identity here, not email.
CREATE UNIQUE INDEX customer_tenant_phone_key ON customer (tenant_id, phone);
CREATE TRIGGER customer_updated_at BEFORE UPDATE ON customer
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------ occupancy --

CREATE TABLE reservation (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  venue_id     uuid NOT NULL REFERENCES venue(id) ON DELETE CASCADE,
  resource_id  uuid NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('booking', 'block')),
  status       text NOT NULL CHECK (status IN ('held', 'confirmed', 'completed', 'cancelled', 'no_show', 'blocked')),
  during       tstzrange NOT NULL,
  customer_id  uuid REFERENCES customer(id) ON DELETE SET NULL,
  amount_paise bigint NOT NULL DEFAULT 0 CHECK (amount_paise >= 0),
  notes        text,
  block_reason text,
  -- Unused in phase 0 (no online payments yet), but the column the hold/expiry
  -- flow will need in phase 1.
  expires_at   timestamptz,
  created_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
  cancelled_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT reservation_during_bounded CHECK (
    lower(during) IS NOT NULL AND upper(during) IS NOT NULL AND NOT isempty(during)
  ),
  CONSTRAINT reservation_kind_status CHECK (
    (kind = 'block'   AND status IN ('blocked', 'cancelled')) OR
    (kind = 'booking' AND status IN ('held', 'confirmed', 'completed', 'cancelled', 'no_show'))
  ),

  -- The whole point of the schema.
  --
  -- Two people tapping the last 7pm slot cannot both win: check-then-insert in
  -- application code is a race, this is not. Holds, confirmed bookings and
  -- maintenance blocks all participate, so a hold blocks a confirm.
  --
  -- cancelled and no_show are deliberately absent: a no-show slot should be
  -- resellable to a walk-in while the hour is still running.
  CONSTRAINT reservation_no_overlap EXCLUDE USING gist (
    resource_id WITH =,
    during WITH &&
  ) WHERE (status IN ('held', 'confirmed', 'completed', 'blocked'))
);
CREATE INDEX reservation_venue_during_idx ON reservation USING gist (venue_id, during);
CREATE INDEX reservation_tenant_created_idx ON reservation (tenant_id, created_at DESC);
CREATE INDEX reservation_customer_idx ON reservation (customer_id) WHERE customer_id IS NOT NULL;
CREATE TRIGGER reservation_updated_at BEFORE UPDATE ON reservation
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------- payments --

-- Separate from reservation from day one: one booking has many payments
-- (advance + balance, partial refunds), and a large share of venue money in
-- India moves as cash the owner records by hand.
CREATE TABLE payment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES reservation(id) ON DELETE CASCADE,
  amount_paise   bigint NOT NULL CHECK (amount_paise > 0),
  direction      text NOT NULL DEFAULT 'in' CHECK (direction IN ('in', 'refund')),
  method         text NOT NULL CHECK (method IN ('cash', 'upi', 'card', 'bank_transfer', 'other')),
  reference      text,
  note           text,
  received_at    timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_reservation_idx ON payment (reservation_id);
CREATE INDEX payment_tenant_received_idx ON payment (tenant_id, received_at DESC);
