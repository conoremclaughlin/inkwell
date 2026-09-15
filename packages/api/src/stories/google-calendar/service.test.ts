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
import { calendarWindow, inclusiveEndToRfc3339, parseLongOffsetSeconds } from './service';

const LA = 'America/Los_Angeles';
const BERLIN = 'Europe/Berlin';

/**
 * An independent oracle: the earliest instant whose civil date in `zone` is
 * `date`, found by scanning forward a second at a time.
 *
 * Deliberately NOT the algorithm under test. That one reasons about offsets and
 * which of them are self-consistent; this one only ever asks "what day is it
 * there now", so a shared misconception about offsets cannot make both agree.
 * ±20h brackets the whole -12:00..+14:00 offset range.
 *
 * It scans by the SECOND. An earlier version scanned by the minute and said, in
 * this comment, that minute granularity was exact "because every tzdb
 * transition falls on a whole minute". That is false — Monrovia's 1972
 * transition lands at :30 — and the sentence was doing real damage, because an
 * oracle that cannot see a boundary is an oracle that reports agreement there
 * (found by Lumen in review). A coarse scale asserted as exact is worse than a
 * coarse scale, because it stops anyone looking.
 */
function startOfCivilDay(date: string, zone: string): number {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const wallClock = Date.parse(`${date}T00:00:00Z`);
  for (let t = wallClock - 20 * 3_600_000; t <= wallClock + 20 * 3_600_000; t += 1_000) {
    if (format.format(new Date(t)) === date) return t;
  }
  throw new Error(`no instant in ${zone} falls on ${date}`);
}

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
   * These are the cases where the two offsets bracketing the day DISAGREE, and
   * nothing else in this describe reaches that.
   *
   * The resolver reads the offset a day either side of the wall clock and keeps
   * only the candidate instants that are self-consistent. When both readings
   * agree there is one candidate and the filter is inert — which is every test
   * above. Here they differ, so the filter is what discards the wrong one, and
   * a mutation that accepts both takes the earlier and answers an hour early.
   *
   * Auckland shifts at 02:00/03:00 local, so its midnight is unambiguous; what
   * makes it a probe is being far enough east that UTC midnight sits across a
   * transition from local midnight, in both directions — +13:00 for the day DST
   * begins, +12:00 for the day it ends.
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
 * Midnight is not guaranteed to exist, and not guaranteed to happen once.
 *
 * The previous fix resolved an OFFSET and pasted it onto `T00:00:00`, which
 * assumes a `00:00:00` the zone may not have. In a zone whose DST transition is
 * AT midnight, it either doesn't exist (the clock jumps 23:59:59 → 01:00) or it
 * happens twice an hour apart. Pasting an offset onto an absent midnight names
 * an instant on the previous day; pasting one onto a repeated midnight picks
 * arbitrarily between them (found by Lumen in review).
 *
 * The expectations here are derived from `Intl` by a different route than the
 * implementation takes — see `startOfCivilDay` — rather than hand-computed, so
 * they cannot encode the same reasoning twice.
 */
