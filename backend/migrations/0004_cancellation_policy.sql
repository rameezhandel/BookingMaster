-- Tiered cancellation refunds, as tenant configuration rather than branches in
-- code. Every venue has its own view of what is fair, and they change it.
--
-- A tier reads "cancel at least N hours before the start and you get P% back".
-- Resolution picks the tier with the largest min_hours_before that the
-- cancellation still satisfies, so:
--
--   24h -> 100%,  12h -> 50%,  0h -> 0%
--
-- cancelling 30 hours out refunds everything, 18 hours out refunds half, and
-- two hours out refunds nothing.
--
-- A venue with no tiers has *no policy*, which is deliberately different from a
-- policy of zero: the UI says so and lets the owner decide, rather than quietly
-- refunding nothing.

CREATE TABLE cancellation_tier (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  venue_id         uuid NOT NULL REFERENCES venue(id) ON DELETE CASCADE,
  min_hours_before integer NOT NULL CHECK (min_hours_before >= 0 AND min_hours_before <= 8760),
  refund_pct       smallint NOT NULL CHECK (refund_pct BETWEEN 0 AND 100),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- One rule per threshold; two rows for "24 hours" would be ambiguous.
  CONSTRAINT cancellation_tier_unique UNIQUE (venue_id, min_hours_before)
);
CREATE INDEX cancellation_tier_venue_idx ON cancellation_tier (venue_id, min_hours_before DESC);
CREATE TRIGGER cancellation_tier_updated_at BEFORE UPDATE ON cancellation_tier
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- What the policy actually decided, kept on the booking. Recomputing a refund
-- months later from the policy of the day would give a different answer, and
-- the number that matters is the one the customer was told.
ALTER TABLE reservation
  ADD COLUMN cancellation_refund_pct smallint
    CHECK (cancellation_refund_pct IS NULL OR cancellation_refund_pct BETWEEN 0 AND 100),
  ADD COLUMN cancellation_refund_paise bigint
    CHECK (cancellation_refund_paise IS NULL OR cancellation_refund_paise >= 0),
  ADD COLUMN cancellation_reason text;
