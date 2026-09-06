import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, post } from '../lib/api';
import type { Venue } from '../lib/types';

const SPORTS = ['badminton', 'cricket', 'tennis', 'football', 'basketball', 'squash', 'pickleball'];

/**
 * First-run setup. An owner with an empty calendar has nothing to look at, so
 * the venue and its courts get created in one step, with sane defaults and a
 * base price so the grid is immediately usable.
 */
export function FirstRun() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [sport, setSport] = useState('badminton');
  const [courtCount, setCourtCount] = useState(3);
  const [opensAt, setOpensAt] = useState('06:00');
  const [closesAt, setClosesAt] = useState('23:00');
  const [rate, setRate] = useState('500');

  const create = useMutation({
    mutationFn: async () => {
      const venue = await post<Venue>('/venues', { name: name.trim(), timezone: 'Asia/Kolkata' });
      for (let i = 0; i < courtCount; i++) {
        const court = await post<{ id: string }>(`/venues/${venue.id}/resources`, {
          name: `${sport === 'cricket' ? 'Turf' : 'Court'} ${i + 1}`,
          sport,
          slotMinutes: 60,
          opensAt,
          closesAt,
          sortOrder: i,
        });
        await post(`/resources/${court.id}/price-rules`, {
          name: 'Base rate',
          pricePerHourPaise: Math.round(Number(rate || '0') * 100),
          priority: 0,
        });
      }
      return venue;
    },
    onSuccess: () => qc.invalidateQueries(),
  });

  return (
    <div className="card" style={{ maxWidth: 520, margin: '40px auto' }}>
      <div className="card-head">
        <h2>Set up your venue</h2>
      </div>
      <div className="card-body">
        <p className="muted" style={{ marginTop: 0 }}>
          One venue, its courts and a base rate. You can rename, add and re-price everything in
          Settings afterwards.
        </p>

        {create.error instanceof ApiError && <div className="msg error">{create.error.message}</div>}

        <div className="field">
          <label htmlFor="v-name">Venue name</label>
          <input
            id="v-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Smash Arena, HSR Layout"
          />
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="v-sport">Sport</label>
            <select id="v-sport" value={sport} onChange={(e) => setSport(e.target.value)}>
              {SPORTS.map((s) => (
                <option key={s} value={s} style={{ textTransform: 'capitalize' }}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="v-count">How many courts?</label>
            <input
              id="v-count"
              type="number"
              min={1}
              max={20}
              value={courtCount}
              onChange={(e) => setCourtCount(Math.max(1, Math.min(20, Number(e.target.value))))}
            />
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="v-open">Opens</label>
            <input id="v-open" type="time" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="v-close">Closes</label>
            <input id="v-close" type="time" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="v-rate">Rate per hour (₹)</label>
            <input id="v-rate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
          </div>
        </div>

        <button
          className="primary"
          style={{ width: '100%', padding: 9 }}
          disabled={!name.trim() || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? 'Creating…' : 'Create venue and courts'}
        </button>
      </div>
    </div>
  );
}