describe('civil days whose midnight is missing or repeated', () => {
  /**
   * GAPS. The day after each of these dates has no midnight, so the window
   * around the date itself must end at the instant the clock jumps — an hour
   * later than the offset-pasting version answered, which cut off the last
   * hour of the day being asked for.
   *
   * Santiago and Havana are Lumen's; São Paulo and Asunción came out of a sweep
   * of 25 zones against the oracle, which found the old code wrong on 37 days
   * in 8 zones rather than the 3 the review named.
   */
  it.each([
    ['America/Santiago', '2026-09-05', '2026-09-06T01:00:00-03:00'],
    ['America/Havana', '2026-03-07', '2026-03-08T01:00:00-04:00'],
    ['America/Sao_Paulo', '2018-11-03', '2018-11-04T01:00:00-02:00'],
    ['America/Asuncion', '2018-10-06', '2018-10-07T01:00:00-03:00'],
  ])('keeps the last hour of %s %s, whose next midnight never happens', (zone, end, expected) => {
    withHostZone(LA, () => {
      const timeMax = inclusiveEndToRfc3339(end, zone);
      expect(timeMax).toBe(expected);
      // The boundary is the true start of the following day, independently found.
      const nextDay = new Date(Date.parse(`${end}T00:00:00Z`) + 86_400_000)
        .toISOString()
        .slice(0, 10);
      expect(Date.parse(timeMax)).toBe(startOfCivilDay(nextDay, zone));
    });
  });

  /**
   * The consequence, stated as the thing a user would notice: an appointment in
   * the final hour before a missing midnight. The old boundary landed an hour
   * early and this event fell outside it — the original defect of this PR,
   * reintroduced in a zone rather than a range.
   */
  it('finds an event in the last hour before a missing midnight', () => {
    withHostZone(LA, () => {
      const { timeMax } = calendarWindow('2026-09-05', '2026-09-05', 'America/Santiago');
      expect(Date.parse('2026-09-05T23:30:00-04:00')).toBeLessThan(Date.parse(timeMax));
    });
  });

  /**
   * The same missing midnight as a START bound, which is the opposite error and
   * a separate code path. A day that begins at 01:00 must not be reported as
   * beginning an hour earlier, or the window swallows the previous evening.
   */
  it('starts a day with no midnight at the instant the clock jumps', () => {
    withHostZone(LA, () => {
      const { timeMin } = calendarWindow('2026-09-06', '2026-09-06', 'America/Santiago');
      expect(timeMin).toBe('2026-09-06T01:00:00-03:00');
      expect(Date.parse('2026-09-05T23:30:00-04:00')).toBeLessThan(Date.parse(timeMin));
    });
  });

  /**
   * A FOLD. Amman fell back at midnight in 2021, so 2021-10-29T00:00 happened
   * at 21:00Z and again at 22:00Z. The day begins at the first; choosing the
   * second admits the hour between them, which belongs to the 29th.
   */
  it('ends at the first of two midnights when the clock falls back through it', () => {
    withHostZone(LA, () => {
      const timeMax = inclusiveEndToRfc3339('2021-10-28', 'Asia/Amman');
      expect(timeMax).toBe('2021-10-29T00:00:00+03:00');
      expect(Date.parse(timeMax)).toBe(Date.parse('2021-10-28T21:00:00Z'));
      // 00:30 on the 29th, in the repeated hour — outside a window ending on the 28th.
      expect(Date.parse('2021-10-28T22:30:00Z')).toBeGreaterThan(Date.parse(timeMax));
    });
  });

  /**
   * THE THIRD SHAPE, and the one no test above reached.
   *
   * A gap leaves no valid candidate and a fold leaves two. This leaves exactly
   * one, and it is the candidate taken from the offset AFTER the transition —
   * so it is the only shape that proves the second bracket is doing work.
   *
   * Chile's DST ends AT midnight: the clock reaches 2026-04-05T00:00 −03:00 and
   * drops straight back to 23:00 on the 4th. The pre-transition candidate names
   * an instant that is still the 4th, so it is discarded, and the day begins an
   * hour later at −04:00. Greenland is the same shape running the other way —
   * the 28th loses its last hour and the 29th starts at midnight −01:00 — where
   * the wrong answer is an hour LATE rather than early.
   *
   * These exist because sampling the second offset at the wall clock instead of
   * a day later survived every other test in this file. Measured against the
   * oracle over all 418 zones Node ships, 1970–2030, on the days around every
   * transition: that mistake is wrong on 906 (zone, date) pairs in 57 zones,
   * and dropping the second bracket entirely is wrong on 14,648 in 265. The
   * guard was load-bearing and simply unasserted.
   */
  it.each([
    ['America/Santiago', '2026-04-04', '2026-04-05T00:00:00-04:00'],
    ['America/Asuncion', '2005-03-12', '2005-03-13T00:00:00-04:00'],
    ['America/Godthab', '2026-03-28', '2026-03-29T00:00:00-01:00'],
  ])('takes the post-transition offset where only it can be right (%s)', (zone, end, expected) => {
    withHostZone(LA, () => {
      const timeMax = inclusiveEndToRfc3339(end, zone);
      expect(timeMax).toBe(expected);
      const nextDay = new Date(Date.parse(`${end}T00:00:00Z`) + 86_400_000)
        .toISOString()
        .slice(0, 10);
      expect(Date.parse(timeMax)).toBe(startOfCivilDay(nextDay, zone));
    });
  });

  /**
   * The invariant that ties the two bounds together across every shape above:
   * consecutive days must MEET. If a day ends where the next begins, no instant
   * is dropped between two adjacent queries and none is counted twice — and
   * that holds whether midnight is missing, repeated, or ordinary.
   *
   * This is the check that generalizes. The cases above pin specific instants;
   * this one would fail for any zone and date where the two bounds disagree,
   * including ones nobody thought to enumerate.
   */
  it.each([
    ['America/Santiago', '2026-09-05'],
    ['America/Havana', '2026-03-07'],
    ['Asia/Amman', '2021-10-28'],
    ['America/Sao_Paulo', '2018-11-03'],
    ['America/Santiago', '2026-04-04'],
    ['America/Godthab', '2026-03-28'],
    ['Pacific/Auckland', '2026-09-26'],
    [LA, '2026-11-01'],
  ])('leaves no gap or overlap between consecutive days in %s', (zone, date) => {
    withHostZone(LA, () => {
      const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000)
        .toISOString()
        .slice(0, 10);
      const { timeMax } = calendarWindow(date, date, zone);
      const { timeMin } = calendarWindow(next, next, zone);
      expect(Date.parse(timeMax)).toBe(Date.parse(timeMin));
      expect(Date.parse(timeMin)).toBe(startOfCivilDay(next, zone));
    });
  });

  /**
   * Still a fact about the requested zone, not the host — the property the
   * previous round established, re-checked on the shapes added since.
   */
  it.each([LA, 'UTC', 'Asia/Amman', 'America/Santiago', 'Pacific/Kiritimati'])(
    'resolves a missing and a repeated midnight identically with the host in %s',
    (hostZone) => {
      withHostZone(hostZone, () => {
        expect(inclusiveEndToRfc3339('2026-09-05', 'America/Santiago')).toBe(
          '2026-09-06T01:00:00-03:00'
        );
        expect(inclusiveEndToRfc3339('2021-10-28', 'Asia/Amman')).toBe('2021-10-29T00:00:00+03:00');
      });
    }
  );
});

