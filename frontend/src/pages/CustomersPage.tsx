import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { Modal } from '../components/Modal';
import { get } from '../lib/api';
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
