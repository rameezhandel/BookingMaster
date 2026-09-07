import { useMutation } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { getSession } from './customer-session';
import { SignInDialog } from './SignInDialog';
import { rupees } from '../lib/format';

interface Slot {
  start: string;
  end: string;
  label: string;
  pricePaise: number | null;
}

interface Hold {
  id: string;
  expiresAt: string;
  amountPaise: number;
  requiresPrepayment: boolean;
  court: string;
  start: string;
  end: string;
}

type Step = 'identify' | 'confirm' | 'paying' | 'done';

/**
 * Booking, for someone who is not signed in and does not want an account.
 *
 * Phone, code, done. The slot is held while they type, and the countdown is
 * visible so an expiry is never a surprise.
 */
export function BookingFlow({
  slug,
  courtId,
  courtName,
  slot,
  timezone,
  onClose,
  onBooked,
}: {
  slug: string;
  courtId: string;
  courtName: string;
  slot: Slot;
  timezone: string;
  onClose: () => void;
  onBooked: () => void;
}) {
  const [step, setStep] = useState<Step>('identify');
  // A player who signed in earlier on this page should not be asked again.
  const [token, setToken] = useState(() => getSession(slug) ?? '');
  const [hold, setHold] = useState<Hold | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [payment, setPayment] = useState<{ orderId: string; gateway: string } | null>(null);
  const [payMessage, setPayMessage] = useState<string | null>(null);

  const when = `${DateTime.fromISO(slot.start, { zone: timezone }).toFormat('ccc d LLL, HH:mm')}–${DateTime.fromISO(slot.end, { zone: timezone }).toFormat('HH:mm')}`;

  // A visible countdown, so an expired hold is never a surprise.
  useEffect(() => {
    if (!hold) return;
    const tick = () => {
      const left = Math.max(0, Math.floor((Date.parse(hold.expiresAt) - Date.now()) / 1000));
      setRemaining(left);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [hold]);

  const takeHold = useMutation<Hold, Error, string>({
    mutationFn: (sessionToken: string) =>
      api<Hold>('/public/holds', {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceId: courtId, start: slot.start, end: slot.end }),
      }),
    onSuccess: (held) => {
      setHold(held);
      setStep('confirm');
    },
  });

  // Hold the slot the moment identity is proved, not after the summary is read:
  // the wait in between is where slots get lost to someone quicker.
  function onSignedIn(sessionToken: string) {
    setToken(sessionToken);
    takeHold.mutate(sessionToken);
  }

  // Already signed in: skip straight to holding the slot.
  useEffect(() => {
    if (step === 'identify' && token && !hold && !takeHold.isPending && !takeHold.isError) {
      takeHold.mutate(token);
    }
  }, [step, token, hold, takeHold]);

  const confirm = useMutation({
    mutationFn: () =>
      api(`/public/holds/${hold!.id}/confirm`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      }),
    onSuccess: () => setStep('done'),
  });

  const startPayment = useMutation({
    mutationFn: () =>
      api<{ orderId: string; gateway: string; publicKey: string | null }>(
        `/public/holds/${hold!.id}/payment`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({}) },
      ),
    onSuccess: (res) => {
      setPayment({ orderId: res.orderId, gateway: res.gateway });
      setStep('paying');
    },
  });

  /**
   * Waits for the gateway's webhook rather than trusting the browser.
   *
   * The checkout's own success callback is a hint: it can arrive before the
   * webhook, after it, or not at all if the customer closes the tab. The
   * booking is confirmed when our server says so.
   */
  useEffect(() => {
    if (step !== 'paying' || !hold) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const status = await api<{ bookingStatus: string; paymentStatus: string | null; refundReason: string | null }>(
          `/public/holds/${hold.id}/payment`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (cancelled) return;
        if (status.bookingStatus === 'confirmed') {
          setStep('done');
        } else if (status.paymentStatus === 'refunded') {
          setPayMessage(
            status.refundReason
              ? `Payment refunded: ${status.refundReason.toLowerCase()}.`
              : 'That payment was refunded.',
          );
        } else if (status.paymentStatus === 'failed') {
          setPayMessage('That payment did not go through.');
        }
      } catch {
        /* keep polling; a blip is not a failure */
      }
    };

    void poll();
    const timer = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [step, hold, token]);

  function release() {
    if (hold && token) {
      void api(`/public/holds/${hold.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => undefined);
    }
    onClose();
  }

  const error = [takeHold.error, confirm.error, startPayment.error].find(
    (e) => e instanceof ApiError,
  ) as ApiError | undefined;

  const expired = remaining !== null && remaining <= 0;

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && release()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Book this slot">
        <div className="modal-head">
          <h2>{step === 'done' ? 'Booked' : 'Book this slot'}</h2>
          <button className="ghost sm" onClick={release} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="slot-banner">
            <div>
              <div className="court">{courtName}</div>
              <div className="when">{when}</div>
            </div>
            <div style={{ fontWeight: 650 }}>
              {rupees(hold?.amountPaise ?? slot.pricePaise ?? 0)}
            </div>
          </div>

          {hold && step === 'confirm' && (
            <div className={`msg ${expired ? 'error' : 'info'}`}>
              {expired
                ? 'This slot is no longer held. Close this and pick it again.'
                : `Held for you for another ${Math.floor((remaining ?? 0) / 60)}:${String((remaining ?? 0) % 60).padStart(2, '0')}`}
            </div>
          )}

          {error && <div className="msg error">{error.message}</div>}

          {step === 'identify' && (
            token && takeHold.isPending ? (
              <p className="faint">Holding this slot for you…</p>
            ) : (
              <SignInDialog slug={slug} askName onSignedIn={onSignedIn} />
            )
          )}

          {step === 'confirm' && hold && (
            <>
              <p className="muted">
                {hold.requiresPrepayment
                  ? `Pay ${rupees(hold.amountPaise)} now to confirm this slot.`
                  : `Pay ${rupees(hold.amountPaise)} at the venue. Your slot is confirmed as soon as you book.`}
              </p>
              <button
                className="primary"
                style={{ width: '100%', padding: 10 }}
                disabled={confirm.isPending || startPayment.isPending || expired}
                onClick={() => (hold.requiresPrepayment ? startPayment.mutate() : confirm.mutate())}
              >
                {confirm.isPending || startPayment.isPending
                  ? 'One moment…'
                  : hold.requiresPrepayment
                    ? `Pay ${rupees(hold.amountPaise)}`
                    : 'Confirm booking'}
              </button>
              <button className="ghost sm" style={{ width: '100%', marginTop: 8 }} onClick={release}>
                Give up this slot
              </button>
            </>
          )}

          {step === 'paying' && payment && (
            <>
              {payMessage ? (
                <div className="msg error">{payMessage}</div>
              ) : (
                <p className="muted">
                  Waiting for your payment to clear. This confirms itself — you can leave this page
                  open.
                </p>
              )}
              <div className="field">
                <label>Payment reference</label>
                <div className="mono faint" style={{ fontSize: 12 }}>
                  {payment.orderId}
                </div>
              </div>
              {payment.gateway === 'stub' && (
                <div className="msg info">
                  No payment provider is configured, so no checkout will open and no money will
                  move. This is a placeholder for the real gateway.
                </div>
              )}
              <button className="ghost sm" style={{ width: '100%' }} onClick={release}>
                Cancel
              </button>
            </>
          )}

          {step === 'done' && (
            <>
              <p className="muted">
                Booked. The venue has your number and will expect you at {when}.
              </p>
              <button
                className="primary"
                style={{ width: '100%', padding: 10 }}
                onClick={() => {
                  onBooked();
                  onClose();
                }}
              >
                Done
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
