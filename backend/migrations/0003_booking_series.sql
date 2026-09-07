-- Recurring bookings: "Court 2, every Tuesday at 8pm".
--
-- Academies and regular groups are a large slice of court revenue, and an owner
-- re-entering the same booking every week will stop doing it.
--
-- The series is the *rule*; the reservations it produces are ordinary rows and
-- keep every guarantee the calendar already relies on. In particular each
-- occurrence still goes through the exclusion constraint, so a recurring
-- booking can never quietly overwrite a one-off that got there first.

CREATE TABLE booking_series (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  venue_id         uuid NOT NULL REFERENCES venue(id) ON DELETE CASCADE,
  resource_id      uuid NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  customer_id      uuid REFERENCES customer(id) ON DELETE SET NULL,

  -- The rule. 0 = Sunday, matching hour rules and price rules.
  day_of_week      smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  starts_at        time NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 15 AND 1440),
  starts_on        date NOT NULL,
  ends_on          date,

  -- NULL means price each occurrence from the price rules as it is created, so
  -- a series spanning a rate change bills correctly on both sides of it.
  amount_paise     bigint CHECK (amount_paise IS NULL OR amount_paise >= 0),

  notes            text,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),

  -- How far ahead occurrences have been created. A nightly job rolls this
  -- forward so a weekly group never runs out of bookings.
  materialised_through date,

  created_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT booking_series_dates_ordered CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX booking_series_tenant_idx ON booking_series (tenant_id, status);
CREATE INDEX booking_series_resource_idx ON booking_series (resource_id);
CREATE INDEX booking_series_customer_idx ON booking_series (customer_id) WHERE customer_id IS NOT NULL;
CREATE TRIGGER booking_series_updated_at BEFORE UPDATE ON booking_series
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE reservation
  ADD COLUMN series_id uuid REFERENCES booking_series(id) ON DELETE SET NULL,
  ADD COLUMN occurrence_date date;

-- One occurrence per series per date: makes re-running materialisation safe to
-- retry, and stops a double-extend creating two bookings for the same week.
CREATE UNIQUE INDEX reservation_series_occurrence_key
  ON reservation (series_id, occurrence_date)
  WHERE series_id IS NOT NULL AND status <> 'cancelled';

CREATE INDEX reservation_series_idx ON reservation (series_id) WHERE series_id IS NOT NULL;
