-- Replaces the single opens_at/closes_at pair on a court with real opening
-- hours: per weekday, more than one window per day, and date overrides.
--
-- One pair per court could not express the two things every venue actually
-- does: different weekend hours, and a midday closure (school or academy
-- hours) that splits the day in two.

-- Postgres ships range types for timestamps and dates but not for `time`, and
-- the non-overlap guarantee below needs one.
CREATE TYPE timerange AS RANGE (subtype = time);

-- ------------------------------------------------------- weekly hours --

CREATE TABLE resource_hour_rule (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  -- 0 = Sunday .. 6 = Saturday, matching the day masks used by price rules.
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  opens_at    time NOT NULL,
  closes_at   time NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT resource_hour_rule_ordered CHECK (closes_at > opens_at),

  -- Same reasoning as reservations: overlapping windows on one day are
  -- nonsense, so the database refuses them rather than trusting the caller.
  CONSTRAINT resource_hour_rule_no_overlap EXCLUDE USING gist (
    resource_id WITH =,
    day_of_week WITH =,
    timerange(opens_at, closes_at, '[)') WITH &&
  )
);
CREATE INDEX resource_hour_rule_resource_idx ON resource_hour_rule (resource_id, day_of_week);
CREATE TRIGGER resource_hour_rule_updated_at BEFORE UPDATE ON resource_hour_rule
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------- date overrides --

-- A holiday, a tournament day, an early close. resource_id NULL means the
-- whole venue, which is what an owner means by "we're shut on the 26th".
--
-- This is distinct from a `block` reservation: an override changes what hours
-- exist at all, so no slot is generated and nothing can be booked into it. A
-- block occupies a slot that otherwise exists.
CREATE TABLE venue_date_override (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  venue_id    uuid NOT NULL REFERENCES venue(id) ON DELETE CASCADE,
  resource_id uuid REFERENCES resource(id) ON DELETE CASCADE,
  on_date     date NOT NULL,
  is_closed   boolean NOT NULL DEFAULT true,
  opens_at    time,
  closes_at   time,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT venue_date_override_hours CHECK (
    is_closed
    OR (opens_at IS NOT NULL AND closes_at IS NOT NULL AND closes_at > opens_at)
  )
);
-- At most one override per date at each level; the resource-specific one wins.
CREATE UNIQUE INDEX venue_date_override_venue_key
  ON venue_date_override (venue_id, on_date) WHERE resource_id IS NULL;
CREATE UNIQUE INDEX venue_date_override_resource_key
  ON venue_date_override (resource_id, on_date) WHERE resource_id IS NOT NULL;
CREATE INDEX venue_date_override_lookup_idx ON venue_date_override (venue_id, on_date);
CREATE TRIGGER venue_date_override_updated_at BEFORE UPDATE ON venue_date_override
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------- migration --

-- Every existing court keeps exactly the hours it had, on all seven days.
INSERT INTO resource_hour_rule (tenant_id, resource_id, day_of_week, opens_at, closes_at)
SELECT r.tenant_id, r.id, d.day_of_week, r.opens_at, r.closes_at
FROM resource r
CROSS JOIN generate_series(0, 6) AS d(day_of_week);

ALTER TABLE resource
  DROP CONSTRAINT resource_hours_ordered,
  DROP COLUMN opens_at,
  DROP COLUMN closes_at;
