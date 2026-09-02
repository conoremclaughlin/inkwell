/**
 * Quiet hours — one predicate, used by the thing that DEFERS and the thing that
 * WARNS about deferral.
 *
 * A reminder due inside quiet hours is skipped before it is ever claimed, and
 * stays due, and is skipped again on every tick until the window ends. That is
 * deliberate. What was missing is that nothing said so: the reminder simply
 * arrived late, and the lateness looked like scheduler lag.
 *
 * It cost a real near-miss. Conor's Spravato fasting prep was scheduled 07:30
 * against a 09:00 deadline; it delivered at 08:06 (2026-09-02). Myra read the
 * 36 minutes as lag and drew the rule "schedule against the lag" — which does
 * NOTHING here, because a held reminder releases when the window ends whatever
 * time it was set for. 07:30, 06:00 and 05:00 all deliver at the same moment.
 * The 90-minute margin didn't absorb a delay; it happened to start far enough
 * back that the release still beat the deadline.
 *
 * So the useful thing is not a shorter deferral, it is a VISIBLE one — said at
 * creation, while the caller can still move the reminder or exempt it. And the
 * warning has to come from the same predicate the scheduler skips on, or the
 * two will disagree and the warning becomes its own kind of lie.
 */

/** A user's configured quiet window. Missing bounds mean no quiet hours. */
export interface QuietHoursWindow {
  /** "HH:MM", local to `timezone`. */
  start?: string | null;
  /** "HH:MM", local to `timezone`. */
  end?: string | null;
  /** IANA zone. Falls back to UTC, which is what the row default is. */
  timezone?: string | null;
}

/**
 * Local wall-clock "HH:MM" for an instant, in a specific zone.
 *
 * The bug this replaces read `now.getHours()` — the SERVER's clock — while
 * selecting the user's `timezone` column and never using it, under a comment
 * admitting "timezone handling can be enhanced". Harmless only for as long as
 * the server runs on the user's own machine, which is a deployment accident
 * rather than a property of the code.
 *
 * An unknown zone throws inside Intl; treated as UTC rather than crashing the
 * heartbeat, because a scheduler that dies on a bad config string is a worse
 * failure than one that mis-times a quiet window.
 */
/**
 * Intl formatters are expensive to construct and safe to reuse. The minute-walk
 * below can ask for hundreds of conversions in one request, and building a
 * formatter each time cost ~44ms warm / ~115ms cold on a synchronous request
 * path (Lumen, PR #568).
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    // An unusable zone falls back to UTC rather than crashing the heartbeat: a
    // scheduler that dies on a bad config string is worse than one that
    // mis-times a window.
    formatter = formatterFor('UTC');
  }
  formatterCache.set(timezone, formatter);
  return formatter;
}

/**
 * Local wall-clock "HH:MM" for an instant, in a specific zone.
 *
 * The bug this replaces read `now.getHours()` — the SERVER's clock — while
 * selecting the user's `timezone` column and never using it, under a comment
 * admitting "timezone handling can be enhanced". Harmless only for as long as
 * the server runs on the user's own machine, which is a deployment accident
 * rather than a property of the code.
 */
export function localTimeOfDay(instant: Date, timezone?: string | null): string {
  return formatterFor(timezone || 'UTC').format(instant);
}

/**
 * "HH:MM" or "HH:MM:SS" → minutes since midnight, or null if unparseable.
 *
 * Comparison is numeric because these two values arrive in DIFFERENT SHAPES and
 * always have. `heartbeat_state.quiet_start/quiet_end` are Postgres `time`,
 * which serializes as `HH:MM:SS`; the wall clock computed above is `HH:MM`.
 * Compared as strings, `'08:00' < '08:00:00'` is TRUE — a shorter string is a
 * prefix and therefore lesser — so the window stayed shut for one extra minute
 * and the warning reported an 08:01 boundary for an 08:00 window (Lumen,
 * PR #568, reproduced against the real row shape).
 *
 * Worth stating plainly: the defect this whole PR repairs came from comparing
 * two representations of a time. I then repaired it by comparing two
 * representations of a time. Numbers remove the category.
 */
