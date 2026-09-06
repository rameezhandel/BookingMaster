import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ClosuresCard } from '../components/ClosuresCard';
import { HoursModal } from '../components/HoursModal';
import { Modal } from '../components/Modal';
import { ApiError, del, get, patch, post } from '../lib/api';
import { DAY_NAMES, describeDays, paiseFromRupeeInput, rupees, shortTime } from '../lib/format';
import type { Court, PriceRule, Venue } from '../lib/types';

export function SettingsPage() {
  const { data: venues } = useQuery({ queryKey: ['venues'], queryFn: () => get<Venue[]>('/venues') });
  const venue = venues?.[0];

  const { data: courts } = useQuery({
    queryKey: ['courts', venue?.id],
    queryFn: () => get<Court[]>(`/venues/${venue!.id}/resources?includeInactive=true`),
    enabled: !!venue,
  });

  if (!venue) return <div className="empty card">No venue yet.</div>;

  return (
    <div className="stack">
      <VenueCard venue={venue} />
      <CourtsCard venue={venue} />
      <ClosuresCard venue={venue} courts={courts ?? []} />
    </div>
  );
}

function VenueCard({ venue }: { venue: Venue }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: venue.name,
    timezone: venue.timezone,
    address: venue.address ?? '',
    phone: venue.phone ?? '',
  });

  const save = useMutation({
    mutationFn: () => patch(`/venues/${venue.id}`, form),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['venues'] }),
  });

  return (
    <div className="card">
      <div className="card-head">
        <h2>Venue</h2>
        <span className="spacer" />
        {save.isSuccess && <span className="faint">Saved</span>}
        <button className="primary sm" onClick={() => save.mutate()} disabled={save.isPending}>
          Save
        </button>
      </div>
      <div className="card-body">
        {save.error instanceof ApiError && <div className="msg error">{save.error.message}</div>}
        <div className="field-row">
          <div className="field">
            <label htmlFor="s-name">Name</label>
            <input id="s-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="s-tz">Timezone</label>
            <input
              id="s-tz"
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
            />
            <div className="hint">IANA name, e.g. Asia/Kolkata.</div>
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="s-addr">Address</label>
            <input
              id="s-addr"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="s-phone">Phone</label>
            <input id="s-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
        </div>
      </div>
    </div>
  );
}

