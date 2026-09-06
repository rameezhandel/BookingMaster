import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, get, put } from '../lib/api';
import type { CancellationTier, Venue } from '../lib/types';

const PRESET: CancellationTier[] = [
  { minHoursBefore: 24, refundPct: 100 },
  { minHoursBefore: 12, refundPct: 50 },
  { minHoursBefore: 0, refundPct: 0 },
];

/** Tiered refunds, expressed the way an owner says them out loud. */
export function CancellationPolicyCard({ venue }: { venue: Venue }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<CancellationTier[]>([]);
  const [dirty, setDirty] = useState(false);

  const { data } = useQuery({
    queryKey: ['cancellation-policy', venue.id],
    queryFn: () => get<CancellationTier[]>(`/venues/${venue.id}/cancellation-policy`),
  });

  useEffect(() => {
    if (data && !dirty) setDraft(data);
  }, [data, dirty]);

  const save = useMutation({
    mutationFn: () => put(`/venues/${venue.id}/cancellation-policy`, { tiers: draft }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cancellation-policy', venue.id] });
      setDirty(false);
    },
  });

  const edit = (next: CancellationTier[]) => {
    setDirty(true);
    setDraft(next);
  };

  const sorted = [...draft].sort((a, b) => b.minHoursBefore - a.minHoursBefore);

  return (
    <div className="card">
      <div className="card-head">
        <h2>Cancellation policy</h2>
        <span className="spacer" />
        {save.isSuccess && !dirty && <span className="faint">Saved</span>}
        {draft.length === 0 && (
          <button className="sm" onClick={() => edit(PRESET)}>
            Use 24h / 12h preset
          </button>
        )}
        <button className="primary sm" onClick={() => save.mutate()} disabled={save.isPending || !dirty}>
          Save
        </button>
      </div>

      <div className="card-body">
        {save.error instanceof ApiError && <div className="msg error">{save.error.message}</div>}

        {draft.length === 0 ? (
          <p className="muted" style={{ marginTop: 0 }}>
            No policy set. Cancelling will not suggest a refund — you can still enter one by hand each
            time.
          </p>
        ) : (
          sorted.map((tier, i) => (
            <div className="row" key={i} style={{ marginBottom: 8 }}>
              <span className="faint" style={{ width: 128, fontSize: 13 }}>
                Cancel at least
              </span>
              <input
                type="number"
                min={0}
                max={8760}
                value={tier.minHoursBefore}
                onChange={(e) =>
                  edit(
                    draft.map((t) =>
                      t === tier ? { ...t, minHoursBefore: Number(e.target.value) } : t,
                    ),
                  )
                }
                style={{ width: 88 }}
                aria-label="Hours before"
              />
              <span className="faint" style={{ fontSize: 13 }}>
                hours before, refund
              </span>
              <input
                type="number"
                min={0}
                max={100}
                value={tier.refundPct}
                onChange={(e) =>
                  edit(draft.map((t) => (t === tier ? { ...t, refundPct: Number(e.target.value) } : t)))
                }
                style={{ width: 76 }}
                aria-label="Refund percent"
              />
              <span className="faint" style={{ fontSize: 13 }}>
                %
              </span>
              <span className="spacer" />
              <button className="danger sm" onClick={() => edit(draft.filter((t) => t !== tier))}>
                ✕
              </button>
            </div>
          ))
        )}

        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="sm"
            onClick={() => edit([...draft, { minHoursBefore: 0, refundPct: 0 }])}
            disabled={draft.length >= 10}
          >
            + Add rule
          </button>
        </div>

        <div className="hint" style={{ marginTop: 10 }}>
          The most generous rule a cancellation still qualifies for wins. Refunds are capped at what
          was actually collected, and the amount stays editable when you cancel.
        </div>
      </div>
    </div>
  );
}
