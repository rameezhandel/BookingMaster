import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { ApiError, del, get, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Invite, StaffMember } from '../lib/types';

/**
 * Who else has a login.
 *
 * The point of this is not convenience. One shared login means the activity log
 * cannot say who cancelled the booking, and someone who leaves keeps their
 * access until the password is changed on everyone at once — which is why it
 * never is.
 */
export function TeamCard() {
  const qc = useQueryClient();
  const { me } = useAuth();
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);

  const { data: team } = useQuery({ queryKey: ['staff'], queryFn: () => get<StaffMember[]>('/staff') });
  const { data: invites } = useQuery({
    queryKey: ['staff-invites'],
    queryFn: () => get<Invite[]>('/staff/invites'),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['staff'] });
    qc.invalidateQueries({ queryKey: ['staff-invites'] });
  };

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      patch(`/staff/${id}`, body),
    onSuccess: refresh,
  });

  const revoke = useMutation({
    mutationFn: (id: string) => del(`/staff/invites/${id}`),
    onSuccess: refresh,
  });

  return (
    <div className="card">
      <div className="card-head">
        <h2>Who can sign in</h2>
        <span className="spacer" />
        <button className="primary" onClick={() => setInviting(true)}>
          Invite someone
        </button>
      </div>

      <div className="card-body">
        {update.error instanceof ApiError && <div className="msg error">{update.error.message}</div>}

        {link && (
          <div className="msg info">
            <strong>Invitation for {link.email}</strong>
            <p style={{ margin: '6px 0' }}>
              Send them this link. It works once and expires in seven days — we do not email it, so
              it is on you to pass it on.
            </p>
            <code className="invite-link">{link.url}</code>
            <div className="row" style={{ marginTop: 8 }}>
              <button
                className="sm"
                onClick={() => navigator.clipboard.writeText(link.url).catch(() => undefined)}
              >
                Copy link
              </button>
              <button className="ghost sm" onClick={() => setLink(null)}>
                Done
              </button>
            </div>
          </div>
        )}

        <table className="list">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Last signed in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(team ?? []).map((m) => (
              <tr key={m.id} className={m.isActive ? '' : 'is-off'}>
                <td>
                  <strong>{m.name}</strong>
                  {m.id === me?.id && <span className="faint"> — you</span>}
                  <div className="faint" style={{ fontSize: 12 }}>
                    {m.email}
                  </div>
                </td>
                <td>
                  <select
                    value={m.role}
                    disabled={m.id === me?.id || !m.isActive || update.isPending}
                    onChange={(e) => update.mutate({ id: m.id, body: { role: e.target.value } })}
                  >
                    <option value="staff">Staff</option>
                    <option value="owner">Owner</option>
                  </select>
                </td>
                <td className="faint">
                  {m.lastLoginAt
                    ? DateTime.fromISO(m.lastLoginAt).toRelative()
                    : m.isActive
                      ? 'never'
                      : 'switched off'}
                </td>
                <td className="num">
                  {m.id !== me?.id && (
                    <button
                      className={m.isActive ? 'danger sm' : 'sm'}
                      disabled={update.isPending}
                      onClick={() => update.mutate({ id: m.id, body: { isActive: !m.isActive } })}
                    >
                      {m.isActive ? 'Switch off' : 'Restore'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!!invites?.length && (
          <>
            <h3
              className="faint"
              style={{ margin: '18px 0 8px', fontSize: 12, textTransform: 'uppercase' }}
            >
              Waiting to be accepted
            </h3>
            <table className="list">
              <tbody>
                {invites.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <strong>{i.name}</strong>
                      <div className="faint" style={{ fontSize: 12 }}>
                        {i.email}
                      </div>
                    </td>
                    <td className="faint">{i.role}</td>
                    <td className="faint">
                      expires {DateTime.fromISO(i.expiresAt).toRelative()}
                    </td>
                    <td className="num">
                      <button className="ghost sm" onClick={() => revoke.mutate(i.id)}>
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <div className="hint" style={{ marginTop: 14 }}>
          <strong>Staff</strong> can take bookings, record payments and handle customers.{' '}
          <strong>Owners</strong> can also see revenue, change prices and opening hours, publish the
          booking page, and manage this list.
        </div>
      </div>

      {inviting && (
        <InviteModal
          onClose={() => setInviting(false)}
          onInvited={(email, token) => {
            setInviting(false);
            setLink({ email, url: `${location.origin}/invite?token=${encodeURIComponent(token)}` });
            refresh();
          }}
        />
      )}
    </div>
  );
}

function InviteModal({
  onClose,
  onInvited,
}: {
  onClose: () => void;
  onInvited: (email: string, token: string) => void;
}) {
  const [form, setForm] = useState({ name: '', email: '', role: 'staff' });

  const invite = useMutation({
    mutationFn: () => post<{ token: string; email: string }>('/staff/invites', form),
    onSuccess: (res) => onInvited(res.email, res.token),
  });

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Invite someone">
        <div className="modal-head">
          <h2>Invite someone</h2>
          <button className="ghost sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">
          {invite.error instanceof ApiError && <div className="msg error">{invite.error.message}</div>}

          <div className="field">
            <label htmlFor="inv-name">Their name</label>
            <input
              id="inv-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Priya at the desk"
            />
          </div>
          <div className="field">
            <label htmlFor="inv-email">Their email</label>
            <input
              id="inv-email"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="priya@example.com"
            />
            <div className="hint">This becomes their sign-in. They choose their own password.</div>
          </div>
          <div className="field">
            <label htmlFor="inv-role">Role</label>
            <select
              id="inv-role"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            >
              <option value="staff">Staff — bookings, payments, customers</option>
              <option value="owner">Owner — everything, including revenue and prices</option>
            </select>
          </div>
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!form.name.trim() || !form.email.trim() || invite.isPending}
            onClick={() => invite.mutate()}
          >
            {invite.isPending ? 'Creating…' : 'Create invitation'}
          </button>
        </div>
      </div>
    </div>
  );
}
