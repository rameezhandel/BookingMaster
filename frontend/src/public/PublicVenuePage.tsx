import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { get } from '../lib/api';
import { rupees } from '../lib/format';
import { BookingFlow } from './BookingFlow';
import { MyBookings } from './MyBookings';

interface PublicCourt {
  id: string;
  name: string;
  sport: string;
  slotMinutes: number;
}

interface PublicVenue {
  slug: string;
  name: string;
  address: string | null;
  phone: string | null;
  timezone: string;
  bookingWindowDays: number;
  minNoticeMinutes: number;
  courts: PublicCourt[];
}

type Reason = 'outside-window' | 'taken' | 'too-soon' | 'no-price' | null;

interface PublicSlot {
  start: string;
  end: string;
  label: string;
  available: boolean;
  unavailableReason: Reason;
  pricePaise: number | null;
}

interface Availability {
  date: string;
  timezone: string;
  withinWindow: boolean;
  lastBookableDate: string;
  courts: (PublicCourt & { closed: boolean; closedReason: string | null; slots: PublicSlot[] })[];
}

/**
 * The page a venue shares with its players.
 *
 * Deliberately plain: someone opens this on a phone, on a bad connection,
 * wanting to know whether 7pm is free. Availability and price, nothing else.
 */
export function PublicVenuePage() {
  const { slug = '' } = useParams();
  const qc = useQueryClient();
  const [date, setDate] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ courtId: string; courtName: string; slot: PublicSlot } | null>(
    null,
  );
  const [justBooked, setJustBooked] = useState(false);
  const [showMine, setShowMine] = useState(false);

  const { data: venue, isLoading, error } = useQuery({
    queryKey: ['public-venue', slug],
    queryFn: () => get<PublicVenue>(`/public/venues/${encodeURIComponent(slug)}`),
    retry: false,
  });

  const tz = venue?.timezone ?? 'Asia/Kolkata';
  const today = DateTime.now().setZone(tz).toISODate()!;
  const activeDate = date ?? today;

  const { data: availability } = useQuery({
    queryKey: ['public-availability', slug, activeDate],
    queryFn: () =>
      get<Availability>(
        `/public/venues/${encodeURIComponent(slug)}/availability?date=${activeDate}`,
      ),
    enabled: !!venue,
  });

  if (isLoading) {
    return (
      <div className="public-shell">
        <p className="faint">Loading…</p>
      </div>
    );
  }

  if (error || !venue) {
    return (
      <div className="public-shell">
        <div className="empty card">
          <h3>Venue not found</h3>
          <p>Check the link, or ask the venue for their booking page address.</p>
        </div>
      </div>
    );
  }

  const days = Array.from({ length: 7 }, (_, i) =>
    DateTime.now().setZone(tz).plus({ days: i }).toISODate()!,
  );

  return (
    <div className="public-shell">
      <header className="public-head">
        <div className="row wrap" style={{ alignItems: 'flex-start' }}>
          <h1 style={{ flex: 1 }}>{venue.name}</h1>
          <button onClick={() => setShowMine(true)}>My bookings</button>
        </div>
        {venue.address && <p className="muted">{venue.address}</p>}
        {venue.phone && (
          <p>
            <a className="mono" href={`tel:${venue.phone}`}>
              {venue.phone}
            </a>
          </p>
        )}
      </header>

      <div className="daypick">
        {days.map((d) => {
          const dt = DateTime.fromISO(d, { zone: tz });
          return (
            <button
              key={d}
              className={d === activeDate ? 'active' : ''}
              onClick={() => setDate(d)}
            >
              <span className="dow">{d === today ? 'Today' : dt.toFormat('ccc')}</span>
              <span className="dnum">{dt.toFormat('d LLL')}</span>
            </button>
          );
        })}
      </div>

      {!availability ? (
        <p className="faint">Checking availability…</p>
      ) : (
        availability.courts.map((court) => {
          const free = court.slots.filter((s) => s.available);
          return (
            <section className="court-block" key={court.id}>
              <div className="court-head">
                <h2>{court.name}</h2>
                <span className="faint" style={{ textTransform: 'capitalize' }}>
                  {court.sport} · {court.slotMinutes} min
                </span>
                <span className="spacer" />
                <span className="faint">
                  {court.closed
                    ? court.closedReason
                      ? `Closed — ${court.closedReason}`
                      : 'Closed'
                    : `${free.length} free`}
                </span>
              </div>

              {court.closed ? null : court.slots.length === 0 ? (
                <p className="faint">Not open on this day.</p>
              ) : (
                <div className="slot-row">
                  {court.slots.map((slot) =>
                    slot.available ? (
                      <button
                        key={slot.start}
                        className="pub-slot free"
                        onClick={() =>
                          setPicked({ courtId: court.id, courtName: court.name, slot })
                        }
                      >
                        <span className="t">{slot.label}</span>
                        <span className="p">
                          {slot.pricePaise !== null ? rupees(slot.pricePaise) : '—'}
                        </span>
                      </button>
                    ) : (
                      <div
                        key={slot.start}
                        className="pub-slot gone"
                        title={
                          slot.unavailableReason === 'taken'
                            ? 'Already booked'
                            : slot.unavailableReason === 'too-soon'
                              ? 'Too close to the start time'
                              : 'Not bookable'
                        }
                      >
                        <span className="t">{slot.label}</span>
                        <span className="p">—</span>
                      </div>
                    ),
                  )}
                </div>
              )}
            </section>
          );
        })
      )}

      {justBooked && (
        <div className="msg info" style={{ marginTop: 16 }}>
          Booking confirmed. The venue has your number.
        </div>
      )}

      {showMine && <MyBookings slug={slug} onClose={() => setShowMine(false)} />}

      {picked && (
        <BookingFlow
          slug={slug}
          courtId={picked.courtId}
          courtName={picked.courtName}
          slot={picked.slot}
          timezone={tz}
          onClose={() => {
            setPicked(null);
            qc.invalidateQueries({ queryKey: ['public-availability'] });
          }}
          onBooked={() => setJustBooked(true)}
        />
      )}

      <footer className="public-foot">
        {venue.phone ? (
          <p>
            Trouble booking? Call <a href={`tel:${venue.phone}`}>{venue.phone}</a>.
          </p>
        ) : (
          <p className="faint">Contact the venue if you have trouble booking.</p>
        )}
        <p className="faint">
          Bookings open up to {venue.bookingWindowDays} days ahead. Times are{' '}
          {DateTime.now().setZone(tz).toFormat('ZZZZ')}.
        </p>
      </footer>
    </div>
  );
}