function CourtsCard({ venue }: { venue: Venue }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [pricingFor, setPricingFor] = useState<Court | null>(null);
  const [hoursFor, setHoursFor] = useState<Court | null>(null);

  const { data: courts } = useQuery({
    queryKey: ['courts', venue.id],
    queryFn: () => get<Court[]>(`/venues/${venue.id}/resources?includeInactive=true`),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['courts', venue.id] });
    qc.invalidateQueries({ queryKey: ['calendar'] });
  };

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Court> }) => patch(`/resources/${id}`, body),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => del(`/resources/${id}`),
    onSuccess: invalidate,
  });

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>Courts</h2>
          <span className="spacer" />
          <button className="primary sm" onClick={() => setAdding(true)}>
            Add court
          </button>
        </div>

        {remove.error instanceof ApiError && (
          <div style={{ padding: '12px 16px 0' }}>
            <div className="msg error">{remove.error.message}</div>
          </div>
        )}

        <table className="list">
          <thead>
            <tr>
              <th>Name</th>
              <th>Sport</th>
              <th>Slot</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {courts?.map((court) => (
              <tr key={court.id}>
                <td>
                  <strong>{court.name}</strong>
                </td>
                <td className="faint" style={{ textTransform: 'capitalize' }}>
                  {court.sport}
                </td>
                <td className="mono">{court.slotMinutes}m</td>
                <td>
                  <span className={`pill ${court.isActive ? 'confirmed' : 'cancelled'}`}>
                    {court.isActive ? 'active' : 'inactive'}
                  </span>
                </td>
                <td className="num">
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <button className="sm" onClick={() => setHoursFor(court)}>
                      Hours
                    </button>
                    <button className="sm" onClick={() => setPricingFor(court)}>
                      Pricing
                    </button>
                    <button
                      className="sm"
                      onClick={() => update.mutate({ id: court.id, body: { isActive: !court.isActive } })}
                    >
                      {court.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                    <button className="danger sm" onClick={() => remove.mutate(court.id)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adding && <AddCourtModal venue={venue} onClose={() => setAdding(false)} />}
      {hoursFor && <HoursModal court={hoursFor} onClose={() => setHoursFor(null)} />}
      {pricingFor && <PricingModal court={pricingFor} onClose={() => setPricingFor(null)} />}
    </>
  );
}

function AddCourtModal({ venue, onClose }: { venue: Venue; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: '',
    sport: 'badminton',
    slotMinutes: 60,
    opensAt: '06:00',
    closesAt: '23:00',
  });

  const create = useMutation({
    mutationFn: () => post(`/venues/${venue.id}/resources`, form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['courts', venue.id] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
      onClose();
    },
  });

  return (
    <Modal
      title="Add court"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => create.mutate()} disabled={!form.name.trim() || create.isPending}>
            Add
          </button>
        </>
      }
    >
      {create.error instanceof ApiError && <div className="msg error">{create.error.message}</div>}
      <div className="field">
        <label htmlFor="c-name">Name</label>
        <input id="c-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Court 4" />
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="c-sport">Sport</label>
          <input id="c-sport" value={form.sport} onChange={(e) => setForm({ ...form, sport: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="c-slot">Slot length</label>
          <select
            id="c-slot"
            value={form.slotMinutes}
            onChange={(e) => setForm({ ...form, slotMinutes: Number(e.target.value) })}
          >
            {[30, 60, 90, 120].map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="c-open">Opens</label>
          <input id="c-open" type="time" value={form.opensAt} onChange={(e) => setForm({ ...form, opensAt: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="c-close">Closes</label>
          <input id="c-close" type="time" value={form.closesAt} onChange={(e) => setForm({ ...form, closesAt: e.target.value })} />
        </div>
      </div>
      <div className="hint">
        These hours apply to every day to start with. Refine them per day, including midday
        closures, with the Hours button afterwards.
      </div>
    </Modal>
  );
}

function PricingModal({ court, onClose }: { court: Court; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: '',
    days: [0, 1, 2, 3, 4, 5, 6],
    startsAt: '00:00',
    endsAt: '24:00',
    rate: '',
    priority: 0,
  });

  const { data: rules } = useQuery({
    queryKey: ['price-rules', court.id],
    queryFn: () => get<PriceRule[]>(`/resources/${court.id}/price-rules`),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['price-rules', court.id] });
    qc.invalidateQueries({ queryKey: ['calendar'] });
  };

  const create = useMutation({
    mutationFn: () =>
      post(`/resources/${court.id}/price-rules`, {
        name: form.name.trim() || 'Rate',
        days: form.days,
        startsAt: form.startsAt,
        endsAt: form.endsAt,
        pricePerHourPaise: paiseFromRupeeInput(form.rate),
        priority: Number(form.priority),
      }),
    onSuccess: () => {
      setForm({ ...form, name: '', rate: '' });
      invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => del(`/price-rules/${id}`),
    onSuccess: invalidate,
  });

  function toggleDay(day: number) {
    setForm({
      ...form,
      days: form.days.includes(day) ? form.days.filter((d) => d !== day) : [...form.days, day].sort(),
    });
  }

  return (
    <Modal title={`Pricing — ${court.name}`} onClose={onClose} footer={<><span className="spacer" /><button onClick={onClose}>Done</button></>}>
      <p className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
        Rates are per hour. When two rules cover the same slot the higher priority wins, so put your
        base rate at 0 and layer peak and weekend rates above it.
      </p>

      {rules && rules.length > 0 && (
        <table className="list" style={{ marginBottom: 18 }}>
          <thead>
            <tr>
              <th>Rule</th>
              <th>When</th>
              <th className="num">Rate/hr</th>
              <th className="num">Pri</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>{r.name}</strong>
                </td>
                <td className="faint" style={{ fontSize: 12 }}>
                  {describeDays(r.days)}
                  <br />
                  <span className="mono">
                    {shortTime(r.startsAt)}–{shortTime(r.endsAt)}
                  </span>
                </td>
                <td className="num mono">{rupees(r.pricePerHourPaise)}</td>
                <td className="num mono">{r.priority}</td>
                <td className="num">
                  <button className="danger sm" onClick={() => remove.mutate(r.id)}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {create.error instanceof ApiError && <div className="msg error">{create.error.message}</div>}

      <h3 style={{ marginBottom: 10 }}>Add a rule</h3>

      <div className="field-row">
        <div className="field">
          <label htmlFor="p-name">Name</label>
          <input
            id="p-name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Evening peak"
          />
        </div>
        <div className="field">
          <label htmlFor="p-rate">Rate per hour (₹)</label>
          <input id="p-rate" inputMode="decimal" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} />
        </div>
      </div>

      <div className="field">
        <label>Days</label>
        <div className="row wrap">
          {DAY_NAMES.map((label, day) => (
            <button
              key={day}
              type="button"
              className={form.days.includes(day) ? 'primary sm' : 'sm'}
              onClick={() => toggleDay(day)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="p-from">From</label>
          <input id="p-from" type="time" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="p-to">To</label>
          <input id="p-to" type="time" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="p-pri">Priority</label>
          <input
            id="p-pri"
            type="number"
            value={form.priority}
            onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
          />
        </div>
      </div>

      <button
        className="primary"
        style={{ width: '100%' }}
        onClick={() => create.mutate()}
        disabled={!form.rate || form.days.length === 0 || create.isPending}
      >
        Add rule
      </button>
    </Modal>
  );
}
