import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { ApiError, del, get, post } from '../lib/api';
import { shortTime, todayIn } from '../lib/format';
import type { Court, DateOverride, Venue } from '../lib/types';

/**
 * Holidays and one-off hours.
 *
 * Distinct from blocking a slot: a closure changes what hours exist at all, so
 * no slot is generated and nothing can be booked into it by accident.
 */
export function ClosuresCard({ venue, courts }: { venue: Venue; courts: Court[] }) {
  const qc = useQueryClient();
  const today = todayIn(venue.timezone);
  const [form, setForm] = useState({
    onDate: today,
    resourceId: '',
    isClosed: true,
    opensAt: '17:00',
    closesAt: '23:00',
    reason: '',
  });

  const { data: overrides } = useQuery({
    queryKey: ['overrides', venue.id],
    queryFn: () => get<DateOverride[]>(`/venues/${venue.id}/overrides?from=${today}`),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['overrides', venue.id] });
    qc.invalidateQueries({ queryKey: ['calendar'] });
    qc.invalidateQueries({ queryKey: ['week'] });
  };

  const create = useMutation({
    mutationFn: () =>
      post(`/venues/${venue.id}/overrides`, {
        onDate: form.onDate,
        ...(form.resourceId ? { resourceId: form.resourceId } : {}),
        isClosed: form.isClosed,
        ...(form.isClosed ? {} : { opensAt: form.opensAt, closesAt: form.closesAt }),
        ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
      }),
    onSuccess: () => {
      setForm({ ...form, reason: '' });
      invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => del(`/overrides/${id}`),
    onSuccess: invalidate,
  });

  const courtName = (id: string | null) =>
    id ? (courts.find((c) => c.id === id)?.name ?? 'Court') : 'Whole venue';

  return (
    <div className="card">
      <div className="card-head">
        <h2>Closures and special hours</h2>
      </div>

      <div className="card-body" style={{ paddingBottom: 8 }}>
        {create.error instanceof ApiError && <div className="msg error">{create.error.message}</div>}

        <div className="field-row">
          <div className="field">
            <label htmlFor="ov-date">Date</label>
            <input
              id="ov-date"
              type="date"
              value={form.onDate}
              onChange={(e) => setForm({ ...form, onDate: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="ov-court">Applies to</label>
            <select
              id="ov-court"
              value={form.resourceId}
              onChange={(e) => setForm({ ...form, resourceId: e.target.value })}
            >
              <option value="">Whole venue</option>
              {courts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ov-what">What happens</label>
            <select
              id="ov-what"
              value={form.isClosed ? 'closed' : 'hours'}
              onChange={(e) => setForm({ ...form, isClosed: e.target.value === 'closed' })}
            >
              <option value="closed">Closed all day</option>
              <option value="hours">Special hours</option>
            </select>
          </div>
        </div>

        <div className="field-row">
          {!form.isClosed && (
            <>
              <div className="field">
                <label htmlFor="ov-from">Opens</label>
                <input
                  id="ov-from"
                  type="time"
                  value={form.opensAt}
                  onChange={(e) => setForm({ ...form, opensAt: e.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="ov-to">Closes</label>
                <input
                  id="ov-to"
                  type="time"
                  value={form.closesAt}
                  onChange={(e) => setForm({ ...form, closesAt: e.target.value })}
                />
              </div>
            </>
          )}
          <div className="field" style={{ flex: 2 }}>
            <label htmlFor="ov-reason">Reason</label>
            <input
              id="ov-reason"
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              placeholder="Diwali / tournament / resurfacing"
            />
          </div>
          <div className="field" style={{ flex: '0 0 auto', alignSelf: 'flex-end' }}>
            <button className="primary" onClick={() => create.mutate()} disabled={create.isPending}>
              Add
            </button>
          </div>
        </div>

        <div className="hint">
          A court-specific entry beats a venue-wide one on the same date, so you can shut the venue
          for a holiday and still open one turf in the evening.
        </div>
      </div>

      {overrides && overrides.length > 0 ? (
        <table className="list">
          <thead>
            <tr>
              <th>Date</th>
              <th>Applies to</th>
              <th>Effect</th>
              <th>Reason</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {overrides.map((o) => (
              <tr key={o.id}>
                <td className="mono">
                  {DateTime.fromISO(o.onDate).toFormat('ccc d LLL yyyy')}
                </td>
                <td>{courtName(o.resourceId)}</td>
                <td>
                  {o.isClosed ? (
                    <span className="pill cancelled">closed</span>
                  ) : (
                    <span className="mono">
                      {shortTime(o.opensAt ?? '')}–{shortTime(o.closesAt ?? '')}
                    </span>
                  )}
                </td>
                <td className="faint">{o.reason ?? ''}</td>
                <td className="num">
                  <button className="danger sm" onClick={() => remove.mutate(o.id)}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="empty" style={{ padding: 24 }}>
          Nothing scheduled. Upcoming closures will be listed here.
        </div>
      )}
    </div>
  );
}
