-- The audit trail has to describe two very different actors: a staff member
-- with a login, and a customer identified only by a verified phone number.
--
-- actor_user_id referenced app_user, so recording a public booking violated the
-- foreign key. That alone would be a small bug; what made it serious is that a
-- failed statement aborts the whole surrounding transaction in Postgres, and
-- the audit service caught the error and carried on. The request returned 201
-- while the booking it described was rolled back.

ALTER TABLE audit_event
  ADD COLUMN actor_type text NOT NULL DEFAULT 'staff'
    CHECK (actor_type IN ('staff', 'customer', 'system')),
  -- The label is whatever identifies that kind of actor: an email for staff, a
  -- masked phone for a customer. Never a raw phone number: logs and exports are
  -- read by more people than the customer table is.
  ADD COLUMN actor_label text;

UPDATE audit_event SET actor_label = actor_email WHERE actor_label IS NULL;

ALTER TABLE audit_event
  DROP COLUMN actor_email,
  -- Only a staff actor has a row in app_user.
  ADD CONSTRAINT audit_event_actor_shape CHECK (
    (actor_type = 'staff') OR actor_user_id IS NULL
  );
