import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { ApiError, post } from '../lib/api';
import type { CalendarCourt } from '../lib/types';
import { Modal } from './Modal';

interface Props {
  courts: CalendarCourt[];
  date: string;
  timezone: string;
  onClose: () => void;
}

/** Rain, maintenance, a tournament — the calendar has to be able to say "not available". */
export function BlockModal({ courts, date, timezone, onClose }: Props) {
  const qc = useQueryClient();
  const [courtId, setCourtId] = useState(courts[0]?.id ?? '');
  const [from, setFrom] = useState('06:00');
  const [to, setTo] = useState('23:00');
  const [reason, setReason] = useState('');

  const toInstant = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return DateTime.fromISO(date, { zone: timezone }).startOf('day').plus({ hours: h, minutes: m }).toISO()!;
  };

  const save = useMutation({
    mutationFn: () =>
      post('/reservations/block', {
        resourceId: courtId,
        start: toInstant(from),
        end: toInstant(to),
        reason: reason.trim() || 'Unavailable',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['calendar'] });
      qc.invalidateQueries({ queryKey: ['week'] });
      onClose();
    },
  });

  return (
    <Modal
      title="Block time"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => save.mutate()} disabled={save.isPending || !courtId}>
            {save.isPending ? 'Blocking…' : 'Block'}
          </button>
        </>
      }
    >
      {save.error instanceof ApiError && <div className="msg error">{save.error.message}</div>}

      <div className="field">
        <label htmlFor="block-court">Court</label>
        <select id="block-court" value={courtId} onChange={(e) => setCourtId(e.target.value)}>
          {courts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="block-from">From</label>
          <input id="block-from" type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="block-to">To</label>
          <input id="block-to" type="time" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      <div className="field">
        <label htmlFor="block-reason">Reason</label>
        <input
          id="block-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Rain / maintenance / tournament"
        />
      </div>

      <div className="hint">
        Blocking a slot that is already booked will be refused — cancel the booking first.
      </div>
    </Modal>
  );
}
