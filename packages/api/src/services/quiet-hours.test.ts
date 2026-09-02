/**
 * Quiet hours: the deferral that looked like lag.
 *
 * Conor's Spravato fasting prep was scheduled 07:30 against a 09:00 deadline
 * and delivered at 08:06 (2026-09-02). The scheduler had not fallen behind —
 * it ticked every five minutes and found the reminder due eight consecutive
 * times without delivering, because it was inside quiet hours. Read as lag, it
 * produced the rule "schedule against the lag", which does nothing: a held
 * reminder releases when the window ends whatever time it was set for.
 */

import { describe, expect, it } from 'vitest';
import {
  effectiveDeliveryTime,
  isWithinQuietHours,
  localTimeOfDay,
  quietHoursDeferralWarning,
  timeOfDayToMinutes,
  effectiveTimezone,
} from './quiet-hours';

/** Myra's operating window, and the one that held the reminder. */
const overnight = { start: '22:00', end: '08:00', timezone: 'America/Los_Angeles' };

describe('localTimeOfDay', () => {
  it('reads the wall clock in the USER’s zone, not the process default', () => {
    // 15:30Z is 08:30 in Los Angeles and 17:30 in Berlin. The bug this replaces
    // used the server's own clock and would have answered the same for both.
    const instant = new Date('2026-09-02T15:30:00Z');
    expect(localTimeOfDay(instant, 'America/Los_Angeles')).toBe('08:30');
    expect(localTimeOfDay(instant, 'Europe/Berlin')).toBe('17:30');
    expect(localTimeOfDay(instant, 'UTC')).toBe('15:30');
  });

  it('falls back to UTC on an unusable zone rather than throwing', () => {
    // A scheduler that dies on a bad config string is worse than one that
    // mis-times a window.
    expect(localTimeOfDay(new Date('2026-09-02T15:30:00Z'), 'Not/AZone')).toBe('15:30');
  });
});

describe('isWithinQuietHours', () => {
  it('holds the 07:30 reminder that started all this', () => {
    expect(isWithinQuietHours(new Date('2026-09-02T14:30:00Z'), overnight)).toBe(true);
  });

  it('releases after the window ends', () => {
    // 15:05Z = 08:05 PDT, the tick the reminder actually went out on.
    expect(isWithinQuietHours(new Date('2026-09-02T15:05:00Z'), overnight)).toBe(false);
  });

  it('wraps midnight', () => {
    expect(isWithinQuietHours(new Date('2026-09-02T08:00:00Z'), overnight)).toBe(true); // 01:00
    expect(isWithinQuietHours(new Date('2026-09-02T20:00:00Z'), overnight)).toBe(false); // 13:00
  });

  it('treats a same-day window as a plain range', () => {
    const daytime = { start: '09:00', end: '17:00', timezone: 'UTC' };
    expect(isWithinQuietHours(new Date('2026-09-02T12:00:00Z'), daytime)).toBe(true);
    expect(isWithinQuietHours(new Date('2026-09-02T08:59:00Z'), daytime)).toBe(false);
    expect(isWithinQuietHours(new Date('2026-09-02T17:00:00Z'), daytime)).toBe(false);
  });

  it('is inactive when either bound is missing', () => {
    const t = new Date('2026-09-02T14:30:00Z');
    expect(isWithinQuietHours(t, { start: '22:00', end: null })).toBe(false);
    expect(isWithinQuietHours(t, { start: null, end: '08:00' })).toBe(false);
    expect(isWithinQuietHours(t, {})).toBe(false);
  });

  it('reads equal bounds as no quiet hours, not as always-quiet', () => {
    // Via the wrap branch, 08:00–08:00 would otherwise mute every reminder
    // forever — a config typo that silences the whole system.
    const t = new Date('2026-09-02T14:30:00Z');
    expect(isWithinQuietHours(t, { start: '08:00', end: '08:00', timezone: 'UTC' })).toBe(false);
  });
});

