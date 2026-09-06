import { useInfiniteQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { get } from '../lib/api';
import type { AuditEvent, Venue } from '../lib/types';
import { useQuery } from '@tanstack/react-query';

const TONE: Record<string, string> = {
  'booking.created': 'confirmed',
  'booking.completed': 'completed',
  'booking.cancelled': 'cancelled',
  'booking.no_show': 'no_show',
  'payment.recorded': 'confirmed',
  'payment.refunded': 'no_show',
  'payment.deleted': 'cancelled',
  'series.created': 'confirmed',
  'series.ended': 'cancelled',
  'closure.created': 'blocked',
  'closure.removed': 'blocked',
};

/**
 * Who did what. Useful the moment two people share a login and a booking
 * disappears, which is most venues within a month.
 */
export function ActivityPage() {
  const { data: venues } = useQuery({ queryKey: ['venues'], queryFn: () => get<Venue[]>('/venues') });
  const tz = venues?.[0]?.timezone ?? 'Asia/Kolkata';

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['audit'],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      get<{ items: AuditEvent[]; nextCursor: number | null }>(
        `/audit?limit=50${pageParam ? `&before=${pageParam}` : ''}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const events = data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <div className="cal-head">
        <h1>Activity</h1>
        <span className="spacer" />
        <span className="faint" style={{ fontSize: 13 }}>
          Bookings, money and settings changes. This log cannot be edited.
        </span>
      </div>

      <div className="card">
        {isLoading ? (
          <div className="empty">Loading…</div>
        ) : !events.length ? (
          <div className="empty">
            <h3>Nothing recorded yet</h3>
            <p>Bookings, payments and settings changes will appear here as they happen.</p>
          </div>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th>Who</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                    {DateTime.fromISO(e.createdAt, { zone: tz }).toFormat('d LLL, HH:mm')}
                  </td>
                  <td>
                    <span className={`pill ${TONE[e.action] ?? ''}`}>
                      {e.action.replace(/[._]/g, ' ')}
                    </span>{' '}
                    {e.summary}
                  </td>
                  <td className="faint">{e.actorEmail ?? 'system'}</td>
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
    </>
  );
}
