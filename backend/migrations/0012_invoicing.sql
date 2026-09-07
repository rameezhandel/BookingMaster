-- GST invoices.
--
-- A venue in India has to be able to hand over a tax invoice, and the numbering
-- on it is the part with teeth: the series must be unbroken. A missing number
-- is a question during a return that somebody has to answer.

ALTER TABLE venue
  -- Off until an owner fills in a GSTIN. A venue below the registration
  -- threshold does not charge GST at all, and inventing tax for them would be
  -- worse than having no feature.
  ADD COLUMN invoicing_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN gstin             text,
  -- The registered name and address, which are often not the trading ones.
  ADD COLUMN legal_name        text,
  ADD COLUMN legal_address     text,
  -- First two digits of the GSTIN. Kept separately because the split between
  -- central+state and integrated tax turns on it.
  ADD COLUMN state_code        text,
  -- Basis points: 1800 is 18%. The venue's accountant decides this, not us.
  ADD COLUMN gst_rate_bp       integer NOT NULL DEFAULT 1800
    CHECK (gst_rate_bp BETWEEN 0 AND 10000),
  -- A counter in India quotes the price the customer hands over.
  ADD COLUMN prices_include_gst boolean NOT NULL DEFAULT true,
  ADD COLUMN sac_code          text,
  -- Up to four characters, printed as SA/2026-27/0001.
  ADD COLUMN invoice_prefix    text;

/*
 * The counter behind a gapless series.
 *
 * A Postgres sequence is the obvious tool and the wrong one: it hands out
 * numbers outside transaction control, so a rolled-back invoice burns its
 * number and leaves a hole. `SELECT max(seq) + 1` has the opposite problem —
 * two concurrent issues read the same maximum and collide.
 *
 * So the next number lives in a row that is locked FOR UPDATE and incremented
 * in the same transaction that writes the invoice. Concurrent issues queue
 * behind the lock, and a transaction that rolls back returns its number to the
 * pool because the increment rolls back with it. Serialised per venue per year,
 * which is the right trade: invoices are issued at human speed.
 */
CREATE TABLE invoice_series (
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  venue_id       uuid NOT NULL REFERENCES venue(id) ON DELETE CASCADE,
  -- "2026-27". April to March, so the series restarts in April.
  financial_year text NOT NULL,
  next_seq       integer NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, venue_id, financial_year)
);

CREATE TABLE invoice (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  venue_id       uuid NOT NULL REFERENCES venue(id) ON DELETE RESTRICT,
  reservation_id uuid REFERENCES reservation(id) ON DELETE SET NULL,
  customer_id    uuid REFERENCES customer(id) ON DELETE SET NULL,

  kind           text NOT NULL DEFAULT 'invoice'
    CHECK (kind IN ('invoice', 'credit_note')),
  -- A credit note names the invoice it reverses.
  reverses_id    uuid REFERENCES invoice(id) ON DELETE RESTRICT,

  financial_year text NOT NULL,
  seq            integer NOT NULL CHECK (seq >= 1),
  -- The printed form, e.g. SA/2026-27/0001. Stored rather than derived: the
  -- venue may change its prefix, and a document already handed over does not
  -- change with it.
  number         text NOT NULL,
  issued_at      timestamptz NOT NULL DEFAULT now(),

  /*
   * Everything below is a snapshot taken when the invoice was issued.
   *
   * Joining to the venue and customer would be less duplication and quite
   * wrong: an invoice is a record of what was said at the time. A venue that
   * moves premises, or a customer who corrects the spelling of their name, must
   * not silently rewrite documents already given to somebody.
   */
  supplier_name      text NOT NULL,
  supplier_gstin     text,
  supplier_address   text,
  supplier_state_code text,
  customer_name      text,
  customer_phone     text,
  customer_gstin     text,
  place_of_supply    text,
  sac_code           text,
  description        text NOT NULL,

  gst_rate_bp    integer NOT NULL CHECK (gst_rate_bp BETWEEN 0 AND 10000),
  taxable_paise  bigint NOT NULL CHECK (taxable_paise >= 0),
  cgst_paise     bigint NOT NULL DEFAULT 0 CHECK (cgst_paise >= 0),
  sgst_paise     bigint NOT NULL DEFAULT 0 CHECK (sgst_paise >= 0),
  igst_paise     bigint NOT NULL DEFAULT 0 CHECK (igst_paise >= 0),
  total_paise    bigint NOT NULL CHECK (total_paise >= 0),

  -- The arithmetic is checked in the application and again here, because a
  -- document that does not add up must not be storable at all.
  CONSTRAINT invoice_totals_reconcile
    CHECK (taxable_paise + cgst_paise + sgst_paise + igst_paise = total_paise),
  -- Either a central/state split or one integrated charge, never both.
  CONSTRAINT invoice_one_tax_shape
    CHECK ((cgst_paise = 0 AND sgst_paise = 0) OR igst_paise = 0),

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- The series itself: no two documents share a number, and therefore none is
-- missing without it being visible.
CREATE UNIQUE INDEX invoice_series_number
  ON invoice (tenant_id, venue_id, financial_year, seq);
CREATE INDEX invoice_tenant_idx ON invoice (tenant_id, issued_at DESC);
CREATE INDEX invoice_reservation_idx ON invoice (reservation_id);

-- One invoice per booking, and one credit note per invoice. Pressing the button
-- twice must not produce two tax documents for the same money.
CREATE UNIQUE INDEX invoice_one_per_reservation
  ON invoice (reservation_id) WHERE kind = 'invoice' AND reservation_id IS NOT NULL;
CREATE UNIQUE INDEX invoice_one_credit_note_per_invoice
  ON invoice (reverses_id) WHERE reverses_id IS NOT NULL;

CREATE TRIGGER invoice_updated_at BEFORE UPDATE ON invoice
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER invoice_series_updated_at BEFORE UPDATE ON invoice_series
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice
  USING (rls_bypassed() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypassed() OR tenant_id = current_tenant_id());

ALTER TABLE invoice_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_series FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice_series
  USING (rls_bypassed() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypassed() OR tenant_id = current_tenant_id());

/*
 * An issued invoice is not editable or deletable, the same way the audit trail
 * is not. Correcting one means issuing a credit note against it, which is both
 * the legal mechanism and an honest record of what happened.
 */
CREATE POLICY invoice_no_update ON invoice AS RESTRICTIVE FOR UPDATE USING (false);
CREATE POLICY invoice_no_delete ON invoice AS RESTRICTIVE FOR DELETE USING (false);
