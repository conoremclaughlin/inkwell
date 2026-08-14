/**
 * The completion half of PR #349 (revived).
 *
 * findByThreadKey filters on `ended_at IS NULL`. Nothing set `ended_at` on
 * completion, so that clause was always true and a finished session kept
 * matching its own threadKey — the next trigger resumed a conversation that
 * was over. The filter fix in session-repository is inert without this.
 */

import { describe, it, expect } from 'vitest';
import { shouldStampEndedAt } from './memory-handlers.js';

describe('shouldStampEndedAt', () => {
  it('stamps on the current lifecycle spelling', () => {
    expect(shouldStampEndedAt({ lifecycle: 'completed' })).toBe(true);
  });

  // Legacy callers still send status; the mapping to lifecycle only happens
  // when lifecycle was not explicitly supplied, so this cannot be dropped.
  it('stamps on the legacy status spelling', () => {
    expect(shouldStampEndedAt({ status: 'completed' })).toBe(true);
  });

  it('stamps when a caller sends both', () => {
    expect(shouldStampEndedAt({ status: 'completed', lifecycle: 'completed' })).toBe(true);
  });

  it.each(['active', 'paused', 'resumable'])('does not stamp on status %s', (status) => {
    expect(shouldStampEndedAt({ status })).toBe(false);
  });

  it.each(['running', 'idle', 'failed'])('does not stamp on lifecycle %s', (lifecycle) => {
    expect(shouldStampEndedAt({ lifecycle })).toBe(false);
  });

  // An interrupted turn is deliberately left resumable and un-ended so the
  // threadKey lookup can still find it — see interrupt-active-runs.
  it('does not stamp for an interrupted session left idle and resumable', () => {
    expect(shouldStampEndedAt({ lifecycle: 'idle', status: 'resumable' })).toBe(false);
  });

  it('does not stamp when neither is supplied', () => {
    expect(shouldStampEndedAt({})).toBe(false);
  });
});
