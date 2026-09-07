-- Staff accounts.
--
-- Until now a venue had exactly one login, which meant a manager and three desk
-- staff shared it. That is how the account of who did what becomes worthless,
-- and how a person who leaves keeps their access.

-- Deactivated rather than deleted: their bookings, payments and audit trail all
-- point at them, and removing the row would either take that history or leave
-- it anonymous.
ALTER TABLE app_user
  ADD COLUMN is_active       boolean NOT NULL DEFAULT true,
  ADD COLUMN deactivated_at  timestamptz,
  ADD COLUMN last_login_at   timestamptz;

/*
 * An invitation, not an owner typing a password on someone's behalf.
 *
 * The owner knows the email; the person themselves sets the password, so it is
 * never known to anyone else and never travels through a chat message.
 *
 * Only the token's hash is stored. A leaked database backup must not hand out
 * working invitations, which is the same reason OTP codes are hashed.
 */
CREATE TABLE staff_invite (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  email         text NOT NULL,
  name          text NOT NULL,
  role          text NOT NULL DEFAULT 'staff' CHECK (role IN ('owner', 'staff')),
  token_hash    text NOT NULL,
  invited_by    uuid REFERENCES app_user(id) ON DELETE SET NULL,
  expires_at    timestamptz NOT NULL,
  -- Single use. Set when redeemed; a redeemed invite is spent, not deleted, so
  -- an owner can see that it was taken up and by when.
  accepted_at   timestamptz,
  accepted_user uuid REFERENCES app_user(id) ON DELETE SET NULL,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX staff_invite_token_hash ON staff_invite (token_hash);
CREATE INDEX staff_invite_tenant_idx ON staff_invite (tenant_id, created_at DESC);

-- One live invitation per email per tenant. Without this, an owner clicking
-- twice sends two, and revoking one leaves the other working.
CREATE UNIQUE INDEX staff_invite_pending_email
  ON staff_invite (tenant_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TRIGGER staff_invite_updated_at BEFORE UPDATE ON staff_invite
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

/*
 * Both tables under row-level security.
 *
 * app_user was left out of it originally because login has to find a user
 * before any tenant is known. That made every staff query's tenant scoping a
 * hand-written `WHERE tenant_id = ...` with no database backstop — fine while
 * there was one user per tenant and nothing to list, wrong the moment an owner
 * can manage other people.
 *
 * So the default is now closed, and the two places that genuinely must look
 * across tenants — signing in, and redeeming an invitation, neither of which
 * has a tenant yet — say so explicitly by bypassing.
 */
ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_user
  USING (rls_bypassed() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypassed() OR tenant_id = current_tenant_id());

ALTER TABLE staff_invite ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_invite FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_invite
  USING (rls_bypassed() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypassed() OR tenant_id = current_tenant_id());
