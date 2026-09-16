/**
 * Due date resolution.
 *
 * `tasks.due_date` is a `timestamptz`, but people and agents state deadlines as
 * calendar days — "renew the domain by Sept 14". Storing a bare date as UTC
 * midnight breaks that in two visible ways for anyone west of Greenwich: the
 * dashboard renders the *previous* day, and the task counts as overdue for the
 * entire day it is actually due.
 *
 * So a bare `YYYY-MM-DD` is resolved to the END of that day in the user's
 * timezone — the deadline has not passed until the day has. Fully-qualified
 * timestamps already carry an offset and are normalized to UTC unchanged.
 */

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict full timestamp: date, time, and a REQUIRED offset (Z or ±HH:MM). */
const STRICT_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|z|[+-]\d{2}:?\d{2})$/;

/** A due date string the caller supplied that we cannot turn into an instant. */
export class InvalidDueDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDueDateError';
  }
}

/** True when the value is a bare calendar date and therefore timezone-sensitive. */
export function isBareDate(value: string): boolean {
  return BARE_DATE.test(value.trim());
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Minutes that `timeZone` is ahead of UTC at the given instant.
 * Derived by formatting the instant in the zone and reading the wall-clock
 * fields back as if they were UTC — the difference is the offset.
 */
function offsetMinutesAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const field = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asIfUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    // en-US hour12:false renders midnight as "24" in some ICU versions.
    field('hour') % 24,
    field('minute'),
    field('second')
  );

  // Rounded because formatToParts has no milliseconds field: without this the
  // truncated sub-second remainder is read back as part of the zone offset.
  return Math.round((asIfUtc - instant.getTime()) / 60_000);
}

/** The zone-local calendar date of an instant, as a comparable number. */
function localDateKey(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instantMs));
  const field = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return field('year') * 10_000 + field('month') * 100 + field('day');
}

/**
 * The LAST instant of a calendar day in `timeZone`: the first instant of the
 * next local day, minus 1 ms.
 *
 * Built as a boundary WALK rather than wall-clock arithmetic, because
 * 23:59:59.999 does not always exist (a DST gap can swallow it — the old
 * two-pass produced an instant an hour before the day actually ended in
 * America/Godthab) and can exist twice (an overlap made the earlier
 * occurrence win in America/Santiago, again ending the day early). The walk
 * is definitionally correct in both cases: it finds the exact instant the
 * local date flips, whatever the zone did that night. Offsets are
 * whole-minute in every IANA zone since 1972, so a minute-granular walk
 * lands exactly on the boundary; the two-pass guess starts within a few
 * hours of it, bounding the walk.
 */
function endOfLocalDayUtc(year: number, month: number, day: number, timeZone: string): Date {
  const dayKey = year * 10_000 + month * 100 + day;

  // Initial guess: next-day local midnight via the offset at that wall clock.
  const nextMidnightAsUtc = Date.UTC(year, month - 1, day + 1, 0, 0, 0, 0);
  let t = nextMidnightAsUtc - offsetMinutesAt(new Date(nextMidnightAsUtc), timeZone) * 60_000;

  // Walk forward while still inside the target day, back while the previous
  // minute is already past it — converging on the first instant of the next
  // local day.
  while (localDateKey(t, timeZone) <= dayKey) t += 60_000;
  while (localDateKey(t - 60_000, timeZone) > dayKey) t -= 60_000;

  return new Date(t - 1);
}

/** Reject dates that roll over, e.g. 2026-02-30 or 2026-13-01. */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * Resolve a caller-supplied due date to an ISO-8601 UTC timestamp.
 *
 * @param value    Bare `YYYY-MM-DD`, or any timestamp `Date` can parse.
 * @param timezone IANA zone used only to place a bare date. Invalid zones fall
 *                 back to UTC rather than failing the write.
 * @throws {InvalidDueDateError} when the value does not name a real instant.
 */
export function resolveDueDate(value: string, timezone: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new InvalidDueDateError(
      'dueDate is empty — pass YYYY-MM-DD, a full ISO 8601 timestamp, or null to clear it.'
    );
  }

  if (BARE_DATE.test(trimmed)) {
    const [year, month, day] = trimmed.split('-').map(Number);
    if (!isRealCalendarDate(year, month, day)) {
      throw new InvalidDueDateError(`Invalid dueDate "${value}" — not a real calendar date.`);
    }
    const zone = isValidTimeZone(timezone) ? timezone : 'UTC';
    return endOfLocalDayUtc(year, month, day, zone).toISOString();
  }

  // Full timestamps must be STRICT ISO 8601 with an explicit offset.
  // `new Date(string)` accepts far more — an offsetless timestamp resolves
  // differently per API host's TZ, locale strings like 09/14/2026 parse, and
  // impossible dates (Feb 30) silently normalize to March. The deadline a
  // caller stated must not depend on where the server runs.
  const m = STRICT_TIMESTAMP.exec(trimmed);
  if (!m) {
    throw new InvalidDueDateError(
      `Invalid dueDate "${value}" — use YYYY-MM-DD, or a full ISO 8601 timestamp with an ` +
        `explicit offset (e.g. 2026-09-14T17:00:00-07:00 or 2026-09-14T17:00:00Z).`
    );
  }
  const [, ys, mos, ds, hs, mins, secs = '0', msRaw = '0', offset] = m;
  const [year, month, day, hour, minute, second] = [ys, mos, ds, hs, mins, secs].map(Number);
  const ms = Number(msRaw.padEnd(3, '0').slice(0, 3));
  if (!isRealCalendarDate(year, month, day)) {
    throw new InvalidDueDateError(`Invalid dueDate "${value}" — not a real calendar date.`);
  }
  if (hour > 23 || minute > 59 || second > 59) {
    throw new InvalidDueDateError(`Invalid dueDate "${value}" — not a real time of day.`);
  }
  let offsetMinutes = 0;
  if (offset !== 'Z' && offset !== 'z') {
    const om = /^([+-])(\d{2}):?(\d{2})$/.exec(offset)!;
    const offsetHourPart = Number(om[2]);
    const offsetMinutePart = Number(om[3]);
    // The minute component is a base-60 field, not a free integer: +00:99
    // would otherwise total to a "valid" 99-minute offset (Lumen #503 r2).
    if (offsetMinutePart > 59) {
      throw new InvalidDueDateError(`Invalid dueDate "${value}" — impossible UTC offset.`);
    }
    offsetMinutes = (om[1] === '-' ? -1 : 1) * (offsetHourPart * 60 + offsetMinutePart);
    if (Math.abs(offsetMinutes) > 14 * 60) {
      throw new InvalidDueDateError(`Invalid dueDate "${value}" — impossible UTC offset.`);
    }
  }
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMinutes * 60_000
  ).toISOString();
}
