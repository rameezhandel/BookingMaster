-- Messages to customers, as a transactional outbox.
--
-- Sending inside the request is wrong three ways, and all three bite in
-- production:
--
--   * The HTTP call to the provider is slow and holds a database connection
--     for its duration.
--   * If the send succeeds and the transaction then rolls back, a customer has
--     been told about a booking that does not exist.
--   * If the transaction commits and the send throws, the message is gone with
--     nothing to retry from.
--
-- So the row is written in the same transaction as the booking — atomic with
-- the thing it describes — and a worker sends it afterwards. A message that
-- fails is still on the table, with its attempt count, waiting.

CREATE TABLE notification (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  venue_id       uuid REFERENCES venue(id) ON DELETE SET NULL,
  customer_id    uuid REFERENCES customer(id) ON DELETE SET NULL,
  reservation_id uuid REFERENCES reservation(id) ON DELETE SET NULL,

  channel        text NOT NULL CHECK (channel IN ('whatsapp', 'sms')),
  -- The template registered with the provider. Business-initiated WhatsApp
  -- messages cannot be free text.
  template       text NOT NULL,
  -- Positional parameters, in the order the approved template expects them.
  params         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- What the message says, rendered at enqueue time. Kept so the owner can see
  -- what was actually sent even if the template is later changed.
  preview        text NOT NULL,
  to_phone       text NOT NULL,

  status         text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'failed', 'skipped')),
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- When the worker may next try. Backoff moves this forward.
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  provider       text,
  provider_message_id text,
  error          text,

  /*
   * One message per (booking, template). Re-running a confirmation — a retried
   * webhook, a double-clicked button — must not message the customer twice.
   */
  dedupe_key     text NOT NULL,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz
);

CREATE UNIQUE INDEX notification_dedupe_key ON notification (tenant_id, dedupe_key);
CREATE INDEX notification_due_idx ON notification (next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX notification_tenant_idx ON notification (tenant_id, created_at DESC);
CREATE INDEX notification_reservation_idx ON notification (reservation_id);
CREATE INDEX notification_provider_msg_idx ON notification (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE TRIGGER notification_updated_at BEFORE UPDATE ON notification
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification
  USING (rls_bypassed() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypassed() OR tenant_id = current_tenant_id());

-- A customer who asks not to be messaged must stop being messaged, and the
-- venue needs somewhere to record that when they ask in person.
ALTER TABLE customer
  ADD COLUMN notifications_opted_out boolean NOT NULL DEFAULT false;

-- Whether a venue sends confirmations at all, and how long before a booking a
-- reminder goes out. Zero disables reminders.
ALTER TABLE venue
  ADD COLUMN notifications_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN reminder_hours_before integer NOT NULL DEFAULT 3
    CHECK (reminder_hours_before BETWEEN 0 AND 72);
