import { describe, expect, it } from 'vitest';
import { SessionUsage } from './session-usage.js';
import type { BackendModelUsage, BackendTokenUsage } from './token-usage.js';

function usage(cost?: number, model = 'model-a'): BackendTokenUsage {
  const contribution: BackendModelUsage = {
    inputTokens: 2,
    outputTokens: 3,
    cacheReadTokens: 5,
    cacheWriteTokens: 7,
    ...(cost !== undefined ? { costUSD: cost } : {}),
  };
  return {
    backend: 'claude',
    source: 'json',
    ...contribution,
    modelUsage: { [model]: contribution },
  };
}

describe('SessionUsage', () => {
  it('sums every invocation, including resume/continuation and failed attempts with usage', () => {
    const totals = new SessionUsage();
    totals.record(usage(1));
    totals.record(usage(2));
    totals.record(undefined);
    expect(totals.totals).toEqual({
      inputTokens: 4,
      outputTokens: 6,
      cacheReadTokens: 10,
      cacheWriteTokens: 14,
    });
    expect(totals.models['model-a']).toEqual({
      ...usage(1).modelUsage?.['model-a'],
      inputTokens: 4,
      outputTokens: 6,
      cacheReadTokens: 10,
      cacheWriteTokens: 14,
      costUSD: 3,
    });
  });
  it.each([
    [undefined, 1],
    [1, undefined],
    [undefined, 1, 2],
    [1, undefined, 2],
  ])('keeps a missing cost visible across contributions %j', (...costs) => {
    const totals = new SessionUsage();
    for (const cost of costs) totals.record(usage(cost));
    expect(totals.models['model-a']?.costPartial).toBe(true);
    expect(totals.models['model-a']?.costUSD).toBe(
      costs.reduce<number>((sum, c) => sum + (c ?? 0), 0)
    );
  });
  it('never converts a wholly unknown cost into a measured zero', () => {
    const totals = new SessionUsage();
    totals.record(usage());
    totals.record(usage());
    expect(totals.models['model-a']).not.toHaveProperty('costUSD');
    const zero = new SessionUsage();
    zero.record(usage(0));
    expect(zero.models['model-a']?.costUSD).toBe(0);
    expect(zero.models['model-a']).not.toHaveProperty('costPartial');
  });
  it('keeps models and sessions separate without guessing canonical ids', () => {
    const a = new SessionUsage();
    const b = new SessionUsage();
    a.record(usage(1));
    a.record(usage(2, 'model-b'));
    b.record(usage(8));
    expect(Object.keys(a.models)).toEqual(['model-a', 'model-b']);
    expect(a.models['model-a']?.costUSD).toBe(1);
    expect(b.models['model-a']?.costUSD).toBe(8);
    expect(a.models['model-a']).not.toHaveProperty('canonicalModel');
  });
});
