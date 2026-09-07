-- Makes a venue publishable: a stable public URL, and the limits that decide
-- what a stranger is allowed to book.
--
-- Publishing is opt-in and off by default. A venue that has not finished
-- entering its courts and prices should not be discoverable.

ALTER TABLE venue
  ADD COLUMN slug text,
  ADD COLUMN is_published boolean NOT NULL DEFAULT false,
  -- How far ahead the public may book. Without a ceiling someone books a court
  -- for a Tuesday in 2031 and it sits on the calendar forever.
  ADD COLUMN booking_window_days integer NOT NULL DEFAULT 30
    CHECK (booking_window_days BETWEEN 1 AND 365),
  -- Minimum notice. Turning up to a court booked ninety seconds ago is nobody's
  -- idea of a good time.
  ADD COLUMN min_notice_minutes integer NOT NULL DEFAULT 60
    CHECK (min_notice_minutes BETWEEN 0 AND 10080);

-- The slug appears in a URL, so it is unique across the whole system, not per
-- tenant. Case-insensitively: /v/Smash-Arena and /v/smash-arena are the same
-- place, and two venues owning one each would be a genuine mess.
CREATE UNIQUE INDEX venue_slug_key ON venue (lower(slug)) WHERE slug IS NOT NULL;

ALTER TABLE venue
  ADD CONSTRAINT venue_slug_format CHECK (
    slug IS NULL OR slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  -- Publishing without a slug would produce a venue with no address to share.
  ADD CONSTRAINT venue_published_needs_slug CHECK (NOT is_published OR slug IS NOT NULL);

-- Backfill a slug for venues that already exist, from the name, de-duplicated.
WITH slugged AS (
  SELECT
    id,
    regexp_replace(
      trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')),
      '-{2,}', '-', 'g'
    ) AS base,
    row_number() OVER (
      PARTITION BY regexp_replace(
        trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')),
        '-{2,}', '-', 'g'
      ) ORDER BY created_at, id
    ) AS n
  FROM venue
)
UPDATE venue v
SET slug = CASE WHEN s.n = 1 THEN s.base ELSE s.base || '-' || s.n END
FROM slugged s
WHERE v.id = s.id AND nullif(s.base, '') IS NOT NULL;
