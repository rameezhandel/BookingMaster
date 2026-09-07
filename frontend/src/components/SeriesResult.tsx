import { DateTime } from 'luxon';
import { rupees } from '../lib/format';
import type { MaterialiseResult } from '../lib/types';

const REASON_LABEL: Record<string, string> = {
  clash: 'Already booked',
  closed: 'Court closed',
  'outside-hours': 'Outside opening hours',
  'already-booked': 'Already on the calendar',
};

/**
 * What a recurring booking actually managed to reserve.
 *
 * The weeks that could *not* be booked are the important half: an owner who
 * thinks they have a Tuesday slot for six months, and does not, finds out at
 * the worst possible moment.
 */
export function SeriesResult({ result, timezone }: { result: MaterialiseResult; timezone: string }) {
  const day = (iso: string) => DateTime.fromISO(iso, { zone: timezone }).toFormat('ccc d LLL');
  const notable = result.skipped.filter((s) => s.reason !== 'already-booked');

  return (
    <>
      <div className="stats" style={{ marginBottom: 14 }}>
        <div className="stat">
          <div className="k">Booked</div>
          <div className="v paid-flag">{result.created.length}</div>
        </div>
        <div className="stat">
          <div className="k">Could not book</div>
          <div className={`v ${notable.length ? 'due-flag' : ''}`}>{notable.length}</div>
        </div>
        <div className="stat">
          <div className="k">Through</div>
          <div className="v" style={{ fontSize: 14 }}>{day(result.materialisedThrough)}</div>
        </div>
      </div>

      {notable.length > 0 && (
        <>
          <div className="msg error" style={{ marginBottom: 10 }}>
            These weeks were not booked. Sort them out individually on the calendar.
          </div>
          <table className="list" style={{ marginBottom: 16 }}>
            <tbody>
              {notable.map((s) => (
                <tr key={s.date}>
                  <td className="mono">{day(s.date)}</td>
                  <td>
                    <span className="pill no_show">{REASON_LABEL[s.reason] ?? s.reason}</span>
                  </td>
                  <td className="faint">{s.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {result.created.length > 0 && (
        <details>
          <summary className="muted" style={{ cursor: 'pointer', marginBottom: 8 }}>
            {result.created.length} bookings created
          </summary>
          <table className="list">
            <tbody>
              {result.created.map((c) => (
                <tr key={c.date}>
                  <td className="mono">{day(c.date)}</td>
                  <td className="num mono">{rupees(c.amountPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </>
  );
}
