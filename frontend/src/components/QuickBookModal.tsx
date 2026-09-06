import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { ApiError, get, post } from '../lib/api';
import { paiseFromRupeeInput, rangeIn, rupees } from '../lib/format';
import { Modal } from './Modal';
import { CustomerPicker } from './CustomerPicker';

interface Props {
  court: { id: string; name: string; slotMinutes: number };
  slotStart: string;
  slotEnd: string;
  suggestedPaise: number | null;
  timezone: string;
  onClose: () => void;
}

const DURATIONS = [30, 60, 90, 120, 180];

/**
 * The three-tap path: click a free slot, type a name, save.
 *
 * Everything else is pre-filled — court, time, and the price the rules imply —
 * because the owner is usually mid-phone-call while doing this.
 */
export function QuickBookModal({ court, slotStart, slotEnd, suggestedPaise, timezone, onClose }: Props) {
  const qc = useQueryClient();
  const defaultMinutes = Math.round(
    DateTime.fromISO(slotEnd).diff(DateTime.fromISO(slotStart), 'minutes').minutes,
  );

  const [minutes, setMinutes] = useState(defaultMinutes);
  const [customer, setCustomer] = useState({ name: '', phone: '' });
  const [notes, setNotes] = useState('');
  const [amountTouched, setAmountTouched] = useState(false);
  const [amount, setAmount] = useState(suggestedPaise !== null ? String(suggestedPaise / 100) : '');

  const end = DateTime.fromISO(slotStart).plus({ minutes }).toISO()!;

  // Re-quote when the owner stretches the booking past the default slot.
  const { data: quote } = useQuery({
    queryKey: ['quote', court.id, slotStart, minutes],
    queryFn: () =>
      get<{ pricePaise: number | null }>(
        `/pricing/quote?resourceId=${court.id}&start=${encodeURIComponent(slotStart)}&end=${encodeURIComponent(end)}`,
      ),
    enabled: minutes !== defaultMinutes,
  });

  const quoted = minutes === defaultMinutes ? suggestedPaise : (quote?.pricePaise ?? null);
  const effectiveAmount = amountTouched ? amount : quoted !== null ? String(quoted / 100) : '';

  const save = useMutation({
    mutationFn: () =>
      post('/reservations', {
        resourceId: court.id,
        start: slotStart,
        end,
        ...(customer.name.trim() && customer.phone.trim()
          ? { customer: { name: customer.name.trim(), phone: customer.phone.trim() } }
          : {}),
        amountPaise: paiseFromRupeeInput(effectiveAmount || '0'),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['calendar'] });
      qc.invalidateQueries({ queryKey: ['week'] });
      onClose();
    },
  });

  const nameGiven = customer.name.trim().length > 0;
  const phoneGiven = customer.phone.trim().length > 0;
  const halfFilled = nameGiven !== phoneGiven;

  return (
    <Modal
      title="New booking"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            onClick={() => save.mutate()}
            disabled={save.isPending || halfFilled}
          >
            {save.isPending ? 'Saving…' : 'Book'}
          </button>
        </>
      }
    >
      <div className="slot-banner">
        <div>
          <div className="court">{court.name}</div>
          <div className="when">{rangeIn(slotStart, end, timezone)}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="faint" style={{ fontSize: 11, textTransform: 'uppercase' }}>
            Rule price
          </div>
          <div style={{ fontWeight: 650 }}>{quoted === null ? 'No price set' : rupees(quoted)}</div>
        </div>
      </div>

      {save.error instanceof ApiError && <div className="msg error">{save.error.message}</div>}

      <div className="field">
        <label htmlFor="duration">Duration</label>
        <select id="duration" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
          {DURATIONS.map((m) => (
            <option key={m} value={m}>
              {m < 60 ? `${m} min` : `${m / 60} hour${m > 60 ? 's' : ''}`}
            </option>
          ))}
        </select>
      </div>

      <CustomerPicker name={customer.name} phone={customer.phone} onChange={setCustomer} />
      {halfFilled && (
        <div className="hint" style={{ marginTop: -8, marginBottom: 12 }}>
          Enter both a name and a phone number, or leave both blank for a walk-in.
        </div>
      )}

      <div className="field">
        <label htmlFor="amount">Amount (₹)</label>
        <input
          id="amount"
          inputMode="decimal"
          value={effectiveAmount}
          onChange={(e) => {
            setAmountTouched(true);
            setAmount(e.target.value);
          }}
          placeholder="0"
        />
        <div className="hint">Pre-filled from your price rules. Override it for a one-off rate.</div>
      </div>

      <div className="field">
        <label htmlFor="notes">Notes</label>
        <input
          id="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional — e.g. regular Tuesday group"
        />
      </div>
    </Modal>
  );
}
