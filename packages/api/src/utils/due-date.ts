/**
 * Due-date parsing for tasks.
 *
 * `tasks.due_date` is `timestamptz`, but a deadline is normally *expressed* as a
 * calendar date ("due Sept 14"). Storing a bare `YYYY-MM-DD` at 00:00 UTC would
 * read back as the previous day for anyone west of UTC, so date-only input is
 * anchored to the END of that day in the user's own timezone — the reading under
 * which the stored instant always falls on the calendar date the caller asked
 * for. A timestamp carrying an explicit offset is already unambiguous and is
 * stored as the instant it names.
 *
 * Rule of thumb: no offset means the caller meant their own wall clock. Nothing
 * here depends on the server's timezone.
 */

import { logger } from './logger';

export type DueDateResolution = { ok: true; value: string | null } | { ok: false; error: string };

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL_CLOCK_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3})\d*)?$/;
const HAS_EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

const EXPECTED =
  'Expected "YYYY-MM-DD" (end of that day in your timezone) or an ISO-8601 datetime such as "2026-09-14T17:00:00Z"';

/**
 * Resolve caller-supplied due-date input to a UTC ISO-8601 string for storage.
 *
 * @param input     `null` to clear the due date, otherwise a date or datetime string.
 * @param timezone  IANA timezone used to interpret offset-less input. Defaults to UTC.
 */
export function resolveDueDate(input: string | null, timezone?: string | null): DueDateResolution {
  // Explicit clear — distinct from "not provided", which callers handle upstream.
  if (input === null) {
    return { ok: true, value: null };
  }

  const raw = input.trim();
  if (raw === '') {
    return { ok: false, error: `Invalid dueDate: value is empty. ${EXPECTED}, or null to clear.` };
  }

  const zone = normalizeTimezone(timezone);

  const dateOnly = DATE_ONLY.exec(raw);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    // End of day: "due Sept 14" means "by the time Sept 14 is over".
    return fromWallClock(
      { year: +year, month: +month, day: +day, hour: 23, minute: 59, second: 59, ms: 999 },
      zone,
      raw
    );
  }

  const wallClock = WALL_CLOCK_DATETIME.exec(raw);
  if (wallClock) {
    const [, year, month, day, hour, minute, second, fraction] = wallClock;
    return fromWallClock(
      {
        year: +year,
        month: +month,
        day: +day,
        hour: +hour,
        minute: +minute,
        second: second ? +second : 0,
        ms: fraction ? +fraction.padEnd(3, '0') : 0,
      },
      zone,
      raw
    );
  }

  if (HAS_EXPLICIT_OFFSET.test(raw)) {
    const instant = Date.parse(raw);
    if (Number.isNaN(instant)) {
      return {
        ok: false,
        error: `Invalid dueDate "${raw}": not a parseable timestamp. ${EXPECTED}.`,
      };
    }
    return { ok: true, value: new Date(instant).toISOString() };
  }

  return { ok: false, error: `Invalid dueDate "${raw}". ${EXPECTED}.` };
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

/**
 * Convert a wall-clock reading in `zone` to the UTC instant it names.
 */
function fromWallClock(wall: WallClock, zone: string, raw: string): DueDateResolution {
  const guess = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
    wall.ms
  );

  // Date.UTC silently rolls impossible readings over (Feb 30 → Mar 2, 10:99 →
  // 11:39). Round-trip every component so those are rejected instead of stored
  // as some other moment the caller never named.
  const probe = new Date(guess);
  const rolled =
    probe.getUTCFullYear() !== wall.year ||
    probe.getUTCMonth() !== wall.month - 1 ||
    probe.getUTCDate() !== wall.day ||
    probe.getUTCHours() !== wall.hour ||
    probe.getUTCMinutes() !== wall.minute ||
    probe.getUTCSeconds() !== wall.second;
  if (rolled) {
    return {
      ok: false,
      error: `Invalid dueDate "${raw}": not a real date and time. ${EXPECTED}.`,
    };
  }

  // Shift the wall-clock reading by the zone's offset. Two passes: the offset at
  // the guessed instant can differ from the offset at the true instant across a
  // DST boundary, and the second pass settles on the right one.
  let instant = guess - offsetMsAt(guess, zone);
  instant = guess - offsetMsAt(instant, zone);

  return { ok: true, value: new Date(instant).toISOString() };
}

/**
 * Offset of `zone` at `instant`, in milliseconds east of UTC.
 */
function offsetMsAt(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));

  const at = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const asUTC = Date.UTC(
    at('year'),
    at('month') - 1,
    at('day'),
    at('hour'),
    at('minute'),
    at('second')
  );

  // formatToParts has no millisecond field, so compare at second granularity.
  return asUTC - Math.floor(instant / 1000) * 1000;
}

/**
 * A malformed stored timezone shouldn't fail the write. UTC end-of-day still
 * lands on the requested calendar date everywhere from UTC-12 to UTC+0.
 */
function normalizeTimezone(timezone?: string | null): string {
  if (!timezone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return timezone;
  } catch {
    logger.warn(`Unrecognized timezone "${timezone}" while resolving a due date; using UTC`);
    return 'UTC';
  }
}
