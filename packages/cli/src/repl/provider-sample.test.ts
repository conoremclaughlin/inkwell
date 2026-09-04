import { describe, it, expect } from 'vitest';
import { ProviderSampleTracker, type ProviderSampleScope } from './provider-sample.js';

const scope: ProviderSampleScope = {
  backend: 'claude',
  model: 'claude-opus-5',
  backendSessionId: 'sess-1',
  envelopeShape: 'shape-a',
};
const usage = {
  backend: 'claude',
  source: 'json' as const,
  // The run's aggregate — NOT the parts of the final request below.
  inputTokens: 5_000,
  cacheReadTokens: 900_000,
  cacheWriteTokens: 90_000,
  contextTokens: 541_000,
  contextParts: { inputTokens: 1_000, cacheReadTokens: 500_000, cacheWriteTokens: 40_000 },
};

describe('ProviderSampleTracker — a measurement is only good for the window it measured (Lumen, PR #583)', () => {
  it('hands the sample back under the scope it was recorded in', () => {
    const t = new ProviderSampleTracker();
    t.record(usage, scope, '2026-09-03T20:00:00.000Z');
    expect(t.measurement(scope)).toEqual({
      contextTokens: 541_000,
      inputTokens: 1_000,
      cacheReadTokens: 500_000,
      cacheWriteTokens: 40_000,
      model: 'claude-opus-5',
      measuredAt: '2026-09-03T20:00:00.000Z',
    });
  });

  it("REGRESSION (Lumen, round 3): the breakdown is the final request's parts, which sum to the total — never the aggregate", () => {
    const t = new ProviderSampleTracker();
    t.record(usage, scope);
    const m = t.measurement(scope)!;
    expect(m.inputTokens! + m.cacheReadTokens! + m.cacheWriteTokens!).toBe(m.contextTokens);
    const noParts = new ProviderSampleTracker();
    noParts.record({ ...usage, contextParts: undefined }, scope);
    expect(noParts.measurement(scope)).toEqual({
      contextTokens: 541_000,
      model: 'claude-opus-5',
      measuredAt: expect.any(String),
    });
  });

  it.each([
    ['the native session was rolled', { backendSessionId: 'sess-2' }],
    ['the session went stateless', { backendSessionId: undefined }],
    ['the model changed', { model: 'claude-sonnet-5' }],
    ['the envelope was rebuilt', { envelopeShape: 'shape-b' }],
    ['the backend changed', { backend: 'codex' }],
  ])('is silent once %s', (_why, change) => {
    const t = new ProviderSampleTracker();
    t.record(usage, scope);
    expect(t.measurement({ ...scope, ...change })).toBeUndefined();
  });

  it('is silent after clear, and when the report carried no context count', () => {
    const t = new ProviderSampleTracker();
    t.record(usage, scope);
    t.clear();
    expect(t.measurement(scope)).toBeUndefined();
    t.record({ backend: 'claude', source: 'json', outputTokens: 5 }, scope);
    expect(t.measurement(scope)).toBeUndefined();
  });

  it('a spawn that reported nothing keeps the previous sample', () => {
    const t = new ProviderSampleTracker();
    t.record(usage, scope);
    t.record(undefined, scope);
    expect(t.measurement(scope)?.contextTokens).toBe(541_000);
  });

  it('a later report replaces the earlier one', () => {
    const t = new ProviderSampleTracker();
    t.record(usage, scope);
    t.record({ ...usage, contextTokens: 600_000 }, scope);
    expect(t.measurement(scope)?.contextTokens).toBe(600_000);
  });
});
