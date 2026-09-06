import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, get, post } from '../lib/api';
import { paiseFromRupeeInput, rupees } from '../lib/format';
import type { RefundQuote } from '../lib/types';

const METHODS = ['cash', 'upi', 'card', 'bank_transfer', 'other'] as const;

/**
 * Cancelling, with the refund shown *before* the owner commits.
 *
 * Telling a customer what they get back after the booking is already cancelled
 * is the wrong order, so the policy is quoted first and the number stays
 * editable — the policy is a default, not a straitjacket.
 */
export function CancelBookingPanel({
  reservationId,
  paidPaise,
  onCancelled,
  onDismiss,
}: {
  reservationId: string;
  paidPaise: number;
  onCancelled: () => void;
  onDismiss: () => void;
}) {
  const qc = useQueryClient();
  const [refund, setRefund] = useState('');
  const [touched, setTouched] = useState(false);
  const [record, setRecord] = useState(true);
  const [method, setMethod] = useState<string>('upi');
  const [reason, setReason] = useState('');

  const { data: quote, isLoading } = useQuery({
    queryKey: ['cancellation-quote', reservationId],
    queryFn: () => get<RefundQuote>(`/reservations/${reservationId}/cancellation-quote`),
  });

  useEffect(() => {
    if (quote && !touched) setRefund(String(quote.refundPaise / 100));
  }, [quote, touched]);

  const cancel = useMutation({
    mutationFn: () =>
      post(`/reservations/${reservationId}/cancel`, {
        refundPaise: paiseFromRupeeInput(refund || '0'),
        recordRefund: record,
        refundMethod: method,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['calendar'] });
      qc.invalidateQueries({ queryKey: ['week'] });
      qc.invalidateQueries({ queryKey: ['bookings'] });
      qc.invalidateQueries({ queryKey: ['reservation', reservationId] });
      onCancelled();
    },
  });

  if (isLoading || !quote) return <span className="faint">Working out the refund…</span>;

  const refundPaise = paiseFromRupeeInput(refund || '0');

  return (
    <>
      <div className="msg error" style={{ marginBottom: 14 }}>
        This cancels the booking. It stays on the books as cancelled, so the record and any
        payments are kept.
      </div>

      {quote.configured ? (
        <div className="slot-banner" style={{ marginBottom: 14 }}>
          <div>
            <div className="court">
              {quote.refundPct}% refund
              {quote.tier && (
                <span className="faint" style={{ fontWeight: 400 }}>
                  {' '}
                  · cancelling {quote.hoursBefore}h ahead
                </span>
              )}
            </div>
            <div className="when">
              {quote.tier
                ? `Policy: ${quote.tier.refundPct}% when cancelled at least ${quote.tier.minHoursBefore}h before`
                : 'Below every threshold in your policy'}
            </div>
          </div>
          <div style={{ fontWeight: 650 }}>{rupees(quote.refundPaise)}</div>
        </div>
      ) : (
        <div className="msg info" style={{ marginBottom: 14 }}>
          No cancellation policy is set for this venue, so there is nothing to apply. Enter a refund
          by hand if you are giving one, or set a policy in Settings.
        </div>
      )}

      {quote.cappedByPaid && quote.configured && (
        <div className="hint" style={{ marginTop: -8, marginBottom: 12 }}>
          The policy allows more, but only {rupees(paidPaise)} was ever collected.
        </div>
      )}

      {cancel.error instanceof ApiError && <div className="msg error">{cancel.error.message}</div>}

      <div className="field-row">
        <div className="field">
          <label htmlFor="refund">Refund (₹)</label>
          <input
            id="refund"
            inputMode="decimal"
            value={refund}
            onChange={(e) => {
              setTouched(true);
              setRefund(e.target.value);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="refund-method">Refund by</label>
          <select
            id="refund-method"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            disabled={!record || refundPaise === 0}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m.replace('_', ' ')}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <label htmlFor="cancel-reason">Reason</label>
        <input
          id="cancel-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Optional — e.g. customer called off"
        />
      </div>

      <label className="checkline" style={{ marginBottom: 14 }}>
        <input
          type="checkbox"
          checked={record}
          onChange={(e) => setRecord(e.target.checked)}
          disabled={refundPaise === 0}
        />
        <span>
          Record {rupees(refundPaise)} as a refund in the payment ledger
          {refundPaise === 0 && <span className="faint"> — nothing to record</span>}
        </span>
      </label>

      <div className="row">
        <button className="danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
          {cancel.isPending ? 'Cancelling…' : 'Cancel this booking'}
        </button>
        <button onClick={onDismiss}>Keep it</button>
      </div>
    </>
  );
}
