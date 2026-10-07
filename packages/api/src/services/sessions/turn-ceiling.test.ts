import { describe, expect, it } from 'vitest';
import { ceilingFromEnv, lowestCeiling } from './turn-ceiling';

describe('ceilingFromEnv', () => {
  it('is no ceiling unless the value is a positive number of milliseconds', () => {
    expect(ceilingFromEnv(undefined)).toBeUndefined();
    expect(ceilingFromEnv('')).toBeUndefined();
    expect(ceilingFromEnv('soon')).toBeUndefined();
    expect(ceilingFromEnv('0')).toBeUndefined();
    expect(ceilingFromEnv('-60000')).toBeUndefined();
    expect(ceilingFromEnv('1800000')).toBe(1_800_000);
  });
});

describe('lowestCeiling', () => {
  it('is the lower of two configured ceilings, whichever order they come in', () => {
    expect(lowestCeiling(1_800_000, 90_000)).toBe(90_000);
    expect(lowestCeiling(90_000, 1_800_000)).toBe(90_000);
  });

  it('is the one configured ceiling when only one is', () => {
    expect(lowestCeiling(undefined, 90_000)).toBe(90_000);
    expect(lowestCeiling(1_800_000, undefined)).toBe(1_800_000);
  });

  it('is no ceiling when none is configured, or none is a positive number', () => {
    expect(lowestCeiling()).toBeUndefined();
    expect(lowestCeiling(undefined, undefined)).toBeUndefined();
    expect(lowestCeiling(0, Number.NaN, -1)).toBeUndefined();
  });
});
