/**
 * endDate was exclusive, so every range silently dropped its final day.
 *
 * Google's `timeMax` is exclusive and `endDate` resolved to midnight at the
 * START of that day. Filed for eleven days as "same-day queries return empty",
 * because "what's on today" is the query made most often and that is where the
 * bug gets met — but same-day is only the degenerate case where a half-open
 * window has zero width.
 *
 * The expensive version is a recurring appointment landing on the last day of
 * a queried range: it stays invisible for as long as nobody widens the window,
 * and a false story gets built on the absence (reported by Myra, 2026-09-04).
 *
 * Her warning shapes these tests: a same-day-only regression test would pass
 * against a fix that shifts the window by a day without making it inclusive.
 * The test has to be a multi-day range with the event on the FINAL day.
 */

import { describe, it, expect } from 'vitest';
import { calendarWindow, inclusiveEndToRfc3339 } from './service';

const LA = 'America/Los_Angeles';
const BERLIN = 'Europe/Berlin';

/**
 * Run `body` as though the server were sitting in `hostZone`.
 *
 * Assigning `process.env.TZ` resets Node's cached zone, so this genuinely
 * changes what `new Date('...T00:00:00')` means — which is the whole point:
 * the conversion must not depend on it.
 */
function withHostZone(hostZone: string, body: () => void): void {
  const original = process.env.TZ;
  process.env.TZ = hostZone;
  try {
    body();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

describe('calendarWindow', () => {
  /**
   * THE REGRESSION. The reported shape: a multi-day range with an event on
   * the last day of it.
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

/**
 * The boundary must be midnight in the REQUESTED zone, whatever zone the server
 * runs in. The old conversion sampled host-local midnight and then read the
 * requested zone's offset at that unrelated instant (found by Lumen in review).
 *
 * These tests pin the host zone explicitly, and that is load-bearing rather
 * than tidiness. CI runs in UTC, where the two Berlin cases below BOTH return
 * the right answer from the broken code — a Berlin test that inherited the
 * host zone would have been incapable of failing. The defect only appears when
 * host and requested zone disagree about which side of a transition the sampled
 * instant falls on, so the test has to create that disagreement.
 */
describe('resolving midnight independently of the host timezone', () => {
  /**
   * Berlin springs forward at 02:00 on 2026-03-29, so its midnight is still
   * +01:00. Under an LA host the old code sampled 07:00 UTC — 09:00 in Berlin,
   * past the transition — and answered +02:00, cutting the last hour off the
   * 28th.
   */
  it('uses the pre-transition offset at a spring-forward midnight', () => {
    withHostZone(LA, () => {
      expect(inclusiveEndToRfc3339('2026-03-28', BERLIN)).toBe('2026-03-29T00:00:00+01:00');
    });
  });

  /**
   * Berlin falls back at 03:00 on 2026-10-25, so its midnight is still +02:00.
   * The old code answered +01:00 — an instant one hour LATE, which quietly
   * pulled the next day's first hour into the range.
   */
  it('uses the pre-transition offset at a fall-back midnight', () => {
    withHostZone(LA, () => {
      expect(inclusiveEndToRfc3339('2026-10-24', BERLIN)).toBe('2026-10-25T00:00:00+02:00');
    });
  });

  /**
   * The property itself: the answer is a fact about the requested zone, so no
   * host zone may change it. Kiritimati (+14) and Niue (-11) sit at the far
   * ends of the offset range, either side of the date line from Berlin.
   */
  it.each([LA, 'UTC', BERLIN, 'Pacific/Kiritimati', 'Pacific/Niue', 'Asia/Kolkata'])(
    'gives the same answer with the host in %s',
    (hostZone) => {
      withHostZone(hostZone, () => {
        expect(calendarWindow('2026-03-28', '2026-03-28', BERLIN)).toEqual({
          timeMin: '2026-03-28T00:00:00+01:00',
          timeMax: '2026-03-29T00:00:00+01:00',
        });
      });
    }
  );

  /**
   * These reach the SECOND offset reading, and nothing else here does.
   *
   * The conversion seeds itself with the offset at the date's UTC midnight and
   * then re-reads it at the instant that seed implies. For Berlin the seed is
   * already right, so every test above stayed green when I mutated the
   * correction away — the guard at the centre of this fix was unasserted.
   *
   * It only bites where the zone is far enough east that UTC midnight lands
   * across a transition from local midnight. Auckland shifts at 02:00/03:00
   * local, so its midnight is unambiguous, and the seed is wrong by an hour in
   * both directions: +13:00 for the day DST begins, +12:00 for the day it ends.
   */
  it.each([
    [
      'the day DST begins in Auckland',
      '2026-09-26',
      'Pacific/Auckland',
      '2026-09-27T00:00:00+12:00',
    ],
    ['the day DST ends in Auckland', '2026-04-04', 'Pacific/Auckland', '2026-04-05T00:00:00+13:00'],
    ['the day DST ends in Sydney', '2026-10-03', 'Australia/Sydney', '2026-10-04T00:00:00+10:00'],
    [
      'a 45-minute offset at a transition',
      '2026-09-26',
      'Pacific/Chatham',
      '2026-09-27T00:00:00+12:45',
    ],
  ])('corrects a seed that straddles %s', (_label, end, zone, expected) => {
    withHostZone(LA, () => {
      expect(inclusiveEndToRfc3339(end, zone)).toBe(expected);
    });
  });

  /**
   * A whole-hour offset would hide a sign/padding error in the formatter.
   * Kolkata is +05:30 and Chatham is +12:45.
   */
  it.each([
    ['Asia/Kolkata', '+05:30'],
    ['Pacific/Chatham', '+12:45'],
    ['Pacific/Marquesas', '-09:30'],
  ])('formats the half-hour offset of %s', (zone, offset) => {
    withHostZone(LA, () => {
      expect(inclusiveEndToRfc3339('2026-06-14', zone)).toBe(`2026-06-15T00:00:00${offset}`);
    });
  });
});

/**
 * An impossible date must be refused, not quietly turned into a real one.
 *
 * `Date` normalizes February 31 to March 3, so advancing the end by a day used
 * to convert a bad input into a well-formed query over unintended days. Before
 * this PR the malformed string survived to Google, which rejected it; the
 * inclusive-end arithmetic is what made it plausible (found by Lumen in review).
 */
describe('rejecting impossible calendar dates', () => {
  it.each([
    ['a day past the end of February', '2026-02-31'],
    ['February 29 in a non-leap year', '2026-02-29'],
    ['a 31st in a 30-day month', '2026-09-31'],
    ['a 13th month', '2026-13-01'],
    ['a zeroth day', '2026-09-00'],
  ])('refuses %s', (_label, bad) => {
    expect(() => inclusiveEndToRfc3339(bad, 'UTC')).toThrow(/not a real calendar date/);
    expect(() => calendarWindow(bad, '2026-09-16', 'UTC')).toThrow(/not a real calendar date/);
  });

  it('names the field that was wrong', () => {
    expect(() => calendarWindow('2026-02-31', '2026-09-16', 'UTC')).toThrow(/startDate/);
    expect(() => calendarWindow('2026-09-16', '2026-02-31', 'UTC')).toThrow(/endDate/);
  });

  /**
   * The leap-day cases the validator must NOT reject — a rule tightened one
   * step too far would break real queries, and February 29 is where that shows.
   */
  it.each([
    ['2028-02-29', '2028-03-01'],
    ['2000-02-29', '2000-03-01'],
  ])('still accepts the real leap day %s', (end, expectedDay) => {
    expect(inclusiveEndToRfc3339(end, 'UTC')).toBe(`${expectedDay}T00:00:00+00:00`);
  });

  it('leaves a full timestamp alone even when its date is impossible', () => {
    // Not our shape to police: it fails the bare-date test and goes to Google
    // exactly as the caller wrote it, which is the pre-existing contract.
    const exact = '2026-02-31T17:00:00Z';
    expect(inclusiveEndToRfc3339(exact, 'UTC')).toBe(exact);
  });
});
