import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { ApiError, del, get, patch, post } from '../lib/api';
import { paiseFromRupeeInput, rangeIn, rupees } from '../lib/format';
import type { Payment } from '../lib/types';
import { Modal } from './Modal';

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

  const cancel = useMutation({
    mutationFn: () => post(`/reservations/${reservationId}/cancel`),
    onSuccess: () => {
      refresh();
      onClose();
    },
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
  const error = [addPayment.error, setStatus.error, cancel.error].find((e) => e instanceof ApiError) as
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
            active && (
              <button className="danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
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

      {isBlock ? (
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
