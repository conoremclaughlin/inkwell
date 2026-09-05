/**
 * endDate was exclusive, so every range silently dropped its final day.
 *
 * Google's `timeMax` is exclusive and `endDate` resolved to midnight at the
 * START of that day. Filed for eleven days as "same-day queries return empty",
 * because "what's on today" is the query made most often and that is where the
 * bug gets met — but same-day is only the degenerate case where a half-open
 * window has zero width.
 *
 * It cost Conor two Spravato appointments — Mon 14 and Wed 16 September —
 * invisible from 25 August to 4 September, and a false story built on their
 * absence (Myra, 2026-09-04).
 *
 * Her warning shapes these tests: a same-day-only regression test would pass
 * against a fix that shifts the window by a day without making it inclusive.
 * The test has to be a multi-day range with the event on the FINAL day.
 */

import { describe, it, expect } from 'vitest';
import { calendarWindow, inclusiveEndToRfc3339 } from './service';

const LA = 'America/Los_Angeles';

describe('calendarWindow', () => {
  /**
   * THE REGRESSION. Conor's actual case: a range covering both appointments,
   * with one of them on the last day.
   */
  it('includes the whole final day of a multi-day range', () => {
    const { timeMin, timeMax } = calendarWindow('2026-09-14', '2026-09-16', LA);

    expect(timeMin).toBe('2026-09-14T00:00:00-07:00');
    // The 17th, so anything at any hour on the 16th falls inside.
    expect(timeMax).toBe('2026-09-17T00:00:00-07:00');
    expect(Date.parse('2026-09-16T14:30:00-07:00')).toBeLessThan(Date.parse(timeMax));
  });

  /**
   * The asymmetry, pinned. A fix that advanced BOTH bounds would pass a
   * same-day test and drop the first day instead — trading one silent
   * truncation for another.
   */
  it('advances only the end, never the start', () => {
    const { timeMin, timeMax } = calendarWindow('2026-09-14', '2026-09-14', LA);

    expect(timeMin).toBe('2026-09-14T00:00:00-07:00');
    expect(timeMax).toBe('2026-09-15T00:00:00-07:00');
    // Same-day is now a full day wide, not zero.
    expect(Date.parse(timeMax) - Date.parse(timeMin)).toBe(24 * 60 * 60 * 1000);
  });

  it('covers an event at the very end of the last day', () => {
    const { timeMax } = calendarWindow('2026-09-14', '2026-09-14', LA);
    expect(Date.parse('2026-09-14T23:59:00-07:00')).toBeLessThan(Date.parse(timeMax));
  });
});

describe('inclusiveEndToRfc3339', () => {
  /**
   * These pin the OFFSET the boundary lands on, not the arithmetic that got
   * there. I originally wrote that they proved advancing the calendar day
   * beats adding 24 hours; mutating one into the other broke nothing, because
   * the arithmetic runs in UTC where a day is always 24 hours. The DST
   * correctness lives in bareDateToRfc3339 resolving the bare date for that
   * day, which is what these actually guard.
   */
  it('lands on PST after the November fall-back', () => {
    expect(inclusiveEndToRfc3339('2026-11-01', LA)).toBe('2026-11-02T00:00:00-08:00');
  });

  it('lands on PDT after the March spring-forward', () => {
    // 8 Mar 2026 is 23 hours long in LA.
    expect(inclusiveEndToRfc3339('2026-03-08', LA)).toBe('2026-03-09T00:00:00-07:00');
  });

  it.each([
    ['month end', '2026-09-30', '2026-10-01'],
    ['year end', '2026-12-31', '2027-01-01'],
    ['leap day', '2028-02-29', '2028-03-01'],
    ['day before leap day', '2028-02-28', '2028-02-29'],
  ])('rolls over a %s', (_label, end, expectedDay) => {
    expect(inclusiveEndToRfc3339(end, 'UTC')).toBe(`${expectedDay}T00:00:00+00:00`);
  });

  /**
   * A full timestamp means that instant. Extending it would be a second defect
   * in the opposite direction.
   */
  it('passes a full timestamp through untouched', () => {
    const exact = '2026-09-16T17:00:00Z';
    expect(inclusiveEndToRfc3339(exact, LA)).toBe(exact);
  });
});
