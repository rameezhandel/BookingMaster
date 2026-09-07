import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { ApiError, get, patch } from '../lib/api';
import { useVenue } from '../lib/venue';
import { rupees } from '../lib/format';
import type { Customer, Page } from '../lib/types';

interface CustomerDetail extends Customer {
  history: {
    id: string;
    during: { start: string; end: string };
    status: string;
    amountPaise: number;
    resourceName: string;
    sport: string;
  }[];
}

export function CustomersPage() {
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const { timezone: tz } = useVenue();

  const { data, isLoading } = useQuery({
    queryKey: ['customers-page', q],
    queryFn: () => get<Page<Customer>>(`/customers?q=${encodeURIComponent(q)}`),
  });
  const rows = data?.items ?? [];

  const { data: detail } = useQuery({
    queryKey: ['customer', openId],
    queryFn: () => get<CustomerDetail>(`/customers/${openId}`),
    enabled: !!openId,
  });

  return (
    <>
      <div className="cal-head">
        <h1>Customers</h1>
        <span className="spacer" />
        <input
          placeholder="Search name or phone"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ width: 240 }}
        />
      </div>

      <div className="card">
        {isLoading ? (
          <div className="empty">Loading…</div>
        ) : !rows.length ? (
          <div className="empty">
            <h3>No customers yet</h3>
            <p>They are created automatically the first time you book someone in.</p>
          </div>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} onClick={() => setOpenId(c.id)} style={{ cursor: 'pointer' }}>
                  <td>
                    <strong>{c.name}</strong>
                  </td>
                  <td className="mono">{c.phone}</td>
                  <td className="faint">{c.notes ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {openId && detail && (
        <Modal title={detail.name} onClose={() => setOpenId(null)}>
          <div className="slot-banner">
            <div>
              <div className="court">{detail.name}</div>
              <a className="when mono" href={`tel:${detail.phone}`}>
                {detail.phone}
              </a>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="faint" style={{ fontSize: 11, textTransform: 'uppercase' }}>
                Bookings
              </div>
              <div style={{ fontWeight: 650 }}>{detail.history.length}</div>
            </div>
          </div>

          <MessagePreference customer={detail} />

          {detail.history.length === 0 ? (
            <p className="faint">No bookings recorded yet.</p>
          ) : (
            <table className="list">
              <tbody>
                {detail.history.map((h) => (
                  <tr key={h.id}>
                    <td className="mono">
                      {DateTime.fromISO(h.during.start, { zone: tz }).toFormat('d LLL yy, HH:mm')}
                    </td>
                    <td>{h.resourceName}</td>
                    <td>
                      <span className={`pill ${h.status}`}>{h.status.replace('_', ' ')}</span>
                    </td>
                    <td className="num mono">{rupees(h.amountPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      )}
    </>
  );
}

/**
 * "Stop texting me" — recorded where the desk hears it.
 *
 * Someone who asks in person and keeps getting messages is a complaint, and
 * possibly a report. It has to be one click from the customer's record.
 */
function MessagePreference({ customer }: { customer: Customer }) {
  const qc = useQueryClient();
  const [optedOut, setOptedOut] = useState(customer.notificationsOptedOut);
  useEffect(() => setOptedOut(customer.notificationsOptedOut), [customer.id, customer.notificationsOptedOut]);

  const save = useMutation({
    mutationFn: (next: boolean) =>
      patch(`/customers/${customer.id}`, { notificationsOptedOut: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customer', customer.id] });
      qc.invalidateQueries({ queryKey: ['customers-page'] });
    },
    onError: () => setOptedOut(customer.notificationsOptedOut),
  });

  return (
    <div className="field" style={{ margin: '14px 0 4px' }}>
      <label className="checkline">
        <input
          type="checkbox"
          checked={!optedOut}
          disabled={save.isPending}
          onChange={(e) => {
            setOptedOut(!e.target.checked);
            save.mutate(!e.target.checked);
          }}
        />
        <span>Send this customer booking messages</span>
      </label>
      <div className="hint">
        {save.error instanceof ApiError
          ? `That did not save — ${save.error.message}`
          : 'Untick if they have asked you to stop messaging them.'}
      </div>
    </div>
  );
}
