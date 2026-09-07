import { useMutation } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useEffect, useState } from 'react';
import { ApiError, api, post } from '../lib/api';
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

type Step = 'phone' | 'code' | 'confirm' | 'done';

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
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [maskedPhone, setMaskedPhone] = useState('');
  const [token, setToken] = useState('');
  const [hold, setHold] = useState<Hold | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

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

  const requestCode = useMutation({
    mutationFn: () =>
      post<{ challengeId: string; phone: string }>(
        `/public/venues/${encodeURIComponent(slug)}/otp/request`,
        { phone },
      ),
    onSuccess: (res) => {
      setChallengeId(res.challengeId);
      setMaskedPhone(res.phone);
      setStep('code');
    },
  });

  const verify = useMutation({
    mutationFn: () =>
      post<{ token: string }>(`/public/venues/${encodeURIComponent(slug)}/otp/verify`, {
        challengeId,
        code,
        ...(name.trim() ? { name: name.trim() } : {}),
      }),
    onSuccess: async (res) => {
      setToken(res.token);
      // Hold the slot the moment identity is proved, not after the customer
      // reads the summary: the wait between those is where slots get lost.
      const held = await api<Hold>('/public/holds', {
        method: 'POST',
        headers: { Authorization: `Bearer ${res.token}` },
        body: JSON.stringify({ resourceId: courtId, start: slot.start, end: slot.end }),
      });
      setHold(held);
      setStep('confirm');
    },
  });

  const confirm = useMutation({
    mutationFn: () =>
      api(`/public/holds/${hold!.id}/confirm`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      }),
    onSuccess: () => setStep('done'),
  });

  function release() {
    if (hold && token) {
      void api(`/public/holds/${hold.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => undefined);
    }
    onClose();
  }

  const error = [requestCode.error, verify.error, confirm.error].find(
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

          {step === 'phone' && (
            <>
              <div className="field">
                <label htmlFor="bf-phone">Your mobile number</label>
                <input
                  id="bf-phone"
                  inputMode="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+91 98450 00000"
                />
                <div className="hint">We will text you a code to confirm it is you.</div>
              </div>
              <div className="field">
                <label htmlFor="bf-name">Your name</label>
                <input
                  id="bf-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="So the venue knows who to expect"
                />
              </div>
              <button
                className="primary"
                style={{ width: '100%', padding: 10 }}
                disabled={phone.trim().length < 7 || requestCode.isPending}
                onClick={() => requestCode.mutate()}
              >
                {requestCode.isPending ? 'Sending…' : 'Send code'}
              </button>
            </>
          )}

          {step === 'code' && (
            <>
              <div className="field">
                <label htmlFor="bf-code">Code sent to {maskedPhone}</label>
                <input
                  id="bf-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="······"
                  style={{ letterSpacing: '0.4em', fontSize: 20, textAlign: 'center' }}
                />
              </div>
              <button
                className="primary"
                style={{ width: '100%', padding: 10 }}
                disabled={code.length !== 6 || verify.isPending}
                onClick={() => verify.mutate()}
              >
                {verify.isPending ? 'Checking…' : 'Confirm number'}
              </button>
              <button className="ghost sm" style={{ width: '100%', marginTop: 8 }} onClick={() => setStep('phone')}>
                Use a different number
              </button>
            </>
          )}

          {step === 'confirm' && hold && (
            <>
              {hold.requiresPrepayment ? (
                <div className="msg error">
                  This venue takes payment online, which is not set up yet. Please call them to
                  finish this booking.
                </div>
              ) : (
                <p className="muted">
                  Pay {rupees(hold.amountPaise)} at the venue. Your slot is confirmed as soon as you
                  book.
                </p>
              )}
              <button
                className="primary"
                style={{ width: '100%', padding: 10 }}
                disabled={confirm.isPending || expired || hold.requiresPrepayment}
                onClick={() => confirm.mutate()}
              >
                {confirm.isPending ? 'Booking…' : 'Confirm booking'}
              </button>
              <button className="ghost sm" style={{ width: '100%', marginTop: 8 }} onClick={release}>
                Give up this slot
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
