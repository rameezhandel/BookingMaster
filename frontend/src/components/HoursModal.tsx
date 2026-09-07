import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, get, put } from '../lib/api';
import { DAY_NAMES, shortTime } from '../lib/format';
import type { Court, HourWindow } from '../lib/types';
import { Modal } from './Modal';

const DAYS = [1, 2, 3, 4, 5, 6, 0]; // Monday first, the way a week is read.

/**
 * Opening hours, a day at a time.
 *
 * A day can carry more than one window, because venues really do shut in the
 * middle of the day for school or academy hours. A day with no window is a day
 * the court does not open at all.
 */
export function HoursModal({ court, onClose }: { court: Court; onClose: () => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<HourWindow[]>([]);
  const [dirty, setDirty] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['hours', court.id],
    queryFn: () => get<HourWindow[]>(`/resources/${court.id}/hours`),
  });

  useEffect(() => {
    if (data && !dirty) {
      setDraft(data.map((w) => ({ dayOfWeek: w.dayOfWeek, opensAt: shortTime(w.opensAt), closesAt: shortTime(w.closesAt) })));
    }
  }, [data, dirty]);

  const save = useMutation({
    mutationFn: () => put(`/resources/${court.id}/hours`, { windows: draft }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hours', court.id] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
      qc.invalidateQueries({ queryKey: ['week'] });
      setDirty(false);
      onClose();
    },
  });

  function edit(next: HourWindow[]) {
    setDirty(true);
    setDraft(next);
  }

  const windowsFor = (day: number) => draft.filter((w) => w.dayOfWeek === day);

  function addWindow(day: number) {
    const existing = windowsFor(day);
    const last = existing[existing.length - 1];
    edit([
      ...draft,
      { dayOfWeek: day, opensAt: last ? last.closesAt : '06:00', closesAt: last ? '23:00' : '23:00' },
    ]);
  }

  function updateWindow(day: number, index: number, patch: Partial<HourWindow>) {
    let seen = -1;
    edit(
      draft.map((w) => {
        if (w.dayOfWeek !== day) return w;
        seen++;
        return seen === index ? { ...w, ...patch } : w;
      }),
    );
  }

  function removeWindow(day: number, index: number) {
    let seen = -1;
    edit(
      draft.filter((w) => {
        if (w.dayOfWeek !== day) return true;
        seen++;
        return seen !== index;
      }),
    );
  }

  /** Copy Monday across the working week — the most common edit by far. */
  function copyMondayToWeekdays() {
    const monday = windowsFor(1);
    const others = draft.filter((w) => ![2, 3, 4, 5].includes(w.dayOfWeek));
    edit([
      ...others,
      ...[2, 3, 4, 5].flatMap((day) => monday.map((w) => ({ ...w, dayOfWeek: day }))),
    ]);
  }

  return (
    <Modal
      title={`Opening hours — ${court.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="ghost sm" onClick={copyMondayToWeekdays}>
            Copy Monday to Tue–Fri
          </button>
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save hours'}
          </button>
        </>
      }
    >
      {save.error instanceof ApiError && <div className="msg error">{save.error.message}</div>}
      {isLoading ? (
        <span className="faint">Loading…</span>
      ) : (
        <>
          {DAYS.map((day) => {
            const windows = windowsFor(day);
            return (
              <div className="day-row" key={day}>
                <div className="dayname">{DAY_NAMES[day]}</div>
                <div className="windows">
                  {windows.length === 0 ? (
                    <div className="closed-note">Closed</div>
                  ) : (
                    windows.map((w, i) => (
                      <div className="window" key={i}>
                        <input
                          type="time"
                          value={w.opensAt}
                          onChange={(e) => updateWindow(day, i, { opensAt: e.target.value })}
                          aria-label={`${DAY_NAMES[day]} opens`}
                        />
                        <span className="faint">–</span>
                        <input
                          type="time"
                          value={w.closesAt}
                          onChange={(e) => updateWindow(day, i, { closesAt: e.target.value })}
                          aria-label={`${DAY_NAMES[day]} closes`}
                        />
                        <button className="ghost sm" onClick={() => removeWindow(day, i)} aria-label="Remove window">
                          ✕
                        </button>
                      </div>
                    ))
                  )}
                </div>
                <button className="sm" onClick={() => addWindow(day)}>
                  + Window
                </button>
              </div>
            );
          })}
          <div className="hint" style={{ marginTop: 12 }}>
            Two windows on one day model a midday closure. Use 24:00 to close at midnight. A day with
            no window is treated as closed.
          </div>
        </>
      )}
    </Modal>
  );
}
