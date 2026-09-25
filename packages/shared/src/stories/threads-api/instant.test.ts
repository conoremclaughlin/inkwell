import { describe, expect, it } from 'vitest';
import { compareInstants } from './instant.js';

describe('compareInstants', () => {
  it('orders microseconds that share a millisecond', () => {
    // Date.parse reads both as .123 and calls them equal.
    expect(Date.parse('2026-09-22T00:00:00.123100+00:00')).toBe(
      Date.parse('2026-09-22T00:00:00.123900+00:00')
    );
    expect(
      compareInstants('2026-09-22T00:00:00.123100+00:00', '2026-09-22T00:00:00.123900+00:00')
    ).toBeLessThan(0);
    expect(
      compareInstants('2026-09-22T00:00:00.123900+00:00', '2026-09-22T00:00:00.123100+00:00')
    ).toBeGreaterThan(0);
  });

  it('reads fractions of different lengths as the numbers they are', () => {
    // Postgres trims trailing zeros: .5 is .500000, and later than .49.
    expect(compareInstants('2026-09-22T00:00:00.5+00:00', '2026-09-22T00:00:00.49+00:00')).toBe(1);
    expect(compareInstants('2026-09-22T00:00:00.5+00:00', '2026-09-22T00:00:00.500000+00:00')).toBe(
      0
    );
    expect(compareInstants('2026-09-22T00:00:00+00:00', '2026-09-22T00:00:00.000001+00:00')).toBe(
      -1
    );
  });

  it('compares across offsets and the Z form', () => {
    expect(compareInstants('2026-09-22T00:00:00.123456Z', '2026-09-22T00:00:00.123456+00:00')).toBe(
      0
    );
    expect(
      compareInstants('2026-09-22T02:00:00.000001+02:00', '2026-09-22T00:00:00.000002Z')
    ).toBeLessThan(0);
  });

  it('agrees with Date.parse wherever milliseconds are enough', () => {
    const a = new Date(Date.UTC(2026, 8, 22, 10, 0, 0, 1)).toISOString();
    const b = new Date(Date.UTC(2026, 8, 22, 10, 0, 0, 2)).toISOString();
    expect(compareInstants(a, b)).toBe(-1);
    expect(compareInstants(b, a)).toBe(1);
    expect(compareInstants(a, a)).toBe(0);
  });
});
