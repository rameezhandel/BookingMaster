import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, get, post, setToken } from '../lib/api';

interface InviteDetail {
  email: string;
  name: string;
  role: 'owner' | 'staff';
  business: string | null;
}

/**
 * Taking up an invitation.
 *
 * The person sets their own password here — the owner never types it for them
 * and never sees it, which is what stops a "temporary" shared password becoming
 * the permanent one.
 */
export function AcceptInvitePage() {
  const token = new URLSearchParams(location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['invite', token],
    queryFn: () => get<InviteDetail>(`/invites?token=${encodeURIComponent(token)}`),
    enabled: !!token,
    retry: false,
  });

  const accept = useMutation({
    mutationFn: () => post<{ token: string }>('/invites/accept', { token, password, name: name || undefined }),
    onSuccess: async () => {
      // Straight in: they have just proved the invitation and set a password,
      // so asking them to type it again immediately is friction for nothing.
      const res = await post<{ token: string }>('/auth/login', { email: data!.email, password });
      setToken(res.token);
      location.assign('/calendar');
    },
  });

  if (!token || error) {
    return (
      <div className="center-page">
        <div className="card" style={{ maxWidth: 420 }}>
          <div className="card-body">
            <h2 style={{ marginTop: 0 }}>This invitation is not valid</h2>
            <p className="muted">
              It may have been used already, been revoked, or expired. Ask whoever invited you to
              send a new one.
            </p>
            <a href="/login">Go to sign in</a>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="center-page">
        <span className="faint">Loading…</span>
      </div>
    );
  }

  return (
    <div className="center-page">
      <div className="card" style={{ maxWidth: 420 }}>
        <div className="card-body">
          <h2 style={{ marginTop: 0 }}>Join {data.business ?? 'the team'}</h2>
          <p className="muted">
            You have been invited as {data.role === 'owner' ? 'an owner' : 'staff'}. Choose a
            password and you are in.
          </p>

          {accept.error instanceof ApiError && (
            <div className="msg error">{accept.error.message}</div>
          )}

          <div className="field">
            <label htmlFor="ai-email">Your sign-in</label>
            <input id="ai-email" value={data.email} readOnly disabled />
          </div>

          <div className="field">
            <label htmlFor="ai-name">Your name</label>
            <input
              id="ai-name"
              value={name || data.name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="ai-password">Choose a password</label>
            <input
              id="ai-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <div className="hint">At least 10 characters. Only you will know it.</div>
          </div>

          <button
            className="primary"
            style={{ width: '100%', padding: 10 }}
            disabled={password.length < 10 || accept.isPending}
            onClick={() => accept.mutate()}
          >
            {accept.isPending ? 'Setting up…' : 'Join and sign in'}
          </button>
        </div>
      </div>
    </div>
  );
}
