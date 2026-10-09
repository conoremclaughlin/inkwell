/**
 * Paging for GET /api/admin/tasks (task 0ed92d60).
 *
 * A page is a keyset slice, newest first by (created_at, id). The cursor is
 * the last row's pair, so a task added while someone pages lands before
 * every cursor already handed out and moves nothing after it. The id breaks
 * ties: tasks share timestamps (639 pending tasks held 632 distinct values
 * on 2026-10-08), and a created_at-only cursor skips or repeats the rest of
 * a tie.
 *
 * created_at travels as the text Postgres printed, never through a Date. A
 * timestamptz has microseconds and a Date keeps milliseconds, so a cursor
 * rebuilt from a Date lands inside a run of rows that differ only below the
 * millisecond.
 *
 * The cursor is opaque to callers (base64url), and validated strictly on the
 * way back in: its two values go into a PostgREST filter string.
 */

/** PostgREST's max_rows (supabase/config.toml), and the route's cap before paging existed. */
export const TASKS_PAGE_MAX = 1000;

export interface TasksCursor {
  /** created_at exactly as PostgREST returned it. */
  createdAt: string;
  id: string;
}

/** Unpaged keeps today's answer; paged is opted into by `limit` or `before`. */
export type TasksPageRequest =
  | { paged: false }
  | { paged: true; limit: number; before: TasksCursor | null };

export type TasksPageParse = { ok: true; page: TasksPageRequest } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A timestamptz as PostgREST prints it: optional fraction up to microseconds, then Z or an offset. */
const TIMESTAMPTZ =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-](\d{2}):(\d{2}))$/;

/**
 * True when every field names a real instant, so Postgres never sees a day
 * it would refuse (February 30 passes the shape, and Date.parse rolls it
 * into March).
 */
function isRealTimestamp(match: RegExpExecArray): boolean {
  const [, year, month, day, hour, minute, second, , , offsetHours, offsetMinutes] =
    match.map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return (
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    (Number.isNaN(offsetHours) || (offsetHours <= 15 && offsetMinutes <= 59))
  );
}
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const LIMIT = /^[1-9]\d{0,3}$/;
/** Longest cursor a valid pair encodes to, with room to spare. */
const CURSOR_MAX_LENGTH = 160;

export function encodeTasksCursor(cursor: TasksCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id]), 'utf8').toString('base64url');
}

/** The cursor's pair, or null for anything this route didn't issue. */
export function decodeTasksCursor(value: string): TasksCursor | null {
  if (value.length > CURSOR_MAX_LENGTH || !BASE64URL.test(value)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [createdAt, id] = parsed as unknown[];
  if (typeof createdAt !== 'string') return null;
  const timestamp = TIMESTAMPTZ.exec(createdAt);
  if (!timestamp || !isRealTimestamp(timestamp)) return null;
  if (typeof id !== 'string' || !UUID.test(id)) return null;
  return { createdAt, id };
}

/**
 * Reads `limit` and `before` from a request's query. Either one opts into
 * paging; a value given twice (an array) or malformed is refused rather than
 * read as absent, so a caller never gets the unpaged answer by mistake.
 */
export function parseTasksPage(query: { limit?: unknown; before?: unknown }): TasksPageParse {
  const { limit, before } = query;
  if (limit === undefined && before === undefined) return { ok: true, page: { paged: false } };

  let pageLimit = TASKS_PAGE_MAX;
  if (limit !== undefined) {
    if (typeof limit !== 'string' || !LIMIT.test(limit) || Number(limit) > TASKS_PAGE_MAX) {
      return { ok: false, error: `limit must be a whole number from 1 to ${TASKS_PAGE_MAX}` };
    }
    pageLimit = Number(limit);
  }

  let cursor: TasksCursor | null = null;
  if (before !== undefined) {
    cursor = typeof before === 'string' ? decodeTasksCursor(before) : null;
    if (!cursor) return { ok: false, error: 'before must be a nextBefore value from this route' };
  }

  return { ok: true, page: { paged: true, limit: pageLimit, before: cursor } };
}

/**
 * The PostgREST `or` filter for rows after the cursor in (created_at desc,
 * id desc) order. Values are double-quoted because a timestamp carries the
 * `.` and `:` that PostgREST reserves inside a logic tree.
 */
export function afterCursorFilter(cursor: TasksCursor): string {
  return (
    `created_at.lt."${cursor.createdAt}",` +
    `and(created_at.eq."${cursor.createdAt}",id.lt.${cursor.id})`
  );
}
