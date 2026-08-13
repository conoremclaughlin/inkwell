/**
 * Interrupted-turn bookkeeping.
 *
 * The bug these guard: on 2026-08-12 three of Lumen's PR reviews were killed
 * by dev-server restarts. Every one left its session at `lifecycle: 'running'`
 * with a null `backendSessionId`, so `list_sessions` and `ink mission` both
 * reported a review in progress for hours after the process was gone, and
 * neither the sender nor the reviewer was ever told.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  registerActiveRun,
  clearActiveRun,
  listActiveRuns,
  activeRunCount,
  resetActiveRuns,
  trackStateWrite,
  closeIntakeAndDrain,
  isIntakeOpen,
  admitStateWrite,
} from './active-runs.js';
import {
  interruptActiveRuns,
  isAlreadyTerminal,
  INTERRUPT_REASON,
} from './interrupt-active-runs.js';
import type { ActiveRun } from './active-runs.js';

const run = (over: Partial<ActiveRun> = {}): ActiveRun => ({
  sessionId: 'sess-1',
  userId: 'user-1',
  agentId: 'lumen',
  backend: 'codex-cli',
  threadKey: 'pr:485',
  senderAgentId: 'wren',
  startedAt: 1_000,
  ...over,
});

describe('active-runs registry', () => {
  beforeEach(() => resetActiveRuns());

  it('tracks a run from register to clear', () => {
    registerActiveRun(run());
    expect(activeRunCount()).toBe(1);
    expect(listActiveRuns()[0]?.threadKey).toBe('pr:485');
    clearActiveRun('sess-1');
    expect(activeRunCount()).toBe(0);
  });

  it('keys by session so a re-registered session does not double-count', () => {
    registerActiveRun(run());
    registerActiveRun(run({ backend: 'claude-code' }));
    expect(activeRunCount()).toBe(1);
    expect(listActiveRuns()[0]?.backend).toBe('claude-code');
  });

  it('ignores a clear for a session it never saw', () => {
    expect(() => clearActiveRun('nope')).not.toThrow();
    expect(activeRunCount()).toBe(0);
  });
});

/**
 * P1 (Lumen, PR #490): the registry window must CONTAIN the persisted
 * running-state window, not sit inside it.
 *
 * Registering after the `running` write, or clearing in a `finally` around
 * runner.run() before the terminal write, leaves a gap where the row says
 * `running` and the registry says nothing is in flight — a shutdown in that
 * gap walks away and the zombie survives. The ordering is the entire
 * invariant and it lives in a closure no unit test can address, so pin it in
 * source order.
 */
describe('registry brackets the persisted running state', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'session-service.ts'),
    'utf-8'
  );

  const at = (needle: string) => source.indexOf(needle);

  it('registers before the row is written as running', () => {
    const register = at('registerActiveRun({');
    const running = at("lifecycle: 'running' }");
    expect(register).toBeGreaterThan(-1);
    expect(running).toBeGreaterThan(-1);
    expect(register).toBeLessThan(running);
  });

  it('clears only after the failed write on the runner-throw path', () => {
    const failed = at("lifecycle: 'failed' }");
    const clearAfterFailed = source.indexOf('clearActiveRun(', failed);
    expect(failed).toBeGreaterThan(-1);
    expect(clearAfterFailed).toBeGreaterThan(failed);
    // ...and before the rethrow, so the error path does not leak a registration.
    expect(source.indexOf('throw runnerError', failed)).toBeGreaterThan(clearAfterFailed);
  });

  it('clears only after the post-run lifecycle write on the success path', () => {
    const postRun = at('const postRunLifecycle');
    expect(postRun).toBeGreaterThan(-1);
    expect(source.indexOf('clearActiveRun(', postRun)).toBeGreaterThan(postRun);
  });

  // The shape that caused P1: a finally fires while the row still says running.
  it('does not clear from a finally around the runner call', () => {
    expect(source).not.toMatch(/finally\s*\{[^}]*clearActiveRun/);
  });
});

