import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useEffect, useState } from 'react';
import { ApiError, get, patch } from '../lib/api';
import type { CustomerMessage, Venue } from '../lib/types';

const TONE: Record<string, string> = {
  sent: 'confirmed',
  delivered: 'completed',
  read: 'completed',
  pending: 'held',
  failed: 'cancelled',
  skipped: 'no_show',
};

const WHAT: Record<string, string> = {
  booking_confirmed: 'Confirmation',
  booking_cancelled: 'Cancellation',
  booking_reminder: 'Reminder',
};

/**
 * Messages to customers: whether they go out, and what went out.
 *
 * The log matters more than it looks. "Did they get the confirmation?" is the
 * first question when someone does not turn up, and without this the honest
 * answer is that nobody knows.
 */
export function MessagesCard({ venue, canEdit = true }: { venue: Venue; canEdit?: boolean }) {
  const qc = useQueryClient();
  const [reminderHours, setReminderHours] = useState(venue.reminderHoursBefore);

  useEffect(() => setReminderHours(venue.reminderHoursBefore), [venue.id, venue.reminderHoursBefore]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch(`/venues/${venue.id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['venues'] }),
  });

  const { data: messages, isLoading } = useQuery({
    queryKey: ['messages', venue.id],
    queryFn: () => get<CustomerMessage[]>(`/venues/${venue.id}/messages?limit=25`),
    // Pending messages become sent within seconds; nobody should have to reload.
    refetchInterval: 15_000,
  });

  const failed = (messages ?? []).filter((m) => m.status === 'failed').length;

  return (
    <div className="card">
      <div className="card-head">
        <h2>Customer messages</h2>
        <span className="spacer" />
        <span className={`pill ${venue.notificationsEnabled ? 'confirmed' : 'cancelled'}`}>
          {venue.notificationsEnabled ? 'on' : 'off'}
        </span>
        {canEdit && (
          <button
            onClick={() => save.mutate({ notificationsEnabled: !venue.notificationsEnabled })}
            disabled={save.isPending}
          >
            {venue.notificationsEnabled ? 'Turn off' : 'Turn on'}
          </button>
        )}
      </div>

      <div className="card-body">
        {save.error instanceof ApiError && <div className="msg error">{save.error.message}</div>}

        {venue.notificationsEnabled ? (
          <p className="muted" style={{ marginTop: 0 }}>
            Players get a WhatsApp message when a booking is confirmed or cancelled, on the number
            they booked with.
          </p>
        ) : (
          <p className="muted" style={{ marginTop: 0 }}>
            No messages are being sent for this venue. Players will only know their booking is
            confirmed from the screen they booked on.
          </p>
        )}

        {canEdit && (
        <div className="field" style={{ maxWidth: 260 }}>
          <label htmlFor="msg-reminder">Reminder (hours before the slot)</label>
          <input
            id="msg-reminder"
            type="number"
            min={0}
            max={72}
            value={reminderHours}
            onChange={(e) => setReminderHours(Number(e.target.value))}
            onBlur={() =>
              reminderHours !== venue.reminderHoursBefore &&
              save.mutate({ reminderHoursBefore: reminderHours })
            }
          />
          <div className="hint">Zero sends no reminders.</div>
        </div>
        )}

        {failed > 0 && (
          <div className="msg error">
            {failed === 1 ? 'One message' : `${failed} messages`} could not be delivered. Check the
            number, or that the message templates are approved with the provider.
          </div>
        )}

        <h3 className="faint" style={{ margin: '18px 0 8px', fontSize: 12, textTransform: 'uppercase' }}>
          Recently sent
        </h3>

        {isLoading ? (
          <p className="faint">Loading…</p>
        ) : !messages?.length ? (
          <p className="muted">
            Nothing sent yet. The next booking with a phone number on it will show up here.
          </p>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>When</th>
                <th>To</th>
                <th>What</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((m) => (
                <tr key={m.id} title={m.preview}>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                    {DateTime.fromISO(m.sentAt ?? m.createdAt, { zone: venue.timezone }).toFormat(
                      'd LLL, HH:mm',
                    )}
                  </td>
                  <td>
                    {m.customerName ?? <span className="faint">—</span>}
                    <div className="faint mono" style={{ fontSize: 12 }}>
                      {m.toPhone}
                    </div>
                  </td>
                  <td>{WHAT[m.template] ?? m.template.replace(/_/g, ' ')}</td>
                  <td>
                    <span className={`pill ${TONE[m.status] ?? ''}`}>{m.status}</span>
                    {m.status === 'failed' && m.error && (
                      <div className="faint" style={{ fontSize: 12 }}>
                        {m.error}
                      </div>
                    )}
                    {m.status === 'pending' && m.attempts > 0 && (
                      <div className="faint" style={{ fontSize: 12 }}>
                        retrying ({m.attempts})
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