/**
 * Zones whose offset is not a whole number of minutes.
 *
 * Before a zone adopted a standard offset it ran on local mean solar time, and
 * `Intl` reports that faithfully: Monrovia was `GMT-00:44:30` until 1972-01-07.
 * The offset parser matched `GMT±HH:MM` only and returned 0 for anything else,
 * so every day in that window resolved to UTC midnight — 44½ minutes early, and
 * rendered as a confident `Z` that gave no sign of being a fallback.
 *
 * Two reasons this is the interesting bug of the three rounds rather than the
 * obscure one:
 *
 *   - The sweep that certified the previous round carried the SAME regex. So
 *     Monrovia's transition was never even detected AS a transition, the day
 *     never entered the population, and the sweep reported zero mismatches over
 *     a range that contains this one. A measurement that shares the code's
 *     misconception measures nothing, and reports a clean number while doing it.
 *   - The oracle in this file asserted, in a comment, that minute granularity
 *     was exact "because every tzdb transition falls on a whole minute". Stating
 *     an assumption as a fact is what stopped it being checked.
 *
 * Both found by Lumen in review. In 1970–2030 exactly one zone is affected —
 * Monrovia, 1970-01-01 to 1972-01-07 — but 276 of the 418 zones Node ships emit
 * a sub-minute offset at some instant, so the parse itself was wrong generally.
 */
