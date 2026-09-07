import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, patch } from '../lib/api';
import type { Venue } from '../lib/types';

/**
 * Publishing a venue: its public address, and the limits on what a stranger may
 * book. Off until an owner turns it on, because a half-configured venue makes a
 * bad first impression of the venue rather than of us.
 */
export function PublishCard({ venue }: { venue: Venue }) {
  const qc = useQueryClient();
  const [slug, setSlug] = useState(venue.slug ?? '');
  const [windowDays, setWindowDays] = useState(venue.bookingWindowDays);
  const [notice, setNotice] = useState(venue.minNoticeMinutes);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setSlug(venue.slug ?? '');
    setWindowDays(venue.bookingWindowDays);
    setNotice(venue.minNoticeMinutes);
  }, [venue.id, venue.slug, venue.bookingWindowDays, venue.minNoticeMinutes]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch(`/venues/${venue.id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['venues'] }),
  });

  const url = `${location.origin}/v/${venue.slug ?? slug}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked; the link is on screen to copy by hand */
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Public booking page</h2>
        <span className="spacer" />
        <span className={`pill ${venue.isPublished ? 'confirmed' : 'cancelled'}`}>
          {venue.isPublished ? 'live' : 'not published'}
        </span>
        <button
          className={venue.isPublished ? '' : 'primary'}
          onClick={() => save.mutate({ isPublished: !venue.isPublished })}
          disabled={save.isPending}
        >
          {venue.isPublished ? 'Unpublish' : 'Publish'}
        </button>
      </div>

      <div className="card-body">
        {save.error instanceof ApiError && <div className="msg error">{save.error.message}</div>}

        {venue.isPublished ? (
          <div className="slot-banner" style={{ marginBottom: 16 }}>
            <div>
              <div className="faint" style={{ fontSize: 11, textTransform: 'uppercase' }}>
                Share this link
              </div>
              <a className="court" href={url} target="_blank" rel="noreferrer">
                {url}
              </a>
            </div>
            <button className="sm" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        ) : (
          <p className="muted" style={{ marginTop: 0 }}>
            Not visible to anyone yet. Publishing gives this venue a public page showing which
            courts are free and what they cost.
          </p>
        )}

        <div className="field">
          <label htmlFor="pub-slug">Web address</label>
          <div className="row">
            <span className="faint mono" style={{ fontSize: 13 }}>
              /v/
            </span>
            <input
              id="pub-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="smash-arena-hsr"
            />
            <button
              className="sm"
              onClick={() => save.mutate({ slug })}
              disabled={save.isPending || slug === (venue.slug ?? '') || !slug.trim()}
            >
              Save
            </button>
          </div>
          <div className="hint">Lowercase letters, numbers and hyphens. Must be unique.</div>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="pub-window">Book up to (days ahead)</label>
            <input
              id="pub-window"
              type="number"
              min={1}
              max={365}
              value={windowDays}
              onChange={(e) => setWindowDays(Number(e.target.value))}
              onBlur={() =>
                windowDays !== venue.bookingWindowDays && save.mutate({ bookingWindowDays: windowDays })
              }
            />
          </div>
          <div className="field">
            <label htmlFor="pub-notice">Minimum notice (minutes)</label>
            <input
              id="pub-notice"
              type="number"
              min={0}
              max={10080}
              value={notice}
              onChange={(e) => setNotice(Number(e.target.value))}
              onBlur={() =>
                notice !== venue.minNoticeMinutes && save.mutate({ minNoticeMinutes: notice })
              }
            />
          </div>
        </div>

        <div className="field" style={{ marginTop: 4 }}>
          <label className="checkline">
            <input
              type="checkbox"
              checked={venue.requiresPrepayment}
              onChange={(e) => save.mutate({ requiresPrepayment: e.target.checked })}
            />
            <span>Take payment online before confirming</span>
          </label>
          <div className="hint">
            Off means players book online and pay at the court. On requires a payment provider to be
            configured on the server.
          </div>
        </div>

        <div className="hint">
          You can always book anything from the calendar yourself. These limits apply only to the
          public page.
        </div>
      </div>
    </div>
  );
}
