import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { get } from '../lib/api';
import { rupees, shiftDate, todayIn } from '../lib/format';
import type { ReportSummary, Venue } from '../lib/types';

export function ReportsPage() {
  const today = todayIn('Asia/Kolkata');
  const [from, setFrom] = useState(shiftDate(today, -29));
  const [to, setTo] = useState(today);

  const { data: venues } = useQuery({ queryKey: ['venues'], queryFn: () => get<Venue[]>('/venues') });
  const venue = venues?.[0];

  const { data, isLoading } = useQuery({
    queryKey: ['report', venue?.id, from, to],
    queryFn: () => get<ReportSummary>(`/reports/summary?venueId=${venue!.id}&from=${from}&to=${to}`),
    enabled: !!venue,
  });

  return (
    <>
      <div className="cal-head">
        <h1>Reports</h1>
        <span className="spacer" />
        <button onClick={() => { setFrom(shiftDate(today, -6)); setTo(today); }}>Last 7 days</button>
        <button onClick={() => { setFrom(shiftDate(today, -29)); setTo(today); }}>Last 30 days</button>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 150 }} />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }} />
      </div>

      {isLoading || !data ? (
        <div className="empty card">Loading…</div>
      ) : (
        <div className="stack">
          <div className="stats">
            <div className="stat">
              <div className="k">Bookings</div>
              <div className="v">{data.bookings}</div>
            </div>
            <div className="stat">
              <div className="k">Billed</div>
              <div className="v">{rupees(data.billedPaise)}</div>
            </div>
            <div className="stat">
              <div className="k">Collected</div>
              <div className="v paid-flag">{rupees(data.collectedPaise)}</div>
            </div>
            <div className="stat">
              <div className="k">Outstanding</div>
              <div className={`v ${data.outstandingPaise > 0 ? 'due-flag' : ''}`}>
                {rupees(data.outstandingPaise)}
              </div>
            </div>
            <div className="stat">
              <div className="k">Cancelled</div>
              <div className="v">{data.cancelled}</div>
            </div>
            <div className="stat">
              <div className="k">No-shows</div>
              <div className="v">{data.noShows}</div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>By court</h2>
            </div>
            <table className="list">
              <thead>
                <tr>
                  <th>Court</th>
                  <th>Sport</th>
                  <th className="num">Bookings</th>
                  <th className="num">Hours booked</th>
                  <th className="num">Billed</th>
                </tr>
              </thead>
              <tbody>
                {data.byCourt.map((c) => (
                  <tr key={c.resourceId}>
                    <td>
                      <strong>{c.name}</strong>
                    </td>
                    <td style={{ textTransform: 'capitalize' }} className="faint">
                      {c.sport}
                    </td>
                    <td className="num mono">{c.bookings}</td>
                    <td className="num mono">{(c.bookedMinutes / 60).toFixed(1)}</td>
                    <td className="num mono">{rupees(c.billedPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="hint">
            Billed counts confirmed and completed bookings in the range. Collected counts money
            recorded against any booking in the range, whichever day it was received.
          </p>
        </div>
      )}
    </>
  );
}
