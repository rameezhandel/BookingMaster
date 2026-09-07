-- Self-serve booking: a customer identifies themselves by phone, takes a hold
-- on a slot, and confirms it.
--
-- The hold is the interesting part. It already participates in the overlap
-- constraint (status 'held' is in the partial index), so two people cannot hold
-- the same slot. What it adds is a deadline.

ALTER TABLE venue
  -- How long a slot is held while someone finishes booking. Long enough to
  -- type a phone number and an OTP, short enough that an abandoned checkout
  -- does not cost the venue a Saturday evening.
  ADD COLUMN hold_minutes integer NOT NULL DEFAULT 10
    CHECK (hold_minutes BETWEEN 2 AND 60),
  -- When false, a public booking confirms immediately and is paid at the
  -- venue. Plenty of courts work exactly this way and want the calendar, not
  -- the card processing.
  ADD COLUMN requires_prepayment boolean NOT NULL DEFAULT false;

-- A held booking must have a deadline, and a confirmed one must not carry a
-- stale deadline that a sweeper could act on.
ALTER TABLE reservation
  ADD CONSTRAINT reservation_hold_has_expiry CHECK (
    (status = 'held' AND expires_at IS NOT NULL) OR status <> 'held'
  );

CREATE INDEX reservation_expiring_holds_idx ON reservation (expires_at)
  WHERE status = 'held';

-- ------------------------------------------------------------- identity --

-- Phone is the identity for a player, not email. The code itself is never
-- stored: only a hash, so a leaked table does not hand out logins.
CREATE TABLE otp_challenge (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  venue_id     uuid NOT NULL REFERENCES venue(id) ON DELETE CASCADE,
  phone        text NOT NULL,
  code_hash    text NOT NULL,
  expires_at   timestamptz NOT NULL,
  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_challenge_lookup_idx ON otp_challenge (venue_id, phone, created_at DESC);
CREATE INDEX otp_challenge_expiry_idx ON otp_challenge (expires_at);

ALTER TABLE otp_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_challenge FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON otp_challenge
  USING (rls_bypassed() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypassed() OR tenant_id = current_tenant_id());

-- Who made a public booking, for the audit trail and so a customer can see
-- their own bookings later.
ALTER TABLE reservation
  ADD COLUMN booked_by_public boolean NOT NULL DEFAULT false;
