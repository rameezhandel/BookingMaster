import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { rupees } from '../lib/format';
import { getSession, setSession } from './customer-session';
import { SignInDialog } from './SignInDialog';

interface MyBooking {
  id: string;
  status: string;
  during: { start: string; end: string };
  amountPaise: number;
  paidPaise: number;
  cancellationRefundPaise: number | null;
  courtName: string;
  sport: string;
  venueName: string;
  venuePhone: string | null;
  timezone: string;
  cancellable: boolean;
}

interface RefundQuote {
  configured: boolean;
  refundPct: number | null;
  refundPaise: number;
  hoursBefore: number;
  cappedByPaid: boolean;
}

interface CancelResult {
  refundPaise: number;
  refundPct: number | null;
  refundIssued: boolean;
  refundDetail: string;
}

/**
 * A player's own bookings at one venue, and cancelling them.
 *
 * The refund is quoted from the venue's policy before anything is cancelled —
 * finding out what you get back *after* the slot is gone is the wrong order,
 * and it is the thing people phone up angry about.
 */
export function MyBookings({ slug, onClose }: { slug: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null>(() => getSession(slug));

  if (!token) {
    return (
      <Panel title="Your bookings" onClose={onClose}>
        <p className="muted" style={{ marginTop: 0 }}>
          Confirm your mobile number to see the bookings you have made here.
        </p>
        <SignInDialog slug={slug} onSignedIn={setToken} />
      </Panel>
    );
  }

  return (
    <Panel
      title="Your bookings"
      onClose={onClose}
      footer={
        <button
          className="ghost sm"
          onClick={() => {
            setSession(slug, null);
            setToken(null);
            qc.removeQueries({ queryKey: ['my-bookings'] });
          }}
        >
          Sign out
        </button>
      }
    >
      <BookingList slug={slug} token={token} onExpired={() => setToken(null)} />
    </Panel>
  );
}

function BookingList({
  slug,
  token,
  onExpired,
}: {
  slug: string;
  token: string;
  onExpired: () => void;
}) {
  const qc = useQueryClient();
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [result, setResult] = useState<CancelResult | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['my-bookings', slug],
    queryFn: () => api<MyBooking[]>('/public/my/bookings', { headers: auth(token) }),
    retry: false,
  });

  // A two-hour session quietly expiring should send them back to the code, not
  // show an empty list as though they had never booked anything. In an effect,
  // not during render: this changes the parent's state.
  const expired = error instanceof ApiError && error.status === 401;
  useEffect(() => {
    if (!expired) return;
    setSession(slug, null);
    onExpired();
  }, [expired, slug, onExpired]);

  if (isLoading) return <p className="faint">Loading…</p>;
  if (!data?.length) {
    return (
      <p className="muted">
        No bookings on this number yet. Pick a slot above and they will show up here.
      </p>
    );
  }

  const upcoming = data.filter((b) => b.status !== 'cancelled');
  const past = data.filter((b) => b.status === 'cancelled');

  return (
    <>
      {result && (
        <div className={`msg ${result.refundIssued ? 'info' : 'error'}`}>
          {result.refundPaise > 0
            ? `Cancelled. ${rupees(result.refundPaise)} refunded${result.refundPct !== null ? ` (${result.refundPct}%)` : ''} — ${result.refundDetail}`
            : 'Cancelled. No refund applies to this booking.'}
        </div>
      )}

      {upcoming.map((b) => (
        <BookingRow
          key={b.id}
          booking={b}
          token={token}
          open={cancelling === b.id}
          onOpen={() => setCancelling(cancelling === b.id ? null : b.id)}
          onCancelled={(res) => {
            setResult(res);
            setCancelling(null);
            qc.invalidateQueries({ queryKey: ['my-bookings'] });
            qc.invalidateQueries({ queryKey: ['public-availability'] });
          }}
        />
      ))}

      {past.length > 0 && (
        <>
          <h3 className="faint" style={{ margin: '18px 0 8px', fontSize: 12, textTransform: 'uppercase' }}>
            Cancelled
          </h3>
          {past.map((b) => (
            <BookingRow
              key={b.id}
              booking={b}
              token={token}
              open={false}
              onOpen={() => {}}
              onCancelled={() => {}}
            />
          ))}
        </>
      )}
    </>
  );
}

