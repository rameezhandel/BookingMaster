import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useMemo, useState } from 'react';
import { BlockModal } from '../components/BlockModal';
import { BookingDetailModal } from '../components/BookingDetailModal';
import { FirstRun } from '../components/FirstRun';
import { QuickBookModal } from '../components/QuickBookModal';
import { get } from '../lib/api';
import { dayLabel, fullDate, rupees, shiftDate, todayIn } from '../lib/format';
import type { CalendarDay, Slot, WeekDay } from '../lib/types';
import { useVenue } from '../lib/venue';

export function CalendarPage() {
  const { venue: activeVenue, isLoading: venuesLoading } = useVenue();
  const [date, setDate] = useState(todayIn('Asia/Kolkata'));
  const [booking, setBooking] = useState<{ courtId: string; slot: Slot } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [blocking, setBlocking] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['calendar', activeVenue?.id, date],
    queryFn: () => get<CalendarDay>(`/calendar?venueId=${activeVenue!.id}&date=${date}`),
    enabled: !!activeVenue,
  });

  const { data: week } = useQuery({
    queryKey: ['week', activeVenue?.id, date],
    queryFn: () => get<{ days: WeekDay[] }>(`/calendar/week?venueId=${activeVenue!.id}&date=${date}`),
    enabled: !!activeVenue,
  });

  // One row per distinct slot start across all courts, so a glance down a column
  // and across a row both work even when courts keep different hours.
  const rows = useMemo(() => {
    if (!data) return [];
    const byStart = new Map<string, string>();
    for (const court of data.courts) {
      for (const slot of court.slots) byStart.set(slot.start, slot.label);
    }
    return [...byStart.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data]);

  const slotIndex = useMemo(() => {
    const index = new Map<string, Map<string, Slot>>();
    for (const court of data?.courts ?? []) {
      index.set(court.id, new Map(court.slots.map((s) => [s.start, s])));
    }
    return index;
  }, [data]);

  if (venuesLoading) return <span className="faint">Loading…</span>;
  if (!activeVenue) return <FirstRun />;
  if (activeVenue && !isLoading && data && data.courts.length === 0) {
    return (
      <div className="empty card">
        <h3>No courts yet</h3>
        <p>Add courts to {activeVenue.name} in Settings and they will appear here.</p>
      </div>
    );
  }

  const tz = data?.timezone ?? activeVenue?.timezone ?? 'Asia/Kolkata';

  return (
    <>
      <div className="cal-head">
        <div>
          <div className="date-title">{dayLabel(date, tz)}</div>
          <div className="date-sub">{fullDate(date, tz)}</div>
        </div>

        <div className="date-nav">
          <button onClick={() => setDate(shiftDate(date, -1))} aria-label="Previous day">
            ←
          </button>
          <button onClick={() => setDate(todayIn(tz))}>Today</button>
          <button onClick={() => setDate(shiftDate(date, 1))} aria-label="Next day">
            →
          </button>
          <input
            type="date"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            style={{ width: 150 }}
          />
        </div>

        <span className="spacer" />

        <button onClick={() => setBlocking(true)}>Block time</button>
      </div>

      {week && (
        <div className="weekstrip">
          {week.days.map((d) => {
            const dt = DateTime.fromISO(d.date, { zone: tz });
            return (
              <button
                key={d.date}
                className={[d.date === date ? 'active' : '', d.closed ? 'closed' : ''].join(' ').trim()}
                onClick={() => setDate(d.date)}
                title={d.closed ? 'Closed' : `${d.bookedSlots} of ${d.totalSlots} slots booked`}
              >
                <span className="dow">{dt.toFormat('ccc')}</span>
                <span className="dnum">{dt.toFormat('d')}</span>
                <span className="occ">{d.closed ? 'shut' : d.totalSlots ? `${d.occupancyPct}%` : '—'}</span>
              </button>
            );
          })}
        </div>
      )}

      {data && (
        <div className="stats">
          <div className="stat">
            <div className="k">Occupancy</div>
            <div className="v">{data.summary.occupancyPct}%</div>
          </div>
          <div className="stat">
            <div className="k">Slots booked</div>
            <div className="v">
              {data.summary.bookedSlots}
              <span className="faint" style={{ fontSize: 13, fontWeight: 400 }}>
                {' '}
                / {data.summary.totalSlots}
              </span>
            </div>
          </div>
          <div className="stat">
            <div className="k">Billed today</div>
            <div className="v">{rupees(data.summary.bookedPaise)}</div>
          </div>
        </div>
      )}

      {error && <div className="msg error">{(error as Error).message}</div>}

      <div className="grid-scroll">
        <table className="grid">
          <thead>
            <tr>
              <th className="time-col" />
              {data?.courts.map((court) => (
                <th key={court.id}>
                  {court.name}
                  <span className="sport">{court.sport}</span>
                  {court.closed ? (
                    <span className="closed-tag">Closed{court.closedReason ? ` — ${court.closedReason}` : ''}</span>
                  ) : (
                    <span className="hours">
                      {court.windows
                        .map((w) => `${w.opensAt.slice(0, 5)}–${w.closesAt.slice(0, 5)}`)
                        .join(', ')}
                      {court.openingSource !== 'weekly' && court.closedReason
                        ? ` · ${court.closedReason}`
                        : ''}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([startISO, label]) => (
              <tr key={startISO}>
                <td className="time-col">{label}</td>
                {data?.courts.map((court) => {
                  const slot = slotIndex.get(court.id)?.get(startISO);
                  if (!slot) {
                    return (
                      <td key={court.id} className={court.closed ? 'closed-col' : undefined}>
                        <div className="slot spacer" />
                      </td>
                    );
                  }
                  return (
                    <td key={court.id}>
                      <SlotCell
                        slot={slot}
                        onBook={() => setBooking({ courtId: court.id, slot })}
                        onOpen={(id) => setDetailId(id)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && data.courts.length > 0 && data.courts.every((c) => c.closed) && (
        <p className="msg info" style={{ marginTop: 12 }}>
          Every court is closed on this date
          {data.courts[0].closedReason ? ` — ${data.courts[0].closedReason}` : ''}. Manage closures in
          Settings.
        </p>
      )}

      {isLoading && <p className="faint" style={{ marginTop: 12 }}>Loading calendar…</p>}

      {booking && data && (
        <QuickBookModal
          court={data.courts.find((c) => c.id === booking.courtId)!}
          slotStart={booking.slot.start}
          slotEnd={booking.slot.end}
          suggestedPaise={booking.slot.pricePaise}
          timezone={tz}
          onClose={() => setBooking(null)}
        />
      )}

      {detailId && (
        <BookingDetailModal reservationId={detailId} timezone={tz} onClose={() => setDetailId(null)} />
      )}

      {blocking && data && (
        <BlockModal courts={data.courts} date={date} timezone={tz} onClose={() => setBlocking(false)} />
      )}
    </>
  );
}

function SlotCell({
  slot,
  onBook,
  onOpen,
}: {
  slot: Slot;
  onBook: () => void;
  onOpen: (id: string) => void;
}) {
  const r = slot.reservation;

  if (!r) {
    return (
      <button className={`slot free ${slot.state === 'past' ? 'past' : ''}`} onClick={onBook}>
        <span className="add">+ Book</span>
        <span className="price">{slot.pricePaise === null ? 'No price' : rupees(slot.pricePaise)}</span>
      </button>
    );
  }

  if (r.kind === 'block') {
    return (
      <button className="slot blocked" onClick={() => onOpen(r.id)}>
        <span className="who">Blocked</span>
        <span className="meta">{r.blockReason ?? ''}</span>
      </button>
    );
  }

  return (
    <button className={`slot ${slot.state}`} onClick={() => onOpen(r.id)}>
      <span className="who">
        {r.customer?.name ?? 'Walk-in'}
        {r.seriesId && <span className="repeat-badge" title="Recurring booking">↻</span>}
      </span>
      <span className="meta">
        {rupees(r.amountPaise)}
        {r.duePaise > 0 ? <span className="due-flag"> · {rupees(r.duePaise)} due</span> : <span className="paid-flag"> · paid</span>}
      </span>
    </button>
  );
}