/**
 * The interleavings that source order cannot model (Lumen, PR #490 round 2).
 * Membership in a Set says nothing about writes still in flight; these pin the
 * handshake that does.
 */
describe('shutdown handshake', () => {
  beforeEach(() => resetActiveRuns());

  it('refuses new runs once intake has closed', async () => {
    await closeIntakeAndDrain();
    expect(isIntakeOpen()).toBe(false);
    expect(registerActiveRun(run({ sessionId: 'late' }))).toBe(false);
    expect(activeRunCount()).toBe(0);
  });

  it('admits runs while intake is open', () => {
    expect(registerActiveRun(run())).toBe(true);
    expect(activeRunCount()).toBe(1);
  });

  // The interleaving that broke round 1: shutdown writes idle, then the turn's
  // still-pending `running` write lands on top. Draining first means no
  // lifecycle write is outstanding when the interruption runs.
  it('waits for an in-flight state write before reporting', async () => {
    registerActiveRun(run());

    let settled = false;
    let release!: () => void;
    trackStateWrite(
      new Promise<void>((resolve) => {
        release = () => {
          settled = true;
          resolve();
        };
      })
    );

    const draining = closeIntakeAndDrain(5_000);
    // Give the drain a tick to observe the outstanding write.
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await draining;
    expect(settled).toBe(true);
  });

  /**
   * The "registered after the snapshot" hole is closed by construction rather
   * than by ordering: intake shuts synchronously at the top of the drain, so
   * there is no window in which a run can join and then be missed. A run that
   * tries is refused, and its caller declines to start the turn at all.
   */
  it('cannot be joined once draining has begun', async () => {
    let release!: () => void;
    trackStateWrite(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );

    const draining = closeIntakeAndDrain(5_000);
    expect(registerActiveRun(run({ sessionId: 'mid-drain' }))).toBe(false);
    release();

    const { runs: snapshot } = await draining;
    expect(snapshot.map((r) => r.sessionId)).not.toContain('mid-drain');
  });

  it('reports every run that registered before intake closed', async () => {
    registerActiveRun(run({ sessionId: 'a' }));
    registerActiveRun(run({ sessionId: 'b' }));

    const { runs: snapshot } = await closeIntakeAndDrain(5_000);
    expect(snapshot.map((r) => r.sessionId).sort()).toEqual(['a', 'b']);
  });

  it('proceeds rather than burning the shutdown budget on a hung write', async () => {
    registerActiveRun(run());
    trackStateWrite(new Promise<void>(() => {})); // never settles

    const { runs: snapshot, drained } = await closeIntakeAndDrain(20);
    expect(snapshot).toHaveLength(1);
    // Reported, not swallowed — a racing write may still land.
    expect(drained).toBe(false);
  });

  it('reports a clean drain as drained', async () => {
    registerActiveRun(run());
    trackStateWrite(Promise.resolve());
    const { drained } = await closeIntakeAndDrain(5_000);
    expect(drained).toBe(true);
  });

  it('stops tracking a write once it settles, including on rejection', async () => {
    await trackStateWrite(Promise.reject(new Error('write failed'))).catch(() => {});
    // A rejected write must not stall the drain forever.
    await expect(closeIntakeAndDrain(20)).resolves.toEqual({ runs: [], drained: true });
  });

  /**
   * Closing intake stops new turns. It must also stop an already-admitted
   * runner from finalizing after the snapshot: repository.update() rewrites
   * the whole metadata blob, so a late write would overwrite the
   * interruption's lifecycle AND erase its breadcrumb (Lumen, PR #490 r3).
   */
  it('refuses late lifecycle writes from runs admitted before shutdown', async () => {
    registerActiveRun(run());
    expect(admitStateWrite('sess-1')).toBe(true);

    await closeIntakeAndDrain(20);
    expect(admitStateWrite('sess-1')).toBe(false);
  });
});

