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
export function localTimeOfDay(instant: Date, timezone?: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(instant);
  } catch {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(instant);
  }
}

/**
 * Is this instant inside the user's quiet window?
 *
 * Overnight windows (start > end, e.g. 22:00–08:00) wrap midnight, which is the
 * normal case and the one every real config here uses.
 */
export function isWithinQuietHours(instant: Date, window: QuietHoursWindow): boolean {
  const start = (window.start || '').trim();
  const end = (window.end || '').trim();
  if (!start || !end) return false;

  const now = localTimeOfDay(instant, window.timezone);
  // Equal bounds would otherwise mean "always quiet" via the wrap branch, which
  // silently mutes every reminder forever. Read it as "no quiet hours".
  if (start === end) return false;
  if (start > end) return now >= start || now < end;
  return now >= start && now < end;
}

/**
 * When a reminder due at `instant` would ACTUALLY be delivered.
 *
 * Returns the instant itself when it falls outside quiet hours. Otherwise the
 * next occurrence of the window's end — the moment the scheduler stops skipping
 * it. Callers use this to tell a human what they are really scheduling.
 *
 * Minute-accurate rather than tick-accurate: delivery lands on the first
 * scheduler tick at or after the boundary, so the real arrival is this value
 * plus up to one tick interval.
 */
export function effectiveDeliveryTime(instant: Date, window: QuietHoursWindow): Date {
  if (!isWithinQuietHours(instant, window)) return instant;

  const end = (window.end || '').trim();
  const [endHour, endMinute] = end.split(':').map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(endHour) || !Number.isFinite(endMinute)) return instant;

  // Walk forward a minute at a time from the due instant to the first minute
  // outside the window. Bounded by 25 hours: a window can span at most a day,
  // and the bound means a malformed config can never spin.
  const cursor = new Date(instant.getTime());
  for (let i = 0; i < 25 * 60; i += 1) {
    cursor.setTime(cursor.getTime() + 60_000);
    if (!isWithinQuietHours(cursor, window)) return cursor;
  }
  return instant;
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
