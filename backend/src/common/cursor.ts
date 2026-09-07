import { BadRequestException } from '@nestjs/common';

/**
 * Keyset pagination cursors.
 *
 * Keyset rather than OFFSET: a booking list is sorted by start time and rows
 * are inserted into the middle of it all day, so offsets skip and repeat rows
 * while an owner pages. The cursor is the last row's sort key, which is stable
 * whatever else gets booked.
 *
 * Base64 only to discourage callers from building their own; it is not a
 * secret, and it is validated on the way back in.
 */
export interface Cursor {
  sort: string;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(sort: string | Date, id: string): string {
  const value = sort instanceof Date ? sort.toISOString() : sort;
  return Buffer.from(`${value}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): Cursor {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new BadRequestException('Invalid cursor.');
  }

  const separator = decoded.lastIndexOf('|');
  if (separator < 1) throw new BadRequestException('Invalid cursor.');

  const sort = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!UUID_RE.test(id) || Number.isNaN(Date.parse(sort))) {
    throw new BadRequestException('Invalid cursor.');
  }
  return { sort, id };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Trims an over-fetched result down to the page size and derives the cursor.
 * Fetching limit+1 is how we know whether there is more without a second count.
 */
export function toPage<T>(rows: T[], limit: number, key: (row: T) => { sort: string | Date; id: string }): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(key(last).sort, key(last).id) : null,
  };
}