describe('isAlreadyTerminal', () => {
  it.each([
    [{ lifecycle: 'completed', ended_at: null }, true],
    [{ lifecycle: 'failed', ended_at: null }, true],
    [{ lifecycle: 'running', ended_at: '2026-08-13T07:00:00Z' }, true],
    [{ lifecycle: 'running', ended_at: null }, false],
    [{ lifecycle: 'idle', ended_at: null }, false],
    [{}, false],
  ])('%o → %s', (row, expected) => {
    expect(isAlreadyTerminal(row)).toBe(expected);
  });
});

/**
 * Minimal Supabase-shaped stub recording what the code writes.
 *
 * @param sessionRow what the pre-write read returns
 * @param matchesPredicates whether the conditional update matches a row —
 *   false simulates the session terminalizing between the read and the write
 */
function makeClient(
  sessionRow: Record<string, unknown> = {},
  matchesPredicates = true,
  rowAfter?: Record<string, unknown>
) {
  const sessionUpdates: Record<string, unknown>[] = [];
  const threadMessages: Record<string, unknown>[] = [];
  let reads = 0;

  const client = {
    from(table: string) {
      if (table === 'sessions') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => {
                // The re-read after a zero-row match sees the row as it is
                // NOW, which is the whole point of going back to look.
                const row = reads++ === 0 ? sessionRow : (rowAfter ?? sessionRow);
                return {
                  data: {
                    metadata: { taskDescription: 'review #485' },
                    lifecycle: 'running',
                    ended_at: null,
                    ...row,
                  },
                  error: null,
                };
              },
            }),
          }),
          // Mirrors PostgREST: filters accumulate, `.select()` resolves to the
          // rows the predicates actually matched. `matchesPredicates` lets a
          // test simulate the row changing between the read and the write.
          update: (values: Record<string, unknown>) => {
            const filters: Array<[string, unknown]> = [];
            const builder = {
              eq(col: string, value: unknown) {
                filters.push([col, value]);
                return builder;
              },
              is(col: string, value: unknown) {
                filters.push([col, value]);
                return builder;
              },
              select: async () => {
                const conditional = filters.some(([col]) => col === 'lifecycle');
                if (conditional && !matchesPredicates) return { data: [], error: null };
                sessionUpdates.push({ id: filters[0]?.[1], ...values });
                return { data: [{ id: filters[0]?.[1] }], error: null };
              },
            };
            return builder;
          },
        };
      }
      if (table === 'inbox_threads') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: { id: 'thread-1' }, error: null }) }),
            }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      if (table === 'inbox_thread_messages') {
        return {
          insert: async (row: Record<string, unknown>) => {
            threadMessages.push(row);
            return { error: null };
          },
        };
      }
      return { insert: async () => ({ error: null }) };
    },
  };

  return { client, sessionUpdates, threadMessages };
}