describe('effectiveDeliveryTime', () => {
  it('returns the asked-for time when it is outside the window', () => {
    const t = new Date('2026-09-02T20:00:00Z');
    expect(effectiveDeliveryTime(t, overnight).toISOString()).toBe(t.toISOString());
  });

  it('reports the window boundary for a held reminder', () => {
    const deferred = effectiveDeliveryTime(new Date('2026-09-02T14:30:00Z'), overnight);
    expect(localTimeOfDay(deferred, overnight.timezone)).toBe('08:00');
  });

  /**
   * THE POINT. Three different scheduled times inside the window all deliver at
   * the same moment — which is why "schedule earlier" buys nothing, and why the
   * 90-minute margin on the real reminder was irrelevant rather than sufficient.
   */
  it('gives the same delivery time however early it was scheduled', () => {
    const times = [
      '2026-09-02T14:30:00Z', // 07:30 PDT
      '2026-09-02T13:00:00Z', // 06:00 PDT
      '2026-09-02T12:00:00Z', // 05:00 PDT
    ].map((iso) => effectiveDeliveryTime(new Date(iso), overnight).toISOString());

    expect(new Set(times).size).toBe(1);
  });
});

describe('quietHoursDeferralWarning', () => {
  it('says nothing when the time will be honoured', () => {
    expect(quietHoursDeferralWarning(new Date('2026-09-02T20:00:00Z'), overnight)).toBeNull();
  });

  it('names the asked-for time, the real one, and the rule that actually works', () => {
    const warning = quietHoursDeferralWarning(new Date('2026-09-02T14:30:00Z'), overnight);

    expect(warning).not.toBeNull();
    expect(warning!.message).toContain('07:30');
    expect(warning!.message).toContain('08:00');
    // The correction Myra retracted her own rule for — stated where the next
    // caller will read it, not left in a thread.
    expect(warning!.message).toContain('Scheduling it earlier does not help');
    expect(warning!.deferredTo).toBe(
      effectiveDeliveryTime(new Date('2026-09-02T14:30:00Z'), overnight).toISOString()
    );
  });

  it('is silent when no quiet hours are configured', () => {
    expect(quietHoursDeferralWarning(new Date('2026-09-02T14:30:00Z'), {})).toBeNull();
  });
});

/**
 * The shape the DATABASE actually returns (Lumen, PR #568 P1).
 *
 * `heartbeat_state.quiet_start/quiet_end` are Postgres `time`, serialized as
 * `HH:MM:SS`. The wall clock is `HH:MM`. Compared as strings,
 * `'08:00' < '08:00:00'` is TRUE — a shorter string is a prefix and therefore
 * lesser — so the window stayed shut one extra minute and the warning reported
 * an 08:01 boundary for an 08:00 window.
 *
 * Which is the same defect this PR repairs: two representations of a time,
 * compared as if they were one. Fixed by comparing numbers instead, so the
 * category cannot recur.
 */
describe('the real database time shape', () => {
  const dbShape = { start: '22:00:00', end: '08:00:00', timezone: 'America/Los_Angeles' };

  it('parses both shapes to the same minute', () => {
    expect(timeOfDayToMinutes('08:00')).toBe(480);
    expect(timeOfDayToMinutes('08:00:00')).toBe(480);
    expect(timeOfDayToMinutes('08:00:59')).toBe(480);
    expect(timeOfDayToMinutes('22:30:00')).toBe(1350);
  });

  it.each([
    ['', 'empty'],
    ['8am', 'prose'],
    ['25:00', 'hour out of range'],
    ['08:99', 'minute out of range'],
    [null, 'null'],
  ])('rejects %s (%s)', (value) => {
    expect(timeOfDayToMinutes(value as string | null)).toBeNull();
  });

  it('releases exactly AT the boundary, not a minute after', () => {
    // 15:00Z = 08:00 PDT. The string comparison held this shut until 08:01.
    expect(isWithinQuietHours(new Date('2026-09-02T15:00:00Z'), dbShape)).toBe(false);
    expect(isWithinQuietHours(new Date('2026-09-02T14:59:00Z'), dbShape)).toBe(true);
  });

  it('reports the boundary the operator configured, to the minute', () => {
    const warning = quietHoursDeferralWarning(new Date('2026-09-02T14:30:00Z'), dbShape);
    // Was 15:01Z on the reviewed head, against the real row shape.
    expect(warning!.deferredTo).toBe('2026-09-02T15:00:00.000Z');
  });

  it('behaves identically whichever shape the column returns', () => {
    const withSeconds = { start: '22:00:00', end: '08:00:00', timezone: 'UTC' };
    const without = { start: '22:00', end: '08:00', timezone: 'UTC' };
    for (const iso of ['2026-09-02T07:59:00Z', '2026-09-02T08:00:00Z', '2026-09-02T22:00:00Z']) {
      const t = new Date(iso);
      expect(isWithinQuietHours(t, withSeconds), iso).toBe(isWithinQuietHours(t, without));
    }
  });

  it('still reads equal bounds as no quiet hours in the DB shape', () => {
    expect(
      isWithinQuietHours(new Date('2026-09-02T14:30:00Z'), {
        start: '08:00:00',
        end: '08:00:00',
        timezone: 'UTC',
      })
    ).toBe(false);
  });
});

