import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { ApiError, del, get, patch, post } from '../lib/api';
import { paiseFromRupeeInput, rangeIn, rupees } from '../lib/format';
import type { Invoice, Payment } from '../lib/types';
import { CancelBookingPanel } from './CancelBookingPanel';
import { Modal } from './Modal';
import { InvoiceView } from './InvoiceView';
import { useVenue } from '../lib/venue';
import { useAuth } from '../lib/auth';

interface Props {
  reservationId: string;
  timezone: string;
  onClose: () => void;
}

interface Detail {
  id: string;
  kind: 'booking' | 'block';
  status: string;
  during: { start: string; end: string };
  amountPaise: number;
  paidPaise: number;
  duePaise: number;
  notes: string | null;
  blockReason: string | null;
  resourceName: string;
  customerName: string | null;
  customerPhone: string | null;
  payments: Payment[];
}

const METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'other', label: 'Other' },
] as const;

export function BookingDetailModal({ reservationId, timezone, onClose }: Props) {
  const qc = useQueryClient();
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState<string>('cash');
  const [cancelling, setCancelling] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['reservation', reservationId],
    queryFn: () => get<Detail>(`/reservations/${reservationId}`),
  });

  function refresh() {
    qc.invalidateQueries({ queryKey: ['reservation', reservationId] });
    qc.invalidateQueries({ queryKey: ['calendar'] });
    qc.invalidateQueries({ queryKey: ['week'] });
    qc.invalidateQueries({ queryKey: ['bookings'] });
  }

  const addPayment = useMutation({
    mutationFn: (direction: 'in' | 'refund') =>
      post(`/reservations/${reservationId}/payments`, {
        amountPaise: paiseFromRupeeInput(payAmount),
        method: payMethod,
        direction,
      }),
    onSuccess: () => {
      setPayAmount('');
      refresh();
    },
  });

  const setStatus = useMutation({
    mutationFn: (status: string) => patch(`/reservations/${reservationId}`, { status }),
    onSuccess: refresh,
  });

  const removeBlock = useMutation({
    mutationFn: () => del(`/reservations/${reservationId}`),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });

  if (isLoading || !data) {
    return (
      <Modal title="Booking" onClose={onClose}>
        <span className="faint">Loading…</span>
      </Modal>
    );
  }

  const isBlock = data.kind === 'block';
  const active = !['cancelled'].includes(data.status);
  const error = [addPayment.error, setStatus.error].find((e) => e instanceof ApiError) as
    | ApiError
    | undefined;

  return (
    <Modal
      title={isBlock ? 'Blocked time' : 'Booking'}
      onClose={onClose}
      footer={
        <>
          {isBlock ? (
            <button className="danger" onClick={() => removeBlock.mutate()} disabled={removeBlock.isPending}>
              Remove block
            </button>
          ) : (
            active &&
            !cancelling && (
              <button className="danger" onClick={() => setCancelling(true)}>
                Cancel booking
              </button>
            )
          )}
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </>
      }
    >
      <div className="slot-banner">
        <div>
          <div className="court">{data.resourceName}</div>
          <div className="when">{rangeIn(data.during.start, data.during.end, timezone)}</div>
        </div>
        <span className={`pill ${data.status}`}>{data.status.replace('_', ' ')}</span>
      </div>

      {error && <div className="msg error">{error.message}</div>}

      {cancelling && !isBlock ? (
        <CancelBookingPanel
          reservationId={reservationId}
          paidPaise={data.paidPaise}
          onCancelled={() => {
            refresh();
            onClose();
          }}
          onDismiss={() => setCancelling(false)}
        />
      ) : isBlock ? (
        <p className="muted" style={{ marginTop: 0 }}>
          {data.blockReason ?? 'No reason recorded.'}
        </p>
      ) : (
        <>
          <div className="field">
            <label>Customer</label>
            <div>
              {data.customerName ? (
                <>
                  <strong>{data.customerName}</strong>{' '}
                  <a className="mono" href={`tel:${data.customerPhone}`}>
                    {data.customerPhone}
                  </a>
                </>
              ) : (
                <span className="faint">Walk-in, no details recorded</span>
              )}
            </div>
          </div>

          {data.notes && (
            <div className="field">
              <label>Notes</label>
              <div className="muted">{data.notes}</div>
            </div>
          )}

          <div className="stats" style={{ marginBottom: 16 }}>
            <div className="stat">
              <div className="k">Billed</div>
              <div className="v">{rupees(data.amountPaise)}</div>
            </div>
            <div className="stat">
              <div className="k">Paid</div>
              <div className="v paid-flag">{rupees(data.paidPaise)}</div>
            </div>
            <div className="stat">
              <div className="k">Due</div>
              <div className={`v ${data.duePaise > 0 ? 'due-flag' : ''}`}>{rupees(data.duePaise)}</div>
            </div>
          </div>

          {active && (
            <>
              <label>Record a payment</label>
              <div className="field-row" style={{ marginBottom: 8 }}>
                <input
                  inputMode="decimal"
                  placeholder={data.duePaise > 0 ? String(data.duePaise / 100) : 'Amount ₹'}
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                />
                <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                  {METHODS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="row" style={{ marginBottom: 16 }}>
                <button
                  className="primary sm"
                  onClick={() => addPayment.mutate('in')}
                  disabled={!payAmount || addPayment.isPending}
                >
                  Add payment
                </button>
                <button
                  className="sm"
                  onClick={() => addPayment.mutate('refund')}
                  disabled={!payAmount || addPayment.isPending}
                >
                  Record refund
                </button>
                {data.duePaise > 0 && (
                  <button className="ghost sm" onClick={() => setPayAmount(String(data.duePaise / 100))}>
                    Fill balance
                  </button>
                )}
              </div>
            </>
          )}

          {data.payments.length > 0 && (
            <div className="field">
              <label>Payment history</label>
              <table className="list">
                <tbody>
                  {data.payments.map((p) => (
                    <tr key={p.id}>
                      <td className="mono">
                        {DateTime.fromISO(p.receivedAt, { zone: timezone }).toFormat('d LLL, HH:mm')}
                      </td>
                      <td style={{ textTransform: 'capitalize' }}>{p.method.replace('_', ' ')}</td>
                      <td className={`num mono ${p.direction === 'refund' ? 'due-flag' : ''}`}>
                        {p.direction === 'refund' ? '−' : ''}
                        {rupees(p.amountPaise)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <InvoiceSection reservationId={reservationId} />

          {active && (
            <div className="row wrap" style={{ marginTop: 4 }}>
              {data.status === 'confirmed' && (
                <>
                  <button className="sm" onClick={() => setStatus.mutate('completed')}>
                    Mark played
                  </button>
                  <button className="sm" onClick={() => setStatus.mutate('no_show')}>
                    Mark no-show
                  </button>
                </>
              )}
              {data.status === 'no_show' && (
                <button className="sm" onClick={() => setStatus.mutate('completed')}>
                  They turned up after all
                </button>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

/**
 * The tax invoice for this booking, if the venue issues them.
 *
 * Issued on request rather than automatically: a customer asks for a bill at
 * the counter, and invoicing every booking would produce documents for the ones
 * that get cancelled — each of which then needs a credit note to undo.
 */
function InvoiceSection({ reservationId }: { reservationId: string }) {
  const qc = useQueryClient();
  const { venue } = useVenue();
  const { me } = useAuth();
  const [showing, setShowing] = useState<Invoice | null>(null);
  const [gstin, setGstin] = useState('');
  const [asking, setAsking] = useState(false);

  const { data: issued } = useQuery({
    queryKey: ['invoices', reservationId],
    queryFn: () => get<Invoice[]>(`/reservations/${reservationId}/invoices`),
  });

  const issue = useMutation({
    mutationFn: () =>
      post<Invoice>(`/reservations/${reservationId}/invoice`, {
        ...(gstin.trim() ? { customerGstin: gstin.trim().toUpperCase() } : {}),
      }),
    onSuccess: (invoice) => {
      setAsking(false);
      setGstin('');
      qc.invalidateQueries({ queryKey: ['invoices', reservationId] });
      setShowing(invoice);
    },
  });

  // Nothing to say when the venue does not issue invoices and none exists.
  if (!venue?.invoicingEnabled && !issued?.length) return null;

  return (
    <div className="field">
      <label>Tax invoice</label>

      {issue.error instanceof ApiError && <div className="msg error">{issue.error.message}</div>}

      {issued?.length ? (
        <table className="list">
          <tbody>
            {issued.map((inv) => (
              <tr key={inv.id}>
                <td className="mono">{inv.number}</td>
                <td className="faint">{inv.kind === 'credit_note' ? 'Credit note' : 'Invoice'}</td>
                <td className="num mono">{rupees(inv.totalPaise)}</td>
                <td className="num">
                  <button className="ghost sm" onClick={() => setShowing(inv)}>
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : asking ? (
        <>
          <input
            id="inv-gstin"
            value={gstin}
            onChange={(e) => setGstin(e.target.value.toUpperCase())}
            placeholder="Customer GSTIN (optional)"
            maxLength={15}
          />
          <div className="hint">
            Only needed if a business is claiming credit. Leave blank for a walk-in.
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary sm" disabled={issue.isPending} onClick={() => issue.mutate()}>
              {issue.isPending ? 'Issuing…' : 'Issue invoice'}
            </button>
            <button className="ghost sm" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        me?.role === 'owner' && (
          <button className="sm" onClick={() => setAsking(true)}>
            Issue a tax invoice
          </button>
        )
      )}

      {showing && (
        <Modal title={showing.number} onClose={() => setShowing(null)}>
          <InvoiceView invoice={showing} />
          <div className="row" style={{ marginTop: 16 }}>
            <button className="sm" onClick={() => window.print()}>
              Print or save as PDF
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
