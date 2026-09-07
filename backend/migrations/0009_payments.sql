-- Online payment.
--
-- Two tables, for two things that are easy to conflate:
--
--   payment_intent  — our record of an attempt to collect money, tied to a
--                     booking and to the gateway's order id.
--   gateway_event   — the raw notifications the gateway sends us.
--
-- The gateway is the source of truth about money, and it tells us through the
-- webhook, not through the browser. A customer closes the tab, loses signal, or
-- never comes back from the payment page; the webhook still arrives.

CREATE TABLE payment_intent (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  venue_id           uuid NOT NULL REFERENCES venue(id) ON DELETE CASCADE,
  reservation_id     uuid REFERENCES reservation(id) ON DELETE SET NULL,
  gateway            text NOT NULL,
  gateway_order_id   text NOT NULL,
  gateway_payment_id text,
  amount_paise       bigint NOT NULL CHECK (amount_paise > 0),
  currency           text NOT NULL DEFAULT 'INR',
  status             text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'paid', 'failed', 'abandoned', 'refunded')),
  -- Set when a payment arrived too late to honour, and the money went back.
  refund_reason      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payment_intent_order_key ON payment_intent (gateway, gateway_order_id);
CREATE INDEX payment_intent_reservation_idx ON payment_intent (reservation_id);
CREATE INDEX payment_intent_tenant_idx ON payment_intent (tenant_id, created_at DESC);
CREATE TRIGGER payment_intent_updated_at BEFORE UPDATE ON payment_intent
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE payment_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_intent FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_intent
  USING (rls_bypassed() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypassed() OR tenant_id = current_tenant_id());

-- Every webhook we accept, stored before it is acted on.
--
-- The unique key on (gateway, event_id) *is* the idempotency mechanism.
-- Gateways retry — on timeouts, on non-2xx, sometimes just twice — and without
-- this a retry would confirm a booking twice or record the same money twice.
-- Inserting first and letting the constraint reject duplicates is safer than
-- checking then acting, which is a race.
CREATE TABLE gateway_event (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gateway      text NOT NULL,
  event_id     text NOT NULL,
  event_type   text NOT NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error        text
);
CREATE UNIQUE INDEX gateway_event_key ON gateway_event (gateway, event_id);
CREATE INDEX gateway_event_unprocessed_idx ON gateway_event (received_at) WHERE processed_at IS NULL;

-- Infrastructure, not tenant data, and it holds raw gateway payloads. Nothing
-- reads it through a request, so only a system context may touch it at all.
ALTER TABLE gateway_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_event FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON gateway_event USING (rls_bypassed()) WITH CHECK (rls_bypassed());

-- Ties a recorded payment back to the gateway transaction that produced it.
ALTER TABLE payment
  ADD COLUMN payment_intent_id uuid REFERENCES payment_intent(id) ON DELETE SET NULL;
