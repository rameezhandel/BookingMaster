import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, post } from '../lib/api';
import { setSession } from './customer-session';

/**
 * Phone verification, in one place.
 *
 * Both booking and looking at your own bookings need the same proof, and having
 * two copies of an OTP form is how one of them ends up with a subtly different
 * rule about resends or attempts.
 *
 * Rendered inline rather than as its own modal so it can sit inside the booking
 * dialog as a first step, or stand alone when someone just wants their
 * bookings.
 */
export function SignInDialog({
  slug,
  askName,
  onSignedIn,
}: {
  slug: string;
  /** Ask for a name too, so a first booking has something for the venue to call them. */
  askName?: boolean;
  onSignedIn: (token: string) => void;
}) {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [maskedPhone, setMaskedPhone] = useState('');

  const requestCode = useMutation({
    mutationFn: () =>
      post<{ challengeId: string; phone: string }>(
        `/public/venues/${encodeURIComponent(slug)}/otp/request`,
        { phone },
      ),
    onSuccess: (res) => {
      setChallengeId(res.challengeId);
      setMaskedPhone(res.phone);
    },
  });

  const verify = useMutation({
    mutationFn: () =>
      post<{ token: string }>(`/public/venues/${encodeURIComponent(slug)}/otp/verify`, {
        challengeId,
        code,
        ...(askName && name.trim() ? { name: name.trim() } : {}),
      }),
    onSuccess: (res) => {
      setSession(slug, res.token);
      onSignedIn(res.token);
    },
  });

  const error = [requestCode.error, verify.error].find((e) => e instanceof ApiError) as
    | ApiError
    | undefined;

  if (!challengeId) {
    return (
      <>
        {error && <div className="msg error">{error.message}</div>}
        <div className="field">
          <label htmlFor="si-phone">Your mobile number</label>
          <input
            id="si-phone"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+91 98450 00000"
          />
          <div className="hint">We will text you a code to confirm it is you.</div>
        </div>

        {askName && (
          <div className="field">
            <label htmlFor="si-name">Your name</label>
            <input
              id="si-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="So the venue knows who to expect"
            />
          </div>
        )}

        <button
          className="primary"
          style={{ width: '100%', padding: 10 }}
          disabled={phone.trim().length < 7 || requestCode.isPending}
          onClick={() => requestCode.mutate()}
        >
          {requestCode.isPending ? 'Sending…' : 'Send code'}
        </button>
      </>
    );
  }

  return (
    <>
      {error && <div className="msg error">{error.message}</div>}
      <div className="field">
        <label htmlFor="si-code">Code sent to {maskedPhone}</label>
        <input
          id="si-code"
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
      <button
        className="ghost sm"
        style={{ width: '100%', marginTop: 8 }}
        onClick={() => {
          setChallengeId('');
          setCode('');
        }}
      >
        Use a different number
      </button>
    </>
  );
}
