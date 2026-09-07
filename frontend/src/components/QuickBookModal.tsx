import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { ApiError, get, post } from '../lib/api';
import { paiseFromRupeeInput, rangeIn, rupees } from '../lib/format';
import { Modal } from './Modal';
import { SeriesResult } from './SeriesResult';
import type { CreateSeriesResult } from '../lib/types';
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
  const [allowOutsideHours, setAllowOutsideHours] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [weeks, setWeeks] = useState(12);
  const [seriesResult, setSeriesResult] = useState<CreateSeriesResult | null>(null);
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

  // The variable is "book even though the court is shut", so the type has to be
  // explicit: a defaulted parameter makes TanStack infer void.
  const save = useMutation<unknown, Error, boolean>({
    mutationFn: (force: boolean) =>
      post('/reservations', {
        resourceId: court.id,
        start: slotStart,
        end,
        ...(force ? { allowOutsideHours: true } : {}),
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

  // A recurring booking is created from the slot the owner already picked, so
  // the weekday, time and duration need no re-entry.
  const startLocal = DateTime.fromISO(slotStart, { zone: timezone });
  const createSeries = useMutation<CreateSeriesResult, Error>({
    mutationFn: () =>
      post<CreateSeriesResult>('/series', {
        resourceId: court.id,
        dayOfWeek: startLocal.weekday % 7,
        startsAt: startLocal.toFormat('HH:mm'),
        durationMinutes: minutes,
        startsOn: startLocal.toISODate(),
        weeks,
        ...(customer.name.trim() && customer.phone.trim()
          ? { customer: { name: customer.name.trim(), phone: customer.phone.trim() } }
          : {}),
        ...(amountTouched ? { amountPaise: paiseFromRupeeInput(effectiveAmount || '0') } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['calendar'] });
      qc.invalidateQueries({ queryKey: ['week'] });
      qc.invalidateQueries({ queryKey: ['series'] });
      setSeriesResult(result);
    },
  });

  const nameGiven = customer.name.trim().length > 0;
  const phoneGiven = customer.phone.trim().length > 0;
  const halfFilled = nameGiven !== phoneGiven;

  if (seriesResult) {
    return (
      <Modal
        title="Recurring booking created"
        onClose={onClose}
        footer={
          <>
            <span className="spacer" />
            <button className="primary" onClick={onClose}>
              Done
            </button>
          </>
        }
      >
        <SeriesResult result={seriesResult} timezone={timezone} />
      </Modal>
    );
  }

  return (
    <Modal
      title={repeat ? 'New recurring booking' : 'New booking'}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            onClick={() => (repeat ? createSeries.mutate() : save.mutate(allowOutsideHours))}
            disabled={save.isPending || createSeries.isPending || halfFilled}
          >
            {save.isPending || createSeries.isPending
              ? 'Saving…'
              : repeat
                ? `Book ${weeks} weeks`
                : 'Book'}
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

      {createSeries.error instanceof ApiError && (
        <div className="msg error">{createSeries.error.message}</div>
      )}

      {save.error instanceof ApiError && (
        <div className="msg error">
          {save.error.message}
          {save.error.code === 'OutsideOpeningHours' && (
            <div style={{ marginTop: 8 }}>
              <button
                className="sm"
                onClick={() => {
                  setAllowOutsideHours(true);
                  save.mutate(true);
                }}
              >
                Book anyway
              </button>
            </div>
          )}
        </div>
      )}

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

      <div className="repeat-box">
        <label className="checkline">
          <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
          <span>
            Repeat every <strong>{startLocal.toFormat('cccc')}</strong> at{' '}
            <strong>{startLocal.toFormat('HH:mm')}</strong>
          </span>
        </label>

        {repeat && (
          <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
            <label htmlFor="weeks">For how long?</label>
            <select id="weeks" value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>
              {[4, 8, 12, 26, 52].map((w) => (
                <option key={w} value={w}>
                  {w} weeks
                </option>
              ))}
            </select>
            <div className="hint">
              Bookings are created now for this many weeks and topped up nightly. Weeks that clash
              with an existing booking, or fall on a closure, are reported rather than forced.
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
