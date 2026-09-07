import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { ApiError, get, patch, post } from '../lib/api';
import { paiseFromRupeeInput, rupees } from '../lib/format';
import { useVenue } from '../lib/venue';
import type { Court, Enquiry, EnquiryStatus, HallAvailability } from '../lib/types';

const STATUS_LABEL: Record<EnquiryStatus, string> = {
  new: 'New',
  visit_scheduled: 'Visit booked',
  quoted: 'Quoted',
  won: 'Booked',
  lost: 'Lost',
};

/** How far ahead the diary looks. Weddings are booked a year out. */
const HORIZON_DAYS = 365;

function dateLabel(date: string, tz: string): string {
  return DateTime.fromISO(date, { zone: tz }).toFormat('ccc d LLL yyyy');
}

/**
 * The halls side of the venue.
 *
 * Halls are sold by the event, not by the hour, so they get their own page
 * rather than a lane on the court grid: the questions are "who has asked about
 * the 14th" and "is the 14th still free", and neither is a slot.
 */
export function HallsPage() {
  const { venue, timezone: tz } = useVenue();
  const [includeClosed, setIncludeClosed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const { data: halls } = useQuery({
    queryKey: ['halls', venue?.id],
    queryFn: () => get<Court[]>(`/venues/${venue!.id}/resources?kind=hall`),
    enabled: !!venue,
  });

  const { data: enquiries, isLoading } = useQuery({
    queryKey: ['enquiries', venue?.id, includeClosed],
    queryFn: () =>
      get<Enquiry[]>(`/venues/${venue!.id}/enquiries?includeClosed=${includeClosed}`),
    enabled: !!venue,
  });

  const today = DateTime.now().setZone(tz).startOf('day');
  const { data: availability } = useQuery({
    queryKey: ['hall-availability', venue?.id],
    queryFn: () =>
      get<HallAvailability>(
        `/venues/${venue!.id}/halls/availability?from=${today.toISODate()}&to=${today
          .plus({ days: HORIZON_DAYS })
          .toISODate()}`,
      ),
    enabled: !!venue,
  });

  const open = enquiries?.find((e) => e.id === openId) ?? null;

  if (venue && halls && halls.length === 0) {
    return (
      <div className="card">
        <div className="empty">
          <h3>No halls at {venue.name}</h3>
          <p>
            Add one under Settings → Courts and halls. A hall is booked by the event rather than
            by the hour, so it gets this page instead of a lane on the calendar.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="cal-head">
        <h1>Halls</h1>
        <span className="spacer" />
        <label className="row" style={{ gap: 6, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={includeClosed}
            onChange={(e) => setIncludeClosed(e.target.checked)}
          />
          Show booked and lost
        </label>
        <button className="primary sm" onClick={() => setAdding(true)}>
          New enquiry
        </button>
      </div>

      <DiaryCard availability={availability} />

      <div className="card">
        <div className="card-head">
          <h2>Enquiries</h2>
          <span className="spacer" />
          <span className="faint" style={{ fontSize: 12 }}>
            An enquiry does not hold a date. Holding one is a separate, deliberate act.
          </span>
        </div>

        {isLoading ? (
          <div className="empty">Loading…</div>
        ) : !enquiries?.length ? (
          <div className="empty">
            <h3>{includeClosed ? 'Nothing here yet' : 'Nothing open'}</h3>
            <p>Enquiries you take on the phone go here, and follow the customer to a booking.</p>
          </div>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>Contact</th>
                <th>Event</th>
                <th>Date</th>
                <th className="num">Guests</th>
                <th className="num">Quoted</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {enquiries.map((e) => (
                <tr key={e.id} onClick={() => setOpenId(e.id)} style={{ cursor: 'pointer' }}>
                  <td>
                    <strong>{e.contactName}</strong>
                    <div className="faint mono" style={{ fontSize: 12 }}>
                      {e.contactPhone}
                    </div>
                  </td>
                  <td>
                    {e.eventType ?? <span className="faint">—</span>}
                    {e.hallName && (
                      <div className="faint" style={{ fontSize: 12 }}>
                        {e.hallName}
                      </div>
                    )}
                  </td>
                  <td>
                    {e.eventDate ? (
                      dateLabel(e.eventDate, tz)
                    ) : (
                      <span className="faint">Not decided</span>
                    )}
                  </td>
                  <td className="num mono">{e.guestCount ?? '—'}</td>
                  <td className="num mono">{e.quotedPaise ? rupees(e.quotedPaise) : '—'}</td>
                  <td>
                    <span className={`pill ${e.status}`}>{STATUS_LABEL[e.status]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {adding && venue && (
        <NewEnquiryModal venue={venue.id} halls={halls ?? []} onClose={() => setAdding(false)} />
      )}
      {open && (
        <EnquiryModal
          enquiry={open}
          halls={halls ?? []}
          tz={tz}
          onClose={() => setOpenId(null)}
        />
      )}
    </>
  );
}

/**
 * The dates already committed, per hall.
 *
 * This is the sheet an owner keeps by the phone. A held date is shown as held
 * and with its release date, because a hold someone has forgotten about is
 * worse than no hold at all.
 */
function DiaryCard({ availability }: { availability: HallAvailability | undefined }) {
  const [check, setCheck] = useState('');

  const clash = useMemo(() => {
    if (!availability || !check) return null;
    return availability.halls.map((hall) => ({
      name: hall.name,
      // Both ends inclusive: `to` is the last day the hall is unavailable, not
      // the first day it is free again.
      taken: hall.bookings.find((b) => b.from <= check && check <= b.to) ?? null,
    }));
  }, [availability, check]);

  if (!availability) return null;
  const tz = availability.timezone;

  return (
    <div className="card">
      <div className="card-head">
        <h2>The diary</h2>
        <span className="spacer" />
        <label htmlFor="hall-check" className="faint" style={{ fontSize: 12 }}>
          Is a date free?
        </label>
        <input
          id="hall-check"
          type="date"
          value={check}
          onChange={(e) => setCheck(e.target.value)}
          style={{ width: 150 }}
        />
      </div>

      {clash && (
        <div style={{ padding: '0 16px 12px' }}>
          {clash.map((c) => (
            <div key={c.name} className={`msg ${c.taken ? 'error' : 'info'}`} style={{ marginBottom: 8 }}>
              <strong>{c.name}</strong>{' '}
              {c.taken
                ? `is ${c.taken.status === 'held' ? 'on hold' : 'booked'}${
                    c.taken.customerName ? ` for ${c.taken.customerName}` : ''
                  } on ${dateLabel(check, tz)}.`
                : `is free on ${dateLabel(check, tz)}.`}
            </div>
          ))}
        </div>
      )}

      {availability.halls.map((hall) => (
        <div key={hall.id}>
          <div
            className="faint"
            style={{ padding: '8px 16px 4px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}
          >
            {hall.name}
          </div>
          {hall.bookings.length === 0 ? (
            <div className="faint" style={{ padding: '0 16px 12px', fontSize: 13 }}>
              Nothing booked in the next year.
            </div>
          ) : (
            <table className="list">
              <tbody>
                {[...hall.bookings]
                  .sort((a, b) => a.from.localeCompare(b.from))
                  .map((b) => (
                    <tr key={b.id}>
                      <td style={{ width: 190 }}>
                        <strong>{dateLabel(b.from, tz)}</strong>
                        {b.eventFrom && (
                          <div className="faint mono" style={{ fontSize: 12 }}>
                            {DateTime.fromISO(b.eventFrom, { zone: tz }).toFormat('HH:mm')}–
                            {b.eventTo
                              ? DateTime.fromISO(b.eventTo, { zone: tz }).toFormat('HH:mm')
                              : ''}
                          </div>
                        )}
                      </td>
                      <td>{b.customerName ?? <span className="faint">—</span>}</td>
                      <td>
                        <span className={`pill ${b.status}`}>
                          {b.status === 'held' ? 'on hold' : b.status}
                        </span>
                        {b.holdUntil && (
                          <span className="faint" style={{ fontSize: 12, marginLeft: 8 }}>
                            released {DateTime.fromISO(b.holdUntil, { zone: tz }).toFormat('d LLL')}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}

function NewEnquiryModal({
  venue,
  halls,
  onClose,
}: {
  venue: string;
  halls: Court[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    contactName: '',
    contactPhone: '',
    contactEmail: '',
    resourceId: halls[0]?.id ?? '',
    eventType: '',
    eventDate: '',
    guestCount: '',
    notes: '',
  });

  const create = useMutation({
    mutationFn: () =>
      post(`/venues/${venue}/enquiries`, {
        contactName: form.contactName.trim(),
        contactPhone: form.contactPhone.trim(),
        contactEmail: form.contactEmail.trim() || undefined,
        resourceId: form.resourceId || undefined,
        eventType: form.eventType.trim() || undefined,
        eventDate: form.eventDate || undefined,
        guestCount: form.guestCount ? Number(form.guestCount) : undefined,
        notes: form.notes.trim() || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enquiries'] });
      onClose();
    },
  });

  return (
    <Modal
      title="New enquiry"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            onClick={() => create.mutate()}
            disabled={!form.contactName.trim() || !form.contactPhone.trim() || create.isPending}
          >
            Save
          </button>
        </>
      }
    >
      {create.error instanceof ApiError && <div className="msg error">{create.error.message}</div>}
      <div className="field-row">
        <div className="field">
          <label htmlFor="e-name">Name</label>
          <input
            id="e-name"
            value={form.contactName}
            onChange={(e) => setForm({ ...form, contactName: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="e-phone">Phone</label>
          <input
            id="e-phone"
            value={form.contactPhone}
            onChange={(e) => setForm({ ...form, contactPhone: e.target.value })}
            placeholder="+9198…"
          />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="e-type">Occasion</label>
          <input
            id="e-type"
            value={form.eventType}
            onChange={(e) => setForm({ ...form, eventType: e.target.value })}
            placeholder="Wedding reception"
          />
        </div>
        <div className="field">
          <label htmlFor="e-hall">Hall</label>
          <select
            id="e-hall"
            value={form.resourceId}
            onChange={(e) => setForm({ ...form, resourceId: e.target.value })}
          >
            <option value="">Not decided</option>
            {halls.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="e-date">Date</label>
          <input
            id="e-date"
            type="date"
            value={form.eventDate}
            onChange={(e) => setForm({ ...form, eventDate: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="e-guests">Guests</label>
          <input
            id="e-guests"
            type="number"
            min={1}
            value={form.guestCount}
            onChange={(e) => setForm({ ...form, guestCount: e.target.value })}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor="e-notes">Notes</label>
        <textarea
          id="e-notes"
          rows={3}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          placeholder="What they asked for, what you promised."
        />
      </div>
      <div className="hint">
        Leave the date blank while it is still "sometime in November". Nothing here holds the
        hall — use Hold or Book once they are serious.
      </div>
    </Modal>
  );
}

function EnquiryModal({
  enquiry,
  halls,
  tz,
  onClose,
}: {
  enquiry: Enquiry;
  halls: Court[];
  tz: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [booking, setBooking] = useState(false);
  const [losing, setLosing] = useState(false);
  const [lostReason, setLostReason] = useState('');
  const [visitAt, setVisitAt] = useState('');
  const [quote, setQuote] = useState(
    enquiry.quotedPaise ? String(enquiry.quotedPaise / 100) : '',
  );

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['enquiries'] });
    qc.invalidateQueries({ queryKey: ['hall-availability'] });
  };

  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch(`/enquiries/${enquiry.id}`, body),
    onSuccess: () => {
      invalidate();
      setLosing(false);
    },
  });

  const settled = enquiry.status === 'won' || enquiry.status === 'lost';

  // Shown instead of this one rather than on top of it: a modal inside a modal
  // takes two Escapes to leave and traps the second one inside a scroll box.
  if (booking) {
    return (
      <BookModal
        enquiry={enquiry}
        halls={halls}
        tz={tz}
        onDone={onClose}
        onClose={() => setBooking(false)}
      />
    );
  }

  return (
    <Modal
      title={enquiry.contactName}
      onClose={onClose}
      footer={
        <>
          {!settled && (
            <button className="danger" onClick={() => setLosing(true)}>
              Mark lost
            </button>
          )}
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
          {!settled && (
            <button className="primary" onClick={() => setBooking(true)}>
              Hold or book
            </button>
          )}
        </>
      }
    >
      {update.error instanceof ApiError && <div className="msg error">{update.error.message}</div>}

      <div className="slot-banner">
        <div>
          <div className="court">
            {enquiry.eventType ?? 'Event'}
            {enquiry.guestCount ? ` · ${enquiry.guestCount} guests` : ''}
          </div>
          <a className="when mono" href={`tel:${enquiry.contactPhone}`}>
            {enquiry.contactPhone}
          </a>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span className={`pill ${enquiry.status}`}>{STATUS_LABEL[enquiry.status]}</span>
          <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
            {enquiry.eventDate ? dateLabel(enquiry.eventDate, tz) : 'No date yet'}
          </div>
        </div>
      </div>

      {enquiry.notes && <p style={{ whiteSpace: 'pre-wrap' }}>{enquiry.notes}</p>}

      {enquiry.status === 'won' && (
        <div className="msg info">
          Booked. The date is held on the calendar — change the booking itself rather than this
          enquiry.
        </div>
      )}
      {enquiry.status === 'lost' && (
        <div className="msg error">Lost: {enquiry.lostReason}</div>
      )}

      {!settled && (
        <>
          <div className="field-row">
            <div className="field">
              <label htmlFor="e-visit">Site visit</label>
              <input
                id="e-visit"
                type="datetime-local"
                value={
                  visitAt ||
                  (enquiry.visitAt
                    ? DateTime.fromISO(enquiry.visitAt, { zone: tz }).toFormat("yyyy-MM-dd'T'HH:mm")
                    : '')
                }
                onChange={(e) => setVisitAt(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="e-quote">Quoted (₹)</label>
              <input
                id="e-quote"
                type="number"
                min={0}
                value={quote}
                onChange={(e) => setQuote(e.target.value)}
              />
            </div>
          </div>
          <div className="row">
            <button
              disabled={!visitAt || update.isPending}
              onClick={() =>
                update.mutate({
                  visitAt: DateTime.fromISO(visitAt, { zone: tz }).toISO(),
                })
              }
            >
              Book the visit
            </button>
            <button
              disabled={!quote || update.isPending}
              onClick={() =>
                update.mutate({ quotedPaise: paiseFromRupeeInput(quote), status: 'quoted' })
              }
            >
              Record the quote
            </button>
          </div>
        </>
      )}

      {losing && (
        <div style={{ marginTop: 14 }}>
          <div className="field">
            <label htmlFor="e-lost">Why did it go elsewhere?</label>
            <input
              id="e-lost"
              value={lostReason}
              onChange={(e) => setLostReason(e.target.value)}
              placeholder="Price, date taken, went with a hotel…"
            />
          </div>
          <div className="row">
            <button onClick={() => setLosing(false)}>Cancel</button>
            <button
              className="danger"
              disabled={!lostReason.trim() || update.isPending}
              onClick={() => update.mutate({ status: 'lost', lostReason: lostReason.trim() })}
            >
              Mark lost
            </button>
          </div>
          <div className="hint">
            The reason is the only part of a lost enquiry that is worth anything later.
          </div>
        </div>
      )}
    </Modal>
  );
}

/**
 * Holding a date, or confirming it.
 *
 * Two windows, because a hall has two: when the event runs, and how long the
 * hall is actually unavailable. The decorator wants the evening before, and
 * that evening is what the next family must not be sold.
 */
function BookModal({
  enquiry,
  halls,
  tz,
  onDone,
  onClose,
}: {
  enquiry: Enquiry;
  halls: Court[];
  tz: string;
  onDone: () => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    resourceId: enquiry.resourceId ?? halls[0]?.id ?? '',
    date: enquiry.eventDate ?? '',
    startTime: '18:00',
    endTime: '23:00',
    amount: enquiry.quotedPaise ? String(enquiry.quotedPaise / 100) : '',
    tentative: true,
    holdUntil: '',
    setup: false,
    accessDate: '',
    accessTime: '18:00',
  });

  const iso = (date: string, time: string) =>
    DateTime.fromISO(`${date}T${time}`, { zone: tz }).toISO()!;

  // The event can run past midnight — a reception until one in the morning is
  // normal — so an end time before the start time means the next day.
  const endDate =
    form.endTime <= form.startTime
      ? DateTime.fromISO(form.date, { zone: tz }).plus({ days: 1 }).toISODate()!
      : form.date;

  const book = useMutation({
    mutationFn: () =>
      post(`/enquiries/${enquiry.id}/book`, {
        resourceId: form.resourceId,
        eventStart: iso(form.date, form.startTime),
        eventEnd: iso(endDate, form.endTime),
        accessStart: form.setup && form.accessDate ? iso(form.accessDate, form.accessTime) : undefined,
        accessEnd: form.setup && form.accessDate ? iso(endDate, form.endTime) : undefined,
        amountPaise: form.amount ? paiseFromRupeeInput(form.amount) : undefined,
        tentative: form.tentative,
        holdUntil: form.tentative ? form.holdUntil : undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enquiries'] });
      qc.invalidateQueries({ queryKey: ['hall-availability'] });
      qc.invalidateQueries({ queryKey: ['bookings'] });
      onDone();
    },
  });

  const ready = form.resourceId && form.date && (!form.tentative || form.holdUntil);

  return (
    <Modal
      title={form.tentative ? 'Hold the date' : 'Confirm the booking'}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            onClick={() => book.mutate()}
            disabled={!ready || book.isPending}
          >
            {form.tentative ? 'Hold it' : 'Book it'}
          </button>
        </>
      }
    >
      {book.error instanceof ApiError && <div className="msg error">{book.error.message}</div>}

      <div className="field-row">
        <div className="field">
          <label htmlFor="b-hall">Hall</label>
          <select
            id="b-hall"
            value={form.resourceId}
            onChange={(e) => setForm({ ...form, resourceId: e.target.value })}
          >
            {halls.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="b-date">Event date</label>
          <input
            id="b-date"
            type="date"
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
          />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="b-start">Starts</label>
          <input
            id="b-start"
            type="time"
            value={form.startTime}
            onChange={(e) => setForm({ ...form, startTime: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="b-end">Ends</label>
          <input
            id="b-end"
            type="time"
            value={form.endTime}
            onChange={(e) => setForm({ ...form, endTime: e.target.value })}
          />
          {endDate !== form.date && <div className="hint">Runs into the next morning.</div>}
        </div>
      </div>

      <div className="field">
        <label className="row" style={{ gap: 6 }}>
          <input
            type="checkbox"
            checked={form.setup}
            onChange={(e) =>
              setForm({
                ...form,
                setup: e.target.checked,
                accessDate:
                  form.accessDate ||
                  (form.date
                    ? DateTime.fromISO(form.date, { zone: tz }).minus({ days: 1 }).toISODate()!
                    : ''),
              })
            }
          />
          They need the hall before the event, for setting up
        </label>
      </div>
      {form.setup && (
        <div className="field-row">
          <div className="field">
            <label htmlFor="b-adate">Hall needed from</label>
            <input
              id="b-adate"
              type="date"
              value={form.accessDate}
              onChange={(e) => setForm({ ...form, accessDate: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="b-atime">At</label>
            <input
              id="b-atime"
              type="time"
              value={form.accessTime}
              onChange={(e) => setForm({ ...form, accessTime: e.target.value })}
            />
          </div>
        </div>
      )}

      <div className="field-row">
        <div className="field">
          <label htmlFor="b-amount">Price (₹)</label>
          <input
            id="b-amount"
            type="number"
            min={0}
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="b-hold">Hold until</label>
          <input
            id="b-hold"
            type="date"
            value={form.holdUntil}
            disabled={!form.tentative}
            onChange={(e) => setForm({ ...form, holdUntil: e.target.value })}
          />
        </div>
      </div>

      <div className="field">
        <label className="row" style={{ gap: 6 }}>
          <input
            type="checkbox"
            checked={form.tentative}
            onChange={(e) => setForm({ ...form, tentative: e.target.checked })}
          />
          Tentative — release it if they do not confirm
        </label>
      </div>

      <div className="hint">
        {form.tentative
          ? 'A hold blocks the date for everyone else and is released automatically on the hold date. The enquiry stays open until they confirm.'
          : 'A confirmed booking blocks the date and marks the enquiry as booked.'}
      </div>
    </Modal>
  );
}