export function timeOfDayToMinutes(value: string | null | undefined): number | null {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!match) return null;
  const hours = Number.parseInt(match[1]!, 10);
  const minutes = Number.parseInt(match[2]!, 10);
  if (hours > 23 || minutes > 59) return null;
  // Seconds are deliberately discarded rather than rounded: the scheduler ticks
  // in minutes, so a boundary of 08:00:30 and one of 08:00:00 are the same
  // boundary in practice, and rounding would move it.
  return hours * 60 + minutes;
}

/**
 * Is this instant inside the user's quiet window?
 *
 * Overnight windows (start > end, e.g. 22:00–08:00) wrap midnight, which is the
 * normal case and the one every real config here uses.
 */
export function isWithinQuietHours(instant: Date, window: QuietHoursWindow): boolean {
  const start = timeOfDayToMinutes(window.start);
  const end = timeOfDayToMinutes(window.end);
  if (start === null || end === null) return false;
  // Equal bounds would otherwise mean "always quiet" via the wrap branch, which
  // silently mutes every reminder forever.
  if (start === end) return false;

  const now = timeOfDayToMinutes(localTimeOfDay(instant, window.timezone));
  if (now === null) return false;

  // Overnight windows (start > end, e.g. 22:00-08:00) wrap midnight, which is
  // the normal case and the one every real config here uses.
  if (start > end) return now >= start || now < end;
  return now >= start && now < end;
}

/**
 * When a reminder due at `instant` would ACTUALLY be delivered.
 *
 * Returns the instant itself when it falls outside quiet hours. Otherwise the
 * moment the scheduler stops skipping it.
 *
 * Walked rather than computed, because a wall-clock boundary is not a fixed
 * offset: a DST transition inside the window moves it by an hour, and the
 * arithmetic that gets that right is the arithmetic that gets it subtly wrong.
 * Coarse-then-fine so the walk is cheap — 30-minute strides to cross the bulk
 * of the window, then one-minute steps to land exactly on the edge. Worst case
 * is roughly 80 conversions against a cached formatter rather than 1,500
 * against fresh ones (Lumen, PR #568).
 *
 * Minute-accurate rather than tick-accurate: delivery lands on the first
 * scheduler tick at or after this, so real arrival is this value plus up to one
 * tick interval.
 */
export function effectiveDeliveryTime(instant: Date, window: QuietHoursWindow): Date {
  if (!isWithinQuietHours(instant, window)) return instant;

  const COARSE_MS = 30 * 60_000;
  const cursor = new Date(instant.getTime());
  let lastInside = new Date(instant.getTime());

  // Bounded by 25 hours: a window spans at most a day, and the bound means a
  // malformed config can never spin.
  for (let i = 0; i < (25 * 60) / 30; i += 1) {
    cursor.setTime(cursor.getTime() + COARSE_MS);
    if (!isWithinQuietHours(cursor, window)) break;
    lastInside.setTime(cursor.getTime());
  }
  if (isWithinQuietHours(cursor, window)) return instant;

  // Refine: step forward a minute at a time from the last known-inside point.
  const fine = new Date(lastInside.getTime());
  for (let i = 0; i <= 30; i += 1) {
    fine.setTime(fine.getTime() + 60_000);
    if (!isWithinQuietHours(fine, window)) return fine;
  }
  return cursor;
}

/**
 * A human-readable warning when a scheduled time will not be honoured, or null
 * when it will.
 *
 * Deliberately says what WILL happen rather than what went wrong. The caller
 * has not made a mistake — they asked for a time the system will not keep, and
 * the useful response is the time it will keep instead.
 */
export function quietHoursDeferralWarning(
  runAt: Date,
  window: QuietHoursWindow
): { deferredTo: string; message: string } | null {
  if (!isWithinQuietHours(runAt, window)) return null;

  const deferred = effectiveDeliveryTime(runAt, window);
  const zone = window.timezone || 'UTC';
  const asked = localTimeOfDay(runAt, zone);
  const actual = localTimeOfDay(deferred, zone);

  return {
    deferredTo: deferred.toISOString(),
    message:
      `This falls inside quiet hours (${window.start}–${window.end} ${zone}), so it will NOT be delivered at ${asked}. ` +
      `It will be held and delivered at about ${actual} ${zone}, on the first scheduler tick after the window ends. ` +
      `Scheduling it earlier does not help — a held reminder releases when quiet hours end, whatever time it was set for. ` +
      `If it has a hard deadline, schedule it after ${window.end} ${zone}.`,
  };
}
