import { describe, expect, it } from 'vitest';
import { DEFAULT_AWAKEN_CAP, inklingAwakenCap } from './inkling-flags';

describe('inklingAwakenCap', () => {
  it('is 2 when unset or blank', () => {
    expect(DEFAULT_AWAKEN_CAP).toBe(2);
    expect(inklingAwakenCap({})).toBe(2);
    expect(inklingAwakenCap({ INKLING_AWAKEN_CAP: '  ' })).toBe(2);
  });

  it('takes a positive whole number', () => {
    expect(inklingAwakenCap({ INKLING_AWAKEN_CAP: '5' })).toBe(5);
    expect(inklingAwakenCap({ INKLING_AWAKEN_CAP: ' 1 ' })).toBe(1);
  });

  it('falls back to 2 for anything else, never to no cap', () => {
    for (const raw of ['0', '-3', '2.5', 'many', 'Infinity']) {
      expect(inklingAwakenCap({ INKLING_AWAKEN_CAP: raw })).toBe(2);
    }
  });
});