/**
 * DST fall-back (Lumen, PR #568 round 2).
 *
 * I replaced the minute walk with 30-minute strides to cut Intl calls. Across a
 * fall-back the pointwise predicate can go false and then TRUE again inside one
 * stride, so a coarse sample lands back inside the window and the walk sails
 * past the real boundary.
 *
 * The optimization was also unnecessary — caching the formatter is what cost
 * the time, not the number of steps.
 */
describe('DST fall-back', () => {
  // Lumen's exact repro. LA falls back 2026-11-01: 01:00–02:00 PDT happens,
  // then 01:00–02:00 PST happens again.
  const window = { start: '22:00', end: '01:45', timezone: 'America/Los_Angeles' };

  it('returns the FIRST boundary, not the one after the clocks go back', () => {
    // Due 01:30 PDT. The window ends at 01:45 PDT = 08:45Z. The coarse walk
    // sampled 09:00Z — 01:00 PST, quiet again — and ran on to 09:45Z.
    const deferred = effectiveDeliveryTime(new Date('2026-11-01T08:30:00Z'), window);
    expect(deferred.toISOString()).toBe('2026-11-01T08:45:00.000Z');
  });

  it('agrees with the predicate at the boundary it returns', () => {
    // The property that makes a walk trustworthy: the minute before is inside,
    // the minute returned is outside. A skipped boundary breaks this.
    const deferred = effectiveDeliveryTime(new Date('2026-11-01T08:30:00Z'), window);
    const before = new Date(deferred.getTime() - 60_000);
    expect(isWithinQuietHours(before, window)).toBe(true);
    expect(isWithinQuietHours(deferred, window)).toBe(false);
  });

  it('still finds a boundary across the repeated hour when due before it', () => {
    // Due 23:00 PDT, well before the fall-back. Same first boundary.
    const deferred = effectiveDeliveryTime(new Date('2026-11-01T06:00:00Z'), window);
    expect(deferred.toISOString()).toBe('2026-11-01T08:45:00.000Z');
  });
});

/**
 * An invalid zone must not be reported as if it were used (Lumen, P2).
 *
 * set_quiet_hours accepts any string. The formatter silently fell back to UTC
 * while the warning labelled the message with the zone the user typed — a
 * warning misreporting its own basis, which is the failure this PR is about.
 * The cache also grew without bound on arbitrary input.
 */
describe('effectiveTimezone', () => {
  it('passes through a usable zone', () => {
    expect(effectiveTimezone('America/Los_Angeles')).toBe('America/Los_Angeles');
    expect(effectiveTimezone('Europe/Berlin')).toBe('Europe/Berlin');
  });

  it('falls back to UTC for an unusable one', () => {
    expect(effectiveTimezone('Not/AZone')).toBe('UTC');
    expect(effectiveTimezone('')).toBe('UTC');
    expect(effectiveTimezone(null)).toBe('UTC');
  });

  it('labels the warning with the zone actually used, not the one typed', () => {
    const warning = quietHoursDeferralWarning(new Date('2026-09-02T23:30:00Z'), {
      start: '22:00',
      end: '08:00',
      timezone: 'Not/AZone',
    });

    expect(warning).not.toBeNull();
    expect(warning!.message).toContain('UTC');
    expect(warning!.message).not.toContain('Not/AZone');
  });
});
