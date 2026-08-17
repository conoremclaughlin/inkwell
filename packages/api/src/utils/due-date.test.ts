import { describe, it, expect, vi } from 'vitest';
import { resolveDueDate } from './due-date';

vi.mock('./logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const LA = 'America/Los_Angeles';
const TOKYO = 'Asia/Tokyo';

/** The calendar date a stored instant reads as, in a given zone. */
function localDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

function expectOk(result: ReturnType<typeof resolveDueDate>): string | null {
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result.value;
}

describe('resolveDueDate', () => {
  describe('date-only input', () => {
    it('anchors to the end of the day in the user timezone', () => {
      // 2026-09-14 23:59:59.999 PDT (UTC-7) === 2026-09-15T06:59:59.999Z
      expect(expectOk(resolveDueDate('2026-09-14', LA))).toBe('2026-09-15T06:59:59.999Z');
    });

    it('reads back as the requested calendar date in the user timezone', () => {
      // The whole point: a deadline must never appear to be a different day than
      // the one the caller asked for. Start-of-day UTC would fail this for LA.
      for (const zone of [LA, TOKYO, 'UTC', 'Europe/London', 'Pacific/Kiritimati']) {
        const stored = expectOk(resolveDueDate('2026-09-14', zone))!;
        expect(localDate(stored, zone)).toBe('2026-09-14');
      }
    });

    it('would have read back as the previous day under start-of-day UTC', () => {
      // Guards the decision, not just the code: pins why end-of-day was chosen.
      expect(localDate('2026-09-14T00:00:00.000Z', LA)).toBe('2026-09-13');
      expect(localDate(expectOk(resolveDueDate('2026-09-14', LA))!, LA)).toBe('2026-09-14');
    });

    it('defaults to UTC when no timezone is known', () => {
      expect(expectOk(resolveDueDate('2026-09-14', undefined))).toBe('2026-09-14T23:59:59.999Z');
      expect(expectOk(resolveDueDate('2026-09-14', null))).toBe('2026-09-14T23:59:59.999Z');
    });

    it('falls back to UTC for an unrecognized timezone instead of failing the write', () => {
      expect(expectOk(resolveDueDate('2026-09-14', 'Mars/Olympus_Mons'))).toBe(
        '2026-09-14T23:59:59.999Z'
      );
    });

    it('applies the offset in effect on that date, not today', () => {
      // PST (UTC-8) in January, PDT (UTC-7) in September.
      expect(expectOk(resolveDueDate('2026-01-14', LA))).toBe('2026-01-15T07:59:59.999Z');
      expect(expectOk(resolveDueDate('2026-09-14', LA))).toBe('2026-09-15T06:59:59.999Z');
    });

    it('handles a spring-forward DST date', () => {
      // 2026-03-08 is the US spring-forward day; end-of-day is already PDT.
      const stored = expectOk(resolveDueDate('2026-03-08', LA))!;
      expect(stored).toBe('2026-03-09T06:59:59.999Z');
      expect(localDate(stored, LA)).toBe('2026-03-08');
    });

    it('handles a zone ahead of UTC', () => {
      // JST is UTC+9 year-round.
      expect(expectOk(resolveDueDate('2026-09-14', TOKYO))).toBe('2026-09-14T14:59:59.999Z');
    });

    it('handles a leap day', () => {
      expect(expectOk(resolveDueDate('2028-02-29', 'UTC'))).toBe('2028-02-29T23:59:59.999Z');
    });
  });

  describe('datetime input', () => {
    it('stores a Z-suffixed instant as given', () => {
      expect(expectOk(resolveDueDate('2026-09-14T17:00:00Z', LA))).toBe('2026-09-14T17:00:00.000Z');
    });

    it('stores an explicit-offset instant as the instant it names', () => {
      expect(expectOk(resolveDueDate('2026-09-14T17:00:00-07:00', TOKYO))).toBe(
        '2026-09-15T00:00:00.000Z'
      );
    });

    it('accepts the exact form Myra passed', () => {
      expect(expectOk(resolveDueDate('2026-09-14T00:00:00.000Z', LA))).toBe(
        '2026-09-14T00:00:00.000Z'
      );
    });

    it('interprets an offset-less datetime in the user timezone, not the server one', () => {
      // 17:00 PDT === 2026-09-15T00:00Z. Server TZ must not enter into it.
      expect(expectOk(resolveDueDate('2026-09-14T17:00:00', LA))).toBe('2026-09-15T00:00:00.000Z');
      expect(expectOk(resolveDueDate('2026-09-14T17:00:00', TOKYO))).toBe(
        '2026-09-14T08:00:00.000Z'
      );
    });

    it('accepts minute precision and a space separator', () => {
      expect(expectOk(resolveDueDate('2026-09-14T17:00', 'UTC'))).toBe('2026-09-14T17:00:00.000Z');
      expect(expectOk(resolveDueDate('2026-09-14 17:00:00', 'UTC'))).toBe(
        '2026-09-14T17:00:00.000Z'
      );
    });
  });

  describe('clearing', () => {
    it('passes null through as an explicit clear', () => {
      expect(resolveDueDate(null, LA)).toEqual({ ok: true, value: null });
    });
  });

  describe('rejection', () => {
    it('rejects a date that does not exist rather than rolling it over', () => {
      // Date.UTC would turn this into March 2.
      const result = resolveDueDate('2026-02-30', 'UTC');
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain('not a real date');
    });

    it('rejects a non-leap-year Feb 29', () => {
      expect(resolveDueDate('2026-02-29', 'UTC').ok).toBe(false);
    });

    it('rejects an out-of-range time that would silently roll over', () => {
      // 10:99 rolls to 11:39 within the same day, so the date check alone misses it.
      expect(resolveDueDate('2026-09-14T10:99', 'UTC').ok).toBe(false);
      expect(resolveDueDate('2026-09-14T25:00', 'UTC').ok).toBe(false);
    });

    it('rejects unparseable and empty input with a message naming the accepted forms', () => {
      for (const bad of ['next Tuesday', 'soon', '', '  ', '09/14/2026', '2026-9-14']) {
        const result = resolveDueDate(bad, LA);
        expect(result.ok, `expected "${bad}" to be rejected`).toBe(false);
        expect(result.ok === false && result.error).toMatch(/YYYY-MM-DD|empty/);
      }
    });

    it('rejects a bad timestamp that carries an offset', () => {
      expect(resolveDueDate('2026-13-45T99:99:99Z', 'UTC').ok).toBe(false);
    });
  });
});
