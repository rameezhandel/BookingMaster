/**
 * Turns a venue name into something that can live in a URL.
 *
 * Uniqueness is not checked here: the slug is unique across the whole system,
 * so a tenant-scoped lookup could not see a clash anyway under row-level
 * security. The unique index decides, and the caller retries with a suffix —
 * which is also the only race-free way to do it.
 */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/** Candidate slugs to try in order: the plain one, then numbered variants. */
export function* slugCandidates(name: string, attempts = 12): Generator<string> {
  const base = slugify(name) || 'venue';
  yield base;
  for (let n = 2; n <= attempts; n++) yield `${base}-${n}`;
}
