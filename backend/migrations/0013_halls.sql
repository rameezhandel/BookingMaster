-- Halls: the second vertical.
--
-- A wedding hall sells a *date*, not an hour, and the booking is a sales
-- pipeline — enquiry, site visit, quote, advance — before it is ever a calendar
-- entry. The reservation table and its exclusion constraint carry over
-- unchanged; almost nothing else does.

-- A resource is booked by the hour or by the day. Courts keep working exactly
-- as they did.
ALTER TABLE resource
  ADD COLUMN kind text NOT NULL DEFAULT 'court' CHECK (kind IN ('court', 'hall'));

-- `sport` is meaningless for a banquet hall. Made optional rather than
-- overloaded, because a column called `sport` holding "wedding lawn" is a lie
-- that costs somebody an hour a year from now.
ALTER TABLE resource ALTER COLUMN sport DROP NOT NULL;
ALTER TABLE resource ADD CONSTRAINT resource_court_has_sport
  CHECK (kind <> 'court' OR sport IS NOT NULL);

/*
 * The hall is held for longer than the event runs.
 *
 * The decorator wants it from six the evening before, and nobody else can be in
 * there while a stage is half-built. So the interval that blocks the calendar
 * is wider than the one the customer is billed for, and they are different
 * facts about the same booking rather than one fact rounded.
 *
 * `during` stays the authoritative blocked span — the exclusion constraint is
 * untouched. `event_during` is the event itself, and is what an invoice and a
 * confirmation message quote. Null for courts, where the two are the same
 * thing.
 */
ALTER TABLE reservation
  ADD COLUMN event_during tstzrange,
  ADD CONSTRAINT reservation_event_within_hold
    CHECK (event_during IS NULL OR during @> event_during);

/*
 * An enquiry.
 *
 * Deliberately not a reservation, and deliberately touching no constraint: an
 * enquiry must NOT block the date. Owners let three families consider the same
 * November Saturday and take whoever commits — a system that blocked on enquiry
 * would either lose them bookings or teach them to lie to it.
 *
 * Only a tentative hold blocks, and that expires in days rather than minutes.
 */
CREATE TABLE enquiry (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  venue_id      uuid NOT NULL REFERENCES venue(id) ON DELETE CASCADE,
  -- Which hall, once they have decided. Early on they often have not.
  resource_id   uuid REFERENCES resource(id) ON DELETE SET NULL,
  customer_id   uuid REFERENCES customer(id) ON DELETE SET NULL,

  contact_name  text NOT NULL,
  contact_phone text NOT NULL,
  contact_email text,

  -- "wedding", "reception", "birthday", "conference". Free text: every venue
  -- has its own vocabulary and an enum here would be wrong within a month.
  event_type    text,
  -- Null while it is still "sometime in November".
  event_date    date,
  guest_count   integer CHECK (guest_count IS NULL OR guest_count > 0),

  status        text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'visit_scheduled', 'quoted', 'won', 'lost')),
  visit_at      timestamptz,
  quoted_paise  bigint CHECK (quoted_paise IS NULL OR quoted_paise >= 0),
  lost_reason   text,

  -- Set when the enquiry becomes a hold or a booking. The link is how the
  -- pipeline stops being a list of hopes and starts agreeing with the calendar.
  reservation_id uuid REFERENCES reservation(id) ON DELETE SET NULL,

  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- A won enquiry is one that produced a booking; anything else has not.
  CONSTRAINT enquiry_won_has_booking
    CHECK (status <> 'won' OR reservation_id IS NOT NULL),
  CONSTRAINT enquiry_lost_has_reason
    CHECK (status <> 'lost' OR lost_reason IS NOT NULL)
);

CREATE INDEX enquiry_tenant_idx ON enquiry (tenant_id, created_at DESC);
CREATE INDEX enquiry_venue_status_idx ON enquiry (venue_id, status);
CREATE INDEX enquiry_date_idx ON enquiry (event_date) WHERE event_date IS NOT NULL;

CREATE TRIGGER enquiry_updated_at BEFORE UPDATE ON enquiry
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE enquiry ENABLE ROW LEVEL SECURITY;
ALTER TABLE enquiry FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON enquiry
  USING (rls_bypassed() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypassed() OR tenant_id = current_tenant_id());
