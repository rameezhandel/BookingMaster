import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { Modal } from '../components/Modal';
import { SeriesResult } from '../components/SeriesResult';
import { ApiError, get, post } from '../lib/api';
import { useVenue } from '../lib/venue';
import { DAY_PLURALS, rupees, shortTime } from '../lib/format';
import type { BookingSeries, MaterialiseResult, SeriesDetail } from '../lib/types';

export function SeriesPage() {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [extendResult, setExtendResult] = useState<MaterialiseResult | null>(null);

  const { venue, timezone: tz } = useVenue();

  const { data, isLoading } = useQuery({
    queryKey: ['series', venue?.id],
    queryFn: () => get<BookingSeries[]>(`/series?venueId=${venue!.id}`),
    enabled: !!venue,
  });

  const extend = useMutation<MaterialiseResult, Error, string>({
    mutationFn: (id) => post<MaterialiseResult>(`/series/${id}/extend`, { weeks: 12 }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['series'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
      setExtendResult(result);
    },
  });

  const active = data?.filter((s) => s.status === 'active') ?? [];
  const ended = data?.filter((s) => s.status === 'ended') ?? [];

  return (
    <>
      <div className="cal-head">
        <h1>Recurring bookings</h1>
        <span className="spacer" />
        <span className="faint" style={{ fontSize: 13 }}>
          Start one from any free slot on the calendar
        </span>
      </div>

      {extend.error instanceof ApiError && <div className="msg error">{extend.error.message}</div>}

      <div className="card">
        {isLoading ? (
          <div className="empty">Loading…</div>
        ) : !data?.length ? (
          <div className="empty">
            <h3>No recurring bookings yet</h3>
            <p>
              Pick a free slot on the calendar and tick “Repeat every…” to set up a weekly group or
              an academy slot.
            </p>
          </div>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>When</th>
                <th>Court</th>
                <th>Customer</th>
                <th className="num">Upcoming</th>
                <th>Booked through</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {[...active, ...ended].map((s) => (
                <tr key={s.id} className={s.status === 'ended' ? 'faint' : undefined}>
                  <td>
                    <strong>
                      {DAY_PLURALS[s.dayOfWeek]} at {shortTime(s.startsAt)}
                    </strong>
                    <div className="faint" style={{ fontSize: 12 }}>
                      {s.durationMinutes} min
                      {s.amountPaise !== null ? ` · ${rupees(s.amountPaise)} fixed` : ' · rule price'}
                    </div>
                  </td>
                  <td>{s.resourceName}</td>
                  <td>
                    {s.customerName ?? <span className="faint">—</span>}
                    {s.customerPhone && (
                      <div className="faint mono" style={{ fontSize: 12 }}>
                        {s.customerPhone}
                      </div>
                    )}
                  </td>
                  <td className="num mono">{s.upcoming}</td>
                  <td className="mono">
                    {s.status === 'ended' ? (
                      <span className="pill cancelled">ended</span>
                    ) : s.materialisedThrough ? (
                      DateTime.fromISO(s.materialisedThrough).toFormat('d LLL yy')
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="num">
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button className="sm" onClick={() => setOpenId(s.id)}>
                        Details
                      </button>
                      {s.status === 'active' && (
                        <button
                          className="sm"
                          onClick={() => extend.mutate(s.id)}
                          disabled={extend.isPending}
                        >
                          Extend
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {extendResult && (
        <Modal
          title="Extended"
          onClose={() => setExtendResult(null)}
          footer={
            <>
              <span className="spacer" />
              <button className="primary" onClick={() => setExtendResult(null)}>
                Done
              </button>
            </>
          }
        >
          <SeriesResult result={extendResult} timezone={tz} />
        </Modal>
      )}

      {openId && <SeriesDetailModal seriesId={openId} timezone={tz} onClose={() => setOpenId(null)} />}
    </>
  );
}

function SeriesDetailModal({
  seriesId,
  timezone,
  onClose,
}: {
  seriesId: string;
  timezone: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const { data } = useQuery({
    queryKey: ['series', seriesId],
    queryFn: () => get<SeriesDetail>(`/series/${seriesId}`),
  });

  const end = useMutation({
    mutationFn: () => post(`/series/${seriesId}/end`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['series'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
      onClose();
    },
  });

  if (!data) {
    return (
      <Modal title="Recurring booking" onClose={onClose}>
        <span className="faint">Loading…</span>
      </Modal>
    );
  }

  const upcoming = data.occurrences.filter(
    (o) => o.status !== 'cancelled' && o.occurrenceDate >= DateTime.now().setZone(timezone).toISODate()!,
  );

  return (
    <Modal
      title={`${DAY_PLURALS[data.dayOfWeek]} at ${shortTime(data.startsAt)}`}
      onClose={onClose}
      footer={
        <>
          {data.status === 'active' &&
            (confirming ? (
              <button className="danger" onClick={() => end.mutate()} disabled={end.isPending}>
                Yes, cancel {upcoming.length} upcoming
              </button>
            ) : (
              <button className="danger" onClick={() => setConfirming(true)}>
                End series
              </button>
            ))}
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </>
      }
    >
      <div className="slot-banner">
        <div>
          <div className="court">{data.resourceName}</div>
          <div className="when">
            {data.customerName ?? 'No customer'} · {data.durationMinutes} min
          </div>
        </div>
        <span className={`pill ${data.status === 'active' ? 'confirmed' : 'cancelled'}`}>
          {data.status}
        </span>
      </div>

      {confirming && (
        <div className="msg error">
          Ending the series cancels its {upcoming.length} upcoming bookings. Past ones are kept.
        </div>
      )}

      {end.error instanceof ApiError && <div className="msg error">{end.error.message}</div>}

      <table className="list">
        <tbody>
          {data.occurrences.map((o) => (
            <tr key={o.id}>
              <td className="mono">
                {DateTime.fromISO(o.occurrenceDate).toFormat('ccc d LLL yy')}
              </td>
              <td>
                <span className={`pill ${o.status}`}>{o.status.replace('_', ' ')}</span>
              </td>
              <td className="num mono">{rupees(o.amountPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
