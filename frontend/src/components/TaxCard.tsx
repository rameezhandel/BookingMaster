import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, patch } from '../lib/api';
import type { Venue } from '../lib/types';

/**
 * GST settings.
 *
 * Off until a GSTIN is entered, and deliberately so: a venue below the
 * registration threshold does not charge GST at all, and inventing tax for them
 * would be worse than having no feature. The rate and the SAC code are the
 * venue's to set with their accountant — nothing here decides what they owe.
 */
export function TaxCard({ venue }: { venue: Venue }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    gstin: venue.gstin ?? '',
    legalName: venue.legalName ?? '',
    legalAddress: venue.legalAddress ?? '',
    sacCode: venue.sacCode ?? '',
    invoicePrefix: venue.invoicePrefix ?? '',
    gstRatePct: String(venue.gstRateBp / 100),
  });

  useEffect(() => {
    setForm({
      gstin: venue.gstin ?? '',
      legalName: venue.legalName ?? '',
      legalAddress: venue.legalAddress ?? '',
      sacCode: venue.sacCode ?? '',
      invoicePrefix: venue.invoicePrefix ?? '',
      gstRatePct: String(venue.gstRateBp / 100),
    });
  }, [venue.id, venue.gstin, venue.legalName, venue.legalAddress, venue.sacCode, venue.invoicePrefix, venue.gstRateBp]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch(`/venues/${venue.id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['venues'] }),
  });

  const saveAll = () =>
    save.mutate({
      gstin: form.gstin.trim().toUpperCase() || undefined,
      legalName: form.legalName.trim(),
      legalAddress: form.legalAddress.trim(),
      sacCode: form.sacCode.trim(),
      invoicePrefix: form.invoicePrefix.trim().toUpperCase(),
      gstRateBp: Math.round(Number(form.gstRatePct || 0) * 100),
    });

  return (
    <div className="card">
      <div className="card-head">
        <h2>Tax invoices</h2>
        <span className="spacer" />
        <span className={`pill ${venue.invoicingEnabled ? 'confirmed' : 'cancelled'}`}>
          {venue.invoicingEnabled ? 'on' : 'off'}
        </span>
        <button
          onClick={() => save.mutate({ invoicingEnabled: !venue.invoicingEnabled })}
          disabled={save.isPending || (!venue.gstin && !venue.invoicingEnabled)}
          title={!venue.gstin ? 'Add a GSTIN first' : undefined}
        >
          {venue.invoicingEnabled ? 'Turn off' : 'Turn on'}
        </button>
      </div>

      <div className="card-body">
        {save.error instanceof ApiError && <div className="msg error">{save.error.message}</div>}

        <p className="muted" style={{ marginTop: 0 }}>
          {venue.invoicingEnabled
            ? 'A tax invoice can be issued from any booking. Numbers run in one unbroken series per financial year.'
            : 'Not issuing invoices. Add your GSTIN below, then turn this on.'}
        </p>

        <div className="field-row">
          <div className="field">
            <label htmlFor="tax-gstin">GSTIN</label>
            <input
              id="tax-gstin"
              value={form.gstin}
              onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })}
              placeholder="29AABCU9603R1ZM"
              maxLength={15}
            />
            <div className="hint">
              {venue.stateCode
                ? `State code ${venue.stateCode} — bookings here are taxed as CGST + SGST.`
                : 'The first two digits are your state, which decides the tax split.'}
            </div>
          </div>
          <div className="field">
            <label htmlFor="tax-rate">GST rate (%)</label>
            <input
              id="tax-rate"
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={form.gstRatePct}
              onChange={(e) => setForm({ ...form, gstRatePct: e.target.value })}
            />
            <div className="hint">Confirm this with your accountant.</div>
          </div>
        </div>

        <div className="field">
          <label htmlFor="tax-legal-name">Registered name</label>
          <input
            id="tax-legal-name"
            value={form.legalName}
            onChange={(e) => setForm({ ...form, legalName: e.target.value })}
            placeholder={venue.name}
          />
          <div className="hint">Often not the trading name. Left blank, the venue name is used.</div>
        </div>

        <div className="field">
          <label htmlFor="tax-legal-address">Registered address</label>
          <input
            id="tax-legal-address"
            value={form.legalAddress}
            onChange={(e) => setForm({ ...form, legalAddress: e.target.value })}
            placeholder={venue.address ?? 'As registered'}
          />
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="tax-sac">SAC code</label>
            <input
              id="tax-sac"
              value={form.sacCode}
              onChange={(e) => setForm({ ...form, sacCode: e.target.value })}
              placeholder="999652"
              maxLength={10}
            />
          </div>
          <div className="field">
            <label htmlFor="tax-prefix">Invoice prefix</label>
            <input
              id="tax-prefix"
              value={form.invoicePrefix}
              onChange={(e) => setForm({ ...form, invoicePrefix: e.target.value.toUpperCase() })}
              placeholder="SA"
              maxLength={4}
            />
            <div className="hint">
              Numbers read {form.invoicePrefix.trim() || 'SA'}/2026-27/0001.
            </div>
          </div>
        </div>

        <div className="field">
          <label className="checkline">
            <input
              type="checkbox"
              checked={venue.pricesIncludeGst}
              onChange={(e) => save.mutate({ pricesIncludeGst: e.target.checked })}
            />
            <span>Court prices already include GST</span>
          </label>
          <div className="hint">
            {venue.pricesIncludeGst
              ? 'A ₹500 court is ₹500 to the customer, and the tax is worked back out of it. This is how a counter usually quotes.'
              : 'Tax is added on top, so a ₹500 court costs the customer more than ₹500.'}
          </div>
        </div>

        <div className="row">
          <button className="primary" onClick={saveAll} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save tax details'}
          </button>
        </div>
      </div>
    </div>
  );
}
