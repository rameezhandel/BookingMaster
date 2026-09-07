import { useInfiniteQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { BookingDetailModal } from '../components/BookingDetailModal';
import { get } from '../lib/api';
import { useVenue } from '../lib/venue';
import { rangeIn, rupees, shiftDate, todayIn } from '../lib/format';
import type { BookingRow, Page } from '../lib/types';

const STATUSES = ['', 'confirmed', 'completed', 'cancelled', 'no_show', 'blocked'];

export function BookingsPage() {
  const today = todayIn('Asia/Kolkata');
  const [from, setFrom] = useState(shiftDate(today, -7));
  const [to, setTo] = useState(shiftDate(today, 14));
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);

  const { venue, timezone: tz } = useVenue();

  const params = new URLSearchParams({
    from: DateTime.fromISO(from, { zone: tz }).startOf('day').toISO()!,
    to: DateTime.fromISO(to, { zone: tz }).endOf('day').toISO()!,
    limit: '50',
  });
  if (venue) params.set('venueId', venue.id);
  if (status) params.set('status', status);
  if (q.trim()) params.set('q', q.trim());

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['bookings', params.toString()],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const page = new URLSearchParams(params);
      if (pageParam) page.set('cursor', pageParam);
      return get<Page<BookingRow>>(`/reservations?${page}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!venue,
  });

  const rows = data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <div className="cal-head">
        <h1>Bookings</h1>
        <span className="spacer" />
        <input
          placeholder="Search name or phone"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ width: 210 }}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === '' ? 'All statuses' : s.replace('_', ' ')}
            </option>
          ))}
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 150 }} />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }} />
      </div>

      <div className="card">
        {isLoading ? (
          <div className="empty">Loading…</div>
        ) : !rows.length ? (
          <div className="empty">
            <h3>Nothing in this range</h3>
            <p>Try widening the dates or clearing the filters.</p>
          </div>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>When</th>
                <th>Court</th>
                <th>Customer</th>
                <th>Status</th>
                <th className="num">Billed</th>
                <th className="num">Due</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => setDetailId(r.id)} style={{ cursor: 'pointer' }}>
                  <td>
                    <div>{DateTime.fromISO(r.during.start, { zone: tz }).toFormat('ccc d LLL')}</div>
                    <div className="faint mono" style={{ fontSize: 12 }}>
                      {rangeIn(r.during.start, r.during.end, tz)}
                    </div>
                  </td>
                  <td>{r.resourceName}</td>
                  <td>
                    {r.kind === 'block' ? (
                      <span className="faint">{r.blockReason ?? 'Blocked'}</span>
                    ) : r.customerName ? (
                      <>
                        <div>{r.customerName}</div>
                        <div className="faint mono" style={{ fontSize: 12 }}>
                          {r.customerPhone}
                        </div>
                      </>
                    ) : (
                      <span className="faint">Walk-in</span>
                    )}
                  </td>
                  <td>
                    <span className={`pill ${r.status}`}>{r.status.replace('_', ' ')}</span>
                  </td>
                  <td className="num mono">{r.kind === 'block' ? '—' : rupees(r.amountPaise)}</td>
                  <td className={`num mono ${r.duePaise > 0 ? 'due-flag' : ''}`}>
                    {r.kind === 'block' ? (
                      '—'
                    ) : r.status === 'cancelled' ? (
                      r.cancellationRefundPaise ? (
                        <span className="faint">−{rupees(r.cancellationRefundPaise)}</span>
                      ) : (
                        <span className="faint">no refund</span>
                      )
                    ) : r.duePaise > 0 ? (
                      rupees(r.duePaise)
                    ) : (
                      '✓'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {hasNextPage && (
          <div style={{ padding: 12, textAlign: 'center', borderTop: '1px solid var(--border)' }}>
            <button onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
              {isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>

      {detailId && (
        <BookingDetailModal reservationId={detailId} timezone={tz} onClose={() => setDetailId(null)} />
      )}
    </>
  );
}