describe('interruptActiveRuns', () => {
  beforeEach(() => resetActiveRuns());

  it('moves the session off running and marks it resumable', async () => {
    const { client, sessionUpdates } = makeClient();
    await interruptActiveRuns(client, [run()]);

    expect(sessionUpdates).toHaveLength(1);
    expect(sessionUpdates[0]).toMatchObject({
      id: 'sess-1',
      lifecycle: 'idle',
      status: 'resumable',
    });
  });

  // The whole reason to prefer 'idle'/'resumable' over 'failed': findByThreadKey
  // filters on `ended_at IS NULL`, so stamping it would make the session
  // unfindable and the next trigger would start cold instead of resuming.
  it('does not stamp ended_at, so the session stays resumable by threadKey', async () => {
    const { client, sessionUpdates } = makeClient();
    await interruptActiveRuns(client, [run()]);
    expect(sessionUpdates[0]).not.toHaveProperty('ended_at');
  });

  it('records why, without clobbering existing metadata', async () => {
    const { client, sessionUpdates } = makeClient();
    await interruptActiveRuns(client, [run()]);

    const metadata = sessionUpdates[0]?.metadata as Record<string, unknown>;
    expect(metadata.interruptedReason).toBe(INTERRUPT_REASON);
    expect(metadata.interruptedAt).toEqual(expect.any(String));
    expect(metadata.taskDescription).toBe('review #485');
  });

  it('posts a notice into the thread so the waiting agent finds out', async () => {
    const { client, threadMessages } = makeClient();
    await interruptActiveRuns(client, [run()]);

    expect(threadMessages).toHaveLength(1);
    const posted = threadMessages[0]!;
    expect(posted.thread_id).toBe('thread-1');
    // 'system', never the interrupted agent — a synthetic row in their name
    // would shadow their newest real message in recipient-session lookup.
    expect(posted.sender_agent_id).toBe('system');
    expect(String(posted.content)).toContain('cut short');
    expect(String(posted.content)).toContain('codex-cli');
    expect(String(posted.content)).toContain('lumen');
    expect(String(posted.content)).toContain('pr:485');
  });

  it('still terminalizes a threadless run, with no notice to post', async () => {
    const { client, sessionUpdates, threadMessages } = makeClient();
    const [outcome] = await interruptActiveRuns(client, [run({ threadKey: undefined })]);

    expect(sessionUpdates).toHaveLength(1);
    expect(threadMessages).toHaveLength(0);
    expect(outcome).toMatchObject({ marked: true, noticed: false });
  });

  it('handles every run, not just the first', async () => {
    const { client, sessionUpdates } = makeClient();
    await interruptActiveRuns(client, [
      run({ sessionId: 'a', threadKey: 'pr:483' }),
      run({ sessionId: 'b', threadKey: 'pr:484' }),
      run({ sessionId: 'c', threadKey: 'pr:485' }),
    ]);
    expect(sessionUpdates.map((u) => u.id)).toEqual(['a', 'b', 'c']);
  });

  /**
   * P2 (Lumen, PR #490). A child can call update_session_state(completed)
   * and be killed before it exits. #349 stamps `ended_at` on that, and
   * findByThreadKey filters `ended_at IS NULL` — so writing idle/resumable
   * over the top yields a session that claims to be resumable and cannot be
   * found. The notice would promise a resumption that cannot happen.
   */
  describe('a session that already terminalized itself', () => {
    it('is not downgraded to resumable when ended_at is already set', async () => {
      const { client, sessionUpdates } = makeClient({
        lifecycle: 'completed',
        ended_at: '2026-08-13T07:00:00.000Z',
      });
      const [outcome] = await interruptActiveRuns(client, [run()]);

      expect(outcome).toMatchObject({ alreadyTerminal: true, marked: true });
      expect(sessionUpdates[0]).not.toHaveProperty('lifecycle');
      expect(sessionUpdates[0]).not.toHaveProperty('status');
      expect(sessionUpdates[0]).not.toHaveProperty('ended_at');
    });

    // ended_at alone is enough — lifecycle may still read 'running' if the
    // child stamped completion through the status spelling.
    it('treats a non-null ended_at as terminal even when lifecycle says running', async () => {
      const { client, sessionUpdates } = makeClient({
        lifecycle: 'running',
        ended_at: '2026-08-13T07:00:00.000Z',
      });
      const [outcome] = await interruptActiveRuns(client, [run()]);

      expect(outcome.alreadyTerminal).toBe(true);
      expect(sessionUpdates[0]).not.toHaveProperty('lifecycle');
    });

    it('treats lifecycle failed as terminal', async () => {
      const { client } = makeClient({ lifecycle: 'failed', ended_at: null });
      const [outcome] = await interruptActiveRuns(client, [run()]);
      expect(outcome.alreadyTerminal).toBe(true);
    });

    it('still records the breadcrumb, preserving existing metadata', async () => {
      const { client, sessionUpdates } = makeClient({
        lifecycle: 'completed',
        ended_at: '2026-08-13T07:00:00.000Z',
      });
      await interruptActiveRuns(client, [run()]);

      const metadata = sessionUpdates[0]?.metadata as Record<string, unknown>;
      expect(metadata.interruptedReason).toBe(INTERRUPT_REASON);
      expect(metadata.taskDescription).toBe('review #485');
    });

    // The promise has to match what the state can deliver.
    it('does not promise resumption in the notice', async () => {
      const { client, threadMessages } = makeClient({
        lifecycle: 'completed',
        ended_at: '2026-08-13T07:00:00.000Z',
      });
      await interruptActiveRuns(client, [run()]);

      const content = String(threadMessages[0]!.content);
      expect(content).not.toContain('resumable');
      expect(content).not.toContain('re-trigger');
      expect(content).toContain('may not have arrived');
    });

    it('does promise resumption for a genuinely interrupted run', async () => {
      const { client, threadMessages } = makeClient();
      await interruptActiveRuns(client, [run()]);

      const content = String(threadMessages[0]!.content);
      expect(content).toContain('resumable');
      expect(content).toContain('re-trigger');
    });
  });

  /**
   * Read-then-write is not enough on its own: completion can land in the gap.
   * The predicates on the update are evaluated atomically with it by Postgres,
   * so a row that stopped being running-and-unended matches zero rows instead
   * of being overwritten (Lumen, PR #490 round 2).
   */
  describe('racing the child’s own completion write', () => {
    it('does not overwrite a row that terminalized between the read and the write', async () => {
      const { client, sessionUpdates } = makeClient({ lifecycle: 'running' }, false, {
        lifecycle: 'completed',
        ended_at: '2026-08-13T07:00:00.000Z',
      });
      const [outcome] = await interruptActiveRuns(client, [run()]);

      expect(outcome.state).toBe('finalized-elsewhere');
      // Only the breadcrumb write — no lifecycle/status downgrade.
      const wrote = sessionUpdates.find((u) => 'lifecycle' in u);
      expect(wrote).toBeUndefined();
    });

    it('still records the breadcrumb after losing that race', async () => {
      const { client, sessionUpdates } = makeClient({ lifecycle: 'running' }, false, {
        lifecycle: 'completed',
        ended_at: '2026-08-13T07:00:00.000Z',
      });
      const [outcome] = await interruptActiveRuns(client, [run()]);

      expect(outcome.marked).toBe(true);
      const metadata = sessionUpdates[0]?.metadata as Record<string, unknown>;
      expect(metadata.interruptedReason).toBe(INTERRUPT_REASON);
    });

    /**
     * Zero matches does not prove the session finished. A normal finalizer
     * writing `idle` produces the same zero-row result, and labelling it
     * terminal would be a claim we never checked (Lumen, PR #490 round 3).
     */
    it('classifies a normal idle finalizer as finalized-elsewhere, not terminal', async () => {
      const { client } = makeClient({ lifecycle: 'running' }, false, {
        lifecycle: 'idle',
        ended_at: null,
      });
      const [outcome] = await interruptActiveRuns(client, [run()]);
      expect(outcome.state).toBe('finalized-elsewhere');
    });

    // Zero matches while the row still reads running is a contradiction.
    // Guessing which way would be inventing a fact.
    it('reports unknown when the row still reads running after a zero-row match', async () => {
      const { client, sessionUpdates } = makeClient({ lifecycle: 'running' }, false, {
        lifecycle: 'running',
        ended_at: null,
      });
      const [outcome] = await interruptActiveRuns(client, [run()]);

      expect(outcome).toMatchObject({ state: 'unknown', marked: false });
      expect(sessionUpdates).toHaveLength(0);
    });

    it('constrains the write to running and unended rows', async () => {
      const filters: Array<[string, unknown]> = [];
      const client = {
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { metadata: {}, lifecycle: 'running', ended_at: null },
                error: null,
              }),
            }),
          }),
          update: () => {
            const b = {
              eq(c: string, v: unknown) {
                filters.push([c, v]);
                return b;
              },
              is(c: string, v: unknown) {
                filters.push([c, v]);
                return b;
              },
              select: async () => ({ data: [{ id: 'sess-1' }], error: null }),
            };
            return b;
          },
        }),
      };

      await interruptActiveRuns(client, [run({ threadKey: undefined })]);
      expect(filters).toContainEqual(['lifecycle', 'running']);
      expect(filters).toContainEqual(['ended_at', null]);
    });
  });

  /**
   * An unreadable row must not be assumed non-terminal — that assumption is
   * how a completed session gets overwritten with a resumable one.
   */
  it('fails closed when the session cannot be read', async () => {
    const sessionUpdates: Record<string, unknown>[] = [];
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: { message: 'connection reset' } }),
          }),
        }),
        update: () => ({
          eq: async () => {
            sessionUpdates.push({ shouldNotHappen: true });
            return { error: null };
          },
        }),
      }),
    };

    const [outcome] = await interruptActiveRuns(client, [run({ threadKey: undefined })]);
    // 'unknown', not 'already-terminal' — asserting the session completed when
    // we merely could not read it is its own false statement.
    expect(outcome).toMatchObject({ state: 'unknown', alreadyTerminal: false, marked: false });
    expect(sessionUpdates).toHaveLength(0);
  });

  it('warns that the state is unreliable when it could not be written', async () => {
    const client = {
      from: (table: string) => {
        if (table === 'sessions') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { metadata: {}, lifecycle: 'running', ended_at: null },
                  error: null,
                }),
              }),
            }),
            update: () => {
              const b = {
                eq: () => b,
                is: () => b,
                select: async () => ({ data: null, error: { message: 'write failed' } }),
              };
              return b;
            },
          };
        }
        if (table === 'inbox_threads') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: { id: 'thread-1' }, error: null }),
                }),
              }),
            }),
            update: () => ({ eq: async () => ({ error: null }) }),
          };
        }
        return { insert: async () => ({ error: null }) };
      },
    };

    const [outcome] = await interruptActiveRuns(client, [run()]);
    expect(outcome).toMatchObject({ marked: false, alreadyTerminal: false });
  });

  /**
   * A drain that timed out means a lifecycle write may still land on top of
   * ours. The write itself succeeded, but we cannot promise the state will
   * still say that a moment later — so the notice must not (Lumen, r3).
   */
  it('downgrades a successful interrupt to unknown when the drain timed out', async () => {
    const { client, threadMessages } = makeClient();
    const [outcome] = await interruptActiveRuns(client, [run()], 3_000, false);

    expect(outcome).toMatchObject({ state: 'unknown', marked: true });
    expect(String(threadMessages[0]!.content)).toContain('unreliable');
  });

  it('keeps a clean interrupt as interrupted when the drain completed', async () => {
    const { client } = makeClient();
    const [outcome] = await interruptActiveRuns(client, [run()], 3_000, true);
    expect(outcome.state).toBe('interrupted');
  });

  it('is a no-op with nothing in flight', async () => {
    const { client, sessionUpdates } = makeClient();
    await expect(interruptActiveRuns(client, [])).resolves.toEqual([]);
    expect(sessionUpdates).toHaveLength(0);
  });

  // A failed notice must not prevent the session being marked — the state fix
  // is the more important half, and shutdown is already time-boxed.
  it('marks the session even when the notice write fails', async () => {
    const sessionUpdates: Record<string, unknown>[] = [];
    const client = {
      from(table: string) {
        if (table === 'sessions') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { metadata: {}, lifecycle: 'running', ended_at: null },
                  error: null,
                }),
              }),
            }),
            update: (values: Record<string, unknown>) => {
              const b = {
                eq: () => b,
                is: () => b,
                select: async () => {
                  sessionUpdates.push(values);
                  return { data: [{ id: 'sess-1' }], error: null };
                },
              };
              return b;
            },
          };
        }
        throw new Error('thread tables unavailable');
      },
    };

    const [outcome] = await interruptActiveRuns(client, [run()]);
    expect(sessionUpdates).toHaveLength(1);
    expect(outcome).toMatchObject({ state: 'interrupted', marked: true, noticed: false });
  });

  it('gives up rather than blocking shutdown past its budget', async () => {
    vi.useFakeTimers();
    try {
      const client = {
        from: () => ({
          select: () => ({ eq: () => ({ maybeSingle: () => new Promise(() => {}) }) }),
        }),
      };
      const pending = interruptActiveRuns(client, [run()], 50);
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