function BookingRow({
  booking,
  token,
  open,
  onOpen,
  onCancelled,
}: {
  booking: MyBooking;
  token: string;
  open: boolean;
  onOpen: () => void;
  onCancelled: (res: CancelResult) => void;
}) {
  const tz = booking.timezone;
  const start = DateTime.fromISO(booking.during.start, { zone: tz });
  const end = DateTime.fromISO(booking.during.end, { zone: tz });

  const { data: quote } = useQuery({
    queryKey: ['cancel-quote', booking.id],
    queryFn: () =>
      api<RefundQuote>(`/public/my/bookings/${booking.id}/cancellation-quote`, {
        headers: auth(token),
      }),
    enabled: open,
  });

  const cancel = useMutation({
    mutationFn: () =>
      api<CancelResult>(`/public/my/bookings/${booking.id}/cancel`, {
        method: 'POST',
        headers: { ...auth(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    onSuccess: onCancelled,
  });

  return (
    <div className={`my-booking ${booking.status === 'cancelled' ? 'is-cancelled' : ''}`}>
      <div className="row wrap" style={{ alignItems: 'baseline' }}>
        <strong>{start.toFormat('ccc d LLL')}</strong>
        <span className="mono">
          {start.toFormat('HH:mm')}–{end.toFormat('HH:mm')}
        </span>
        <span className="spacer" />
        <span className={`pill ${booking.status}`}>{booking.status.replace('_', ' ')}</span>
      </div>

      <div className="row wrap faint" style={{ fontSize: 13, marginTop: 2 }}>
        <span>{booking.courtName}</span>
        <span>·</span>
        <span>{rupees(booking.amountPaise)}</span>
        {booking.paidPaise > 0 && <span className="paid-flag">paid</span>}
        {booking.status === 'cancelled' && (booking.cancellationRefundPaise ?? 0) > 0 && (
          <span>· refunded {rupees(booking.cancellationRefundPaise!)}</span>
        )}
      </div>

      {booking.cancellable && (
        <div style={{ marginTop: 8 }}>
          {!open ? (
            <button className="sm" onClick={onOpen}>
              Cancel this booking
            </button>
          ) : (
            <div className="cancel-box">
              {cancel.error instanceof ApiError && (
                <div className="msg error">{cancel.error.message}</div>
              )}

              {!quote ? (
                <p className="faint">Checking the refund…</p>
              ) : quote.configured ? (
                <p className="muted" style={{ marginTop: 0 }}>
                  Cancelling {quote.hoursBefore >= 0 ? `${quote.hoursBefore}h before the start` : 'now'} refunds{' '}
                  <strong>{rupees(quote.refundPaise)}</strong>
                  {quote.refundPct !== null ? ` (${quote.refundPct}%)` : ''}.
                  {quote.cappedByPaid && ' That is limited to what has actually been paid.'}
                </p>
              ) : (
                <p className="muted" style={{ marginTop: 0 }}>
                  This venue has no published refund policy. Cancelling frees the slot;{' '}
                  {booking.venuePhone ? (
                    <>
                      call <a href={`tel:${booking.venuePhone}`}>{booking.venuePhone}</a> about a refund.
                    </>
                  ) : (
                    'contact the venue about a refund.'
                  )}
                </p>
              )}

              <div className="row">
                <button
                  className="danger sm"
                  disabled={cancel.isPending || !quote}
                  onClick={() => cancel.mutate()}
                >
                  {cancel.isPending ? 'Cancelling…' : 'Yes, cancel it'}
                </button>
                <button className="sm" onClick={onOpen}>
                  Keep it
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function Panel({
  title,
  onClose,
  footer,
  children,
}: {
  title: string;
  onClose: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="ghost sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && (
          <div className="modal-foot">
            {footer}
            <span className="spacer" />
            <button onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
}