describe('zones whose offset is not a whole number of minutes', () => {
  const MONROVIA = 'Africa/Monrovia';

  /**
   * The instants, pinned. Ground truth is `Intl` observation at a pinned
   * instant, not arithmetic on an offset I believe to be in force:
   * 1972-01-07T00:44:29Z is 23:59:59 on the 6th there, and 00:44:30Z is
   * 00:44:30 on the 7th.
   */
  it('starts a day 44½ minutes after UTC midnight, not at it', () => {
    withHostZone(LA, () => {
      const { timeMin, timeMax } = calendarWindow('1972-01-06', '1972-01-06', MONROVIA);
      expect(Date.parse(timeMin)).toBe(Date.parse('1972-01-06T00:44:30Z'));
      expect(Date.parse(timeMax)).toBe(Date.parse('1972-01-07T00:44:30Z'));
    });
  });

  /**
   * The user-visible consequence, and the reason the 44½ minutes matter. The old
   * parser put BOTH bounds 2,670s early — [00:00:00Z, 00:00:00Z) — so the day
   * ended at 23:15:30 local and the last 44½ minutes of the evening fell off it.
   * This 23:30 appointment is the one that went missing: the original defect of
   * this PR once more, now in a third disguise.
   */
  it('finds an event in the last 44½ minutes of a local-mean-time day', () => {
    withHostZone(LA, () => {
      const { timeMin, timeMax } = calendarWindow('1972-01-06', '1972-01-06', MONROVIA);
      const event = Date.parse('1972-01-07T00:14:30Z'); // 23:30 local on the 6th
      expect(event).toBeGreaterThanOrEqual(Date.parse(timeMin));
      expect(event).toBeLessThan(Date.parse(timeMax));
    });
  });

  /**
   * A CONTROL, labelled as one because its first version was not. An early-
   * morning event is inside the window under the old parser and the new alike —
   * 01:04:30Z is already past the old 00:00:00Z start — so it can only show that
   * moving the day forward broke nothing at the other end of it.
   *
   * Its comment used to claim this 00:20 appointment "sat OUTSIDE the day it
   * belongs to", which is false: the assertion passes against 0458ad07. Wrong in
   * the direction that flatters the fix, and the third round running that a test
   * here asserted less than its prose claimed (found by Lumen in review).
   */
  it('still includes an event in the first hour of a local-mean-time day', () => {
    withHostZone(LA, () => {
      const { timeMin, timeMax } = calendarWindow('1972-01-06', '1972-01-06', MONROVIA);
      const event = Date.parse('1972-01-06T01:04:30Z'); // 00:20 local
      expect(event).toBeGreaterThanOrEqual(Date.parse(timeMin));
      expect(event).toBeLessThan(Date.parse(timeMax));
    });
  });

  /**
   * The transition day is a GAP of 44½ minutes — the 7th has no midnight, it
   * begins at 00:44:30 local. The same shape as Santiago above, at a scale no
   * whole-minute reasoning can express.
   */
  it('starts the transition day at the jump, where midnight never happens', () => {
    withHostZone(LA, () => {
      const { timeMin } = calendarWindow('1972-01-07', '1972-01-07', MONROVIA);
      expect(Date.parse(timeMin)).toBe(Date.parse('1972-01-07T00:44:30Z'));
      // 23:59:59 on the 6th, one second before the jump, is not part of the 7th.
      expect(Date.parse('1972-01-07T00:44:29Z')).toBeLessThan(Date.parse(timeMin));
    });
  });

  /**
   * RFC 3339 has no seconds field in its offset, so a `-00:44:30` day has no
   * legal local rendering — and rounding the offset would name a different
   * instant than the one being rendered. UTC is the exact answer.
   *
   * The assertion that matters is the round trip, not the spelling: parsing the
   * output must recover the instant exactly. Writing `-00:44` with a 00:00:00
   * wall clock would look plausible and be 30 seconds wrong.
   */
  it('renders an unrepresentable offset in UTC rather than rounding it', () => {
    withHostZone(LA, () => {
      const { timeMin } = calendarWindow('1972-01-06', '1972-01-06', MONROVIA);
      expect(timeMin).toBe('1972-01-06T00:44:30Z');
      expect(Date.parse(timeMin)).toBe(startOfCivilDay('1972-01-06', MONROVIA));
    });
  });

  /**
   * The control for the case above, and the one that stops "render in UTC"
   * spreading. A zone IS representable at :30 and :45 minutes past the hour,
   * and those must still render locally — otherwise every half-hour zone in the
   * world starts answering in UTC and the local rendering that makes a missing
   * midnight visible is gone.
   */
  it.each([
    ['Asia/Kolkata', '2026-06-15', '2026-06-16T00:00:00+05:30'],
    ['Asia/Kathmandu', '2026-06-15', '2026-06-16T00:00:00+05:45'],
    ['Australia/Eucla', '2026-06-15', '2026-06-16T00:00:00+08:45'],
  ])('still renders %s locally, since its offset is a whole minute', (zone, end, expected) => {
    withHostZone(LA, () => {
      expect(inclusiveEndToRfc3339(end, zone)).toBe(expected);
    });
  });

  /**
   * Once the sub-minute offset is gone the zone is ordinary again, so the
   * fallback must not stick: the 8th is a plain UTC day and renders `+00:00`.
   * This kills a fix that keys UTC rendering off the zone rather than off the
   * offset in force at the instant.
   */
  it('goes back to a local rendering once the zone adopts a whole offset', () => {
    withHostZone(LA, () => {
      const { timeMin } = calendarWindow('1972-01-08', '1972-01-08', MONROVIA);
      expect(timeMin).toBe('1972-01-08T00:00:00+00:00');
    });
  });

  /**
   * Consecutive days must MEET across the transition too — the invariant that
   * generalizes, applied to the shape the previous round could not see.
   */
  it.each([
    ['1970-06-15', '1970-06-16'],
    ['1972-01-05', '1972-01-06'],
    ['1972-01-06', '1972-01-07'],
    ['1972-01-07', '1972-01-08'],
  ])('leaves no gap or overlap between %s and %s in Monrovia', (date, next) => {
    withHostZone(LA, () => {
      const { timeMax } = calendarWindow(date, date, MONROVIA);
      const { timeMin } = calendarWindow(next, next, MONROVIA);
      expect(Date.parse(timeMax)).toBe(Date.parse(timeMin));
      expect(Date.parse(timeMin)).toBe(startOfCivilDay(next, MONROVIA));
    });
  });

  /**
   * A fact about the requested zone, not the host — re-checked on this shape.
   */
  it.each([LA, 'UTC', 'Africa/Monrovia', 'Pacific/Kiritimati'])(
    'resolves a sub-minute offset identically with the host in %s',
    (hostZone) => {
      withHostZone(hostZone, () => {
        expect(calendarWindow('1972-01-06', '1972-01-06', MONROVIA).timeMin).toBe(
          '1972-01-06T00:44:30Z'
        );
      });
    }
  );
});

