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
import {
  registerActiveRun,
  clearActiveRun,
  listActiveRuns,
  activeRunCount,
  resetActiveRuns,
} from './active-runs.js';
import { interruptActiveRuns, INTERRUPT_REASON } from './interrupt-active-runs.js';
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

/** Minimal Supabase-shaped stub recording what the code writes. */
function makeClient() {
  const sessionUpdates: Record<string, unknown>[] = [];
  const threadMessages: Record<string, unknown>[] = [];

  const client = {
    from(table: string) {
      if (table === 'sessions') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { metadata: { taskDescription: 'review #485' } },
                error: null,
              }),
            }),
          }),
          update: (values: Record<string, unknown>) => ({
            eq: async (_col: string, id: string) => {
              sessionUpdates.push({ id, ...values });
              return { error: null };
            },
          }),
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
    expect(String(posted.content)).toContain('interrupted');
    expect(String(posted.content)).toContain('codex-cli');
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
              eq: () => ({ maybeSingle: async () => ({ data: { metadata: {} }, error: null }) }),
            }),
            update: (values: Record<string, unknown>) => ({
              eq: async (_c: string, id: string) => {
                sessionUpdates.push({ id, ...values });
                return { error: null };
              },
            }),
          };
        }
        throw new Error('thread tables unavailable');
      },
    };

    const [outcome] = await interruptActiveRuns(client, [run()]);
    expect(sessionUpdates).toHaveLength(1);
    expect(outcome).toMatchObject({ marked: true, noticed: false });
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
