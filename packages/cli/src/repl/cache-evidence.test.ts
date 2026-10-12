import { describe, expect, it } from 'vitest';
import { nextRunCacheEvidence, type RunCacheEvidence } from './cache-evidence.js';

const scope = { providerSessionId: 'native-1', model: 'claude-opus-5-5' };
const hour: RunCacheEvidence = { kind: 'ttl', seconds: 3600, ...scope };

describe('nextRunCacheEvidence', () => {
  it('a written lifetime replaces what was there, in its own scope', () => {
    expect(nextRunCacheEvidence(hour, { kind: 'ttl', seconds: 300 }, scope)).toEqual({
      kind: 'ttl',
      seconds: 300,
      ...scope,
    });
  });

  it('a read-only invocation keeps a lifetime written in the same scope', () => {
    expect(nextRunCacheEvidence(hour, { kind: 'read-only' }, scope)).toBe(hour);
  });

  // Lumen, #845 r3: a new native session or model is a different cache entry.
  it('a read-only invocation in another scope is read-only in its own scope', () => {
    expect(
      nextRunCacheEvidence(hour, { kind: 'read-only' }, { ...scope, providerSessionId: 'native-2' })
    ).toEqual({ kind: 'read-only', providerSessionId: 'native-2', model: 'claude-opus-5-5' });
    expect(
      nextRunCacheEvidence(hour, { kind: 'read-only' }, { ...scope, model: 'claude-fable-5' })
    ).toEqual({ kind: 'read-only', providerSessionId: 'native-1', model: 'claude-fable-5' });
    expect(nextRunCacheEvidence(hour, { kind: 'read-only' }, { model: 'claude-opus-5-5' })).toEqual(
      { kind: 'read-only', model: 'claude-opus-5-5' }
    );
  });

  it('an unknown write, or no evidence at all, leaves nothing known', () => {
    expect(nextRunCacheEvidence(hour, { kind: 'unknown' }, scope)).toEqual({ kind: 'unknown' });
    expect(nextRunCacheEvidence(hour, undefined, scope)).toEqual({ kind: 'unknown' });
  });
});
