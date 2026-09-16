/**
 * A finished session has to LOOK finished. PR #349 (opened May 7, never
 * merged, since gone stale) found the two halves of why it didn't:
 *
 *   1. Nothing set `ended_at` when a session completed.
 *   2. findByThreadKey filtered on `ended_at IS NULL` — which, given (1), was
 *      always true and therefore filtered nothing.
 *
 * Together they meant a thread whose conversation was over routed the next
 * trigger straight back into the completed session. Both halves are revived
 * here; either alone is inert, which is why they belong in one change.
 */

import { describe, it, expect, vi } from 'vitest';
import { SessionRepository } from './session-repository.js';

/**
 * Records the filter chain findByThreadKey builds. Every method returns the
 * builder so the chain composes, and awaiting it yields an empty result —
 * the assertions are about the query, not the rows.
 */
function makeQueryRecorder() {
  const calls: Array<{ method: string; args: unknown[] }> = [];

  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'neq', 'not', 'order', 'limit']) {
    builder[method] = vi.fn((...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    });
  }
  // `await`ed at the end of the chain.
  builder.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });

  const client = { from: vi.fn(() => builder) };
  return { client, calls };
}

describe('findByThreadKey — completed sessions must not be reused', () => {
  it('excludes completed and failed lifecycles', async () => {
    const { client, calls } = makeQueryRecorder();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SessionRepository(client as any);

    await repo.findByThreadKey('user-1', 'lumen', 'pr:485');

    const notCall = calls.find((c) => c.method === 'not');
    expect(notCall, 'lifecycle must be filtered with .not(... in ...)').toBeDefined();
    expect(notCall!.args[0]).toBe('lifecycle');
    expect(notCall!.args[1]).toBe('in');
    expect(String(notCall!.args[2])).toContain('completed');
    expect(String(notCall!.args[2])).toContain('failed');
  });

  // The old filter. `completed` slipping through it is the entire bug.
  it('no longer filters on failed alone', async () => {
    const { client, calls } = makeQueryRecorder();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SessionRepository(client as any);

    await repo.findByThreadKey('user-1', 'lumen', 'pr:485');

    const neqLifecycle = calls.find((c) => c.method === 'neq' && c.args[0] === 'lifecycle');
    expect(neqLifecycle).toBeUndefined();
  });

  // 'cancelled' is NOT in the exclusion list, and must not be: SessionLifecycle
  // is 'running' | 'idle' | 'completed' | 'failed'. The original #349 patch
  // listed it, which would have filtered on a value the type cannot hold.
  it('does not filter on lifecycle values that do not exist', async () => {
    const { client, calls } = makeQueryRecorder();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SessionRepository(client as any);

    await repo.findByThreadKey('user-1', 'lumen', 'pr:485');

    const notCall = calls.find((c) => c.method === 'not');
    expect(String(notCall!.args[2])).not.toContain('cancelled');
  });

  it('still scopes to the thread and the agent', async () => {
    const { client, calls } = makeQueryRecorder();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SessionRepository(client as any);

    await repo.findByThreadKey('user-1', 'lumen', 'pr:485');

    const eqPairs = calls.filter((c) => c.method === 'eq').map((c) => [c.args[0], c.args[1]]);
    expect(eqPairs).toContainEqual(['user_id', 'user-1']);
    expect(eqPairs).toContainEqual(['agent_id', 'lumen']);
    expect(eqPairs).toContainEqual(['thread_key', 'pr:485']);
  });
});
