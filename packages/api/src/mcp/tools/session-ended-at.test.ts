/**
 * The completion half of PR #349 (revived).
 *
 * findByThreadKey filters on `ended_at IS NULL`. Nothing set `ended_at` on
 * completion, so that clause was always true and a finished session kept
 * matching its own threadKey — the next trigger resumed a conversation that
 * was over. The filter fix in session-repository is inert without this.
 */

import { describe, it, expect } from 'vitest';
import { shouldStampEndedAt, shouldClearEndedAt } from './memory-handlers.js';

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

/**
 * The reopen half (PR #541, Lumen's P1).
 *
 * Selecting a finished session out of the picker sent `status: 'active'`, which
 * is and always was a no-op — so `ended_at` stayed set and the lifecycle stayed
 * terminal while the chat was visibly generating. The row remained invisible to
 * attachable listing, active-session lookup and findByThreadKey, so a trigger
 * could open a SECOND session on the thread the human was already typing into.
 */
describe('shouldClearEndedAt', () => {
  it('clears when the user explicitly reopened the session', () => {
    expect(shouldClearEndedAt({ reopen: true })).toBe(true);
  });

  // The fence. `ended_at` is what stops automatic routing resuming a finished
  // conversation (shouldStampEndedAt above, PR #349). Every liveness report from
  // a hook or runner arrives as a lifecycle with no reopen flag — so if any of
  // these cleared it, the fence would be gone for the whole fleet.
  it.each(['running', 'idle', 'compacting'])(
    'does not clear on a bare %s lifecycle — that is a liveness report, not a choice',
    (lifecycle) => {
      expect(shouldClearEndedAt({ lifecycle })).toBe(false);
    }
  );

  it('does not clear when reopen is absent or false', () => {
    expect(shouldClearEndedAt({})).toBe(false);
    expect(shouldClearEndedAt({ reopen: false, lifecycle: 'running' })).toBe(false);
  });

  it.each(['completed', 'failed'])('refuses to reopen INTO terminal lifecycle %s', (lifecycle) => {
    expect(shouldClearEndedAt({ reopen: true, lifecycle })).toBe(false);
  });

  // Found by the agreement test below, not by inspection: the legacy spelling
  // carries completion too, so reopen + status:'completed' made both predicates
  // true and left the outcome to branch order.
  it('refuses to reopen a call that also completes via the legacy status', () => {
    expect(shouldClearEndedAt({ reopen: true, status: 'completed' })).toBe(false);
  });

  // The two predicates write the same column in opposite directions. If both
  // could be true for one call, which one won would depend on branch order
  // rather than on what the caller asked for.
  it('never agrees with shouldStampEndedAt on the same input', () => {
    const statuses = [undefined, 'active', 'paused', 'resumable', 'completed'];
    const lifecycles = [undefined, 'running', 'idle', 'compacting', 'completed', 'failed'];
    for (const status of statuses) {
      for (const lifecycle of lifecycles) {
        for (const reopen of [undefined, true, false]) {
          const label = [status, lifecycle, reopen].join('/');
          const stamp = shouldStampEndedAt({ status, lifecycle });
          const clear = shouldClearEndedAt({ reopen, status, lifecycle });
          expect(stamp && clear, label).toBe(false);
        }
      }
    }
  });
});
