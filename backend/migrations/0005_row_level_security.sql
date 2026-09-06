-- Defence in depth for tenant isolation.
--
-- Every query in the application already filters by tenant_id and every service
-- takes it as an explicit argument. This is the backstop for the one place that
-- eventually forgets, because in a multi-tenant booking system that mistake
-- leaks another venue's customers and revenue.
--
-- Two design choices worth stating:
--
-- 1. FORCE, not just ENABLE. The application connects as the role that owns
--    these tables, and a table owner is exempt from its own policies unless the
--    table is FORCEd. Without this the policies would look right and do nothing.
--
-- 2. Fail closed. With no tenant context set, current_setting returns NULL,
--    `tenant_id = NULL` is NULL, and the policy denies. A request that somehow
--    skips the tenant interceptor sees zero rows rather than everyone's.
--
-- Migrations, the seed script and background jobs that legitimately work across
-- tenants opt out explicitly by setting app.bypass_rls, which is a deliberate
-- act rather than an accident of a missing setting.

CREATE TABLE audit_event (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  actor_user_id  uuid REFERENCES app_user(id) ON DELETE SET NULL,
  actor_email    text,
  action         text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      uuid,
  summary        text NOT NULL,
  data           jsonb,
  request_id     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_event_tenant_idx ON audit_event (tenant_id, created_at DESC);
CREATE INDEX audit_event_entity_idx ON audit_event (entity_type, entity_id);

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION rls_bypassed() RETURNS boolean AS $$
  SELECT coalesce(current_setting('app.bypass_rls', true), '') = 'on';
$$ LANGUAGE sql STABLE;

DO $$
DECLARE
  t text;
  protected text[] := ARRAY[
    'venue', 'resource', 'resource_hour_rule', 'venue_date_override',
    'price_rule', 'customer', 'reservation', 'payment',
    'booking_series', 'cancellation_tier', 'audit_event'
  ];
BEGIN
  FOREACH t IN ARRAY protected LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (rls_bypassed() OR tenant_id = current_tenant_id())
        WITH CHECK (rls_bypassed() OR tenant_id = current_tenant_id())
    $f$, t);
  END LOOP;
END $$;

-- The audit trail is append-only: no policy permits UPDATE or DELETE, so even a
-- compromised application cannot quietly rewrite what it did. Rows still go
-- when their tenant does, via the foreign key.
CREATE POLICY audit_event_append_only ON audit_event AS RESTRICTIVE
  FOR UPDATE USING (false);
CREATE POLICY audit_event_no_delete ON audit_event AS RESTRICTIVE
  FOR DELETE USING (false);
