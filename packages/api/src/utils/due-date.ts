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

/**
 * Convert wall-clock fields in `timeZone` to the UTC instant they name.
 *
 * Two passes: the offset depends on the instant, and the instant depends on the
 * offset. The first guess is corrected once, which settles every case except a
 * wall-clock time that a DST jump skipped entirely.
 */
function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  timeZone: string
): Date {
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const firstGuess = wallClockAsUtc - offsetMinutesAt(new Date(wallClockAsUtc), timeZone) * 60_000;
  const corrected = wallClockAsUtc - offsetMinutesAt(new Date(firstGuess), timeZone) * 60_000;
  return new Date(corrected);
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
    return zonedWallClockToUtc(year, month, day, 23, 59, 59, 999, zone).toISOString();
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidDueDateError(
      `Invalid dueDate "${value}" — use YYYY-MM-DD or a full ISO 8601 timestamp (e.g. 2026-09-14T17:00:00-07:00).`
    );
  }
  return parsed.toISOString();
}