/**
 * The offset parser, asserted directly on the strings it parses.
 *
 * Exported for exactly this reason: through `Intl` the refusal branch is
 * unreachable — no zone Node ships produces a shape it rejects — so a test
 * going the long way round could only ever assert the shapes that DO parse, and
 * the guard would sit there unasserted. That is the trap the previous rounds
 * kept falling into: the mechanism that matters covered by nothing, while the
 * suite looks complete.
 */
describe('parsing an Intl longOffset', () => {
  it.each([
    ['GMT', 0],
    ['GMT+00:00', 0],
    ['GMT-07:00', -7 * 3600],
    ['GMT+05:30', 5 * 3600 + 30 * 60],
    ['GMT+05:45', 5 * 3600 + 45 * 60],
    ['GMT-00:44:30', -(44 * 60 + 30)],
    ['GMT+02:27:16', 2 * 3600 + 27 * 60 + 16],
    ['GMT-12:00', -12 * 3600],
    ['GMT+14:00', 14 * 3600],
  ])('reads %s as %i seconds east of UTC', (raw, expected) => {
    expect(parseLongOffsetSeconds(raw, 'Africa/Monrovia')).toBe(expected);
  });

  /**
   * The guard itself. Zero is a REAL offset, so returning it for "I could not
   * read this" makes an unreadable zone indistinguishable from London in
   * January — which is precisely how a 44½-minute error spent a round rendered
   * as a confident `Z`. Refusing is the only answer that cannot be mistaken for
   * an answer.
   */
  it.each([['GMT+7'], ['GMT-07'], ['UTC-07:00'], ['GMT+07:00:00:00'], [''], ['GMT+aa:bb']])(
    'refuses %s rather than defaulting to zero',
    (raw) => {
      expect(() => parseLongOffsetSeconds(raw, 'Africa/Monrovia')).toThrow(
        /cannot read the UTC offset/
      );
    }
  );

  it('names the timezone it could not read', () => {
    expect(() => parseLongOffsetSeconds('GMT+7', 'Mars/Olympus_Mons')).toThrow(
      /Mars\/Olympus_Mons/
    );
  });

  /**
   * The control: the parser covers reality. Every zone Node ships, sampled
   * across the range this file is asked about, must parse — otherwise the throw
   * above stops being a guard and starts being an outage.
   */
  it('parses every offset every zone Node ships actually emits', () => {
    const zones = Intl.supportedValuesOf('timeZone');
    let sampled = 0;
    let subMinute = 0;
    for (const zone of zones) {
      const format = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        timeZoneName: 'longOffset',
      });
      for (let year = 1970; year <= 2030; year += 5) {
        for (const month of [0, 6]) {
          const raw =
            format
              .formatToParts(new Date(Date.UTC(year, month, 15)))
              .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
          const seconds = parseLongOffsetSeconds(raw, zone);
          sampled += 1;
          if (seconds % 60 !== 0) subMinute += 1;
        }
      }
    }
    expect(sampled).toBeGreaterThan(10_000);
    // And the sample genuinely contains the shape under test, so a regex that
    // dropped the seconds group could not pass this by parsing nothing awkward.
    expect(subMinute).toBeGreaterThan(0);
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
