import { describe, expect, it, vi } from 'vitest';
import { createThreadDrainState, drainThreads, POLL_BUDGET, type PollDeps } from './poll-core.js';

let msgClock = 0;
function mkMsg(id: string, sender = 'lumen') {
  msgClock += 1;
  return {
    id,
    senderAgentId: sender,
    content: `content ${id}`,
    messageType: 'message',
    createdAt: new Date(1700000000000 + msgClock * 1000).toISOString(),
    metadata: {},
  };
}

function mkThread(threadKey: string, unreadCount: number) {
  return { threadKey, unreadCount };
}

interface Harness {
  deps: PollDeps;
  fetchArgs: Array<Record<string, unknown>>;
  ackArgs: Array<Record<string, unknown>>;
  notifications: Array<{ content: string; meta: Record<string, unknown> }>;
}

/**
 * threadFixtures: threadKey → behavior. `messages` served per fetch capped at
 * the requested limit; `fail: true` returns a failed fetch; `skipped` is the
 * server-reported skippedOlderCount.
 */
function createHarness(
  threadFixtures: Record<
    string,
    { messages?: Array<Record<string, unknown>>; fail?: boolean; skipped?: number }
  >,
  opts: { notifyFailOn?: string } = {}
): Harness {
  const fetchArgs: Array<Record<string, unknown>> = [];
  const ackArgs: Array<Record<string, unknown>> = [];
  const notifications: Array<{ content: string; meta: Record<string, unknown> }> = [];

  const deps: PollDeps = {
    callPcp: vi.fn(async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'get_thread_messages') {
        fetchArgs.push(args);
        const fixture = threadFixtures[args.threadKey as string];
        if (!fixture || fixture.fail) return { success: false };
        const limit = (args.limit as number) ?? 50;
        return {
          success: true,
          messages: (fixture.messages || []).slice(0, limit),
          ...(fixture.skipped ? { skippedOlderCount: fixture.skipped } : {}),
        };
      }
      if (tool === 'mark_thread_read') {
        ackArgs.push(args);
        return { success: true };
      }
      return { success: true };
    }),
    notify: vi.fn(async (content: string, meta: Record<string, unknown>) => {
      if (opts.notifyFailOn && content.includes(opts.notifyFailOn)) {
        throw new Error('emit failed');
      }
      notifications.push({ content, meta });
    }),
    log: vi.fn(),
    agentId: 'wren',
    email: 'test@test.com',
    studioId: 'studio-1',
  };
  return { deps, fetchArgs, ackArgs, notifications };
}

describe('drainThreads — budget (always active, never overshoots)', () => {
  it('bounds each request by the remaining budget: 25+50+25, fourth thread deferred', async () => {
    const h = createHarness({
      'pr:a': { messages: Array.from({ length: 25 }, (_, i) => mkMsg(`a-${i}`)) },
      'pr:b': { messages: Array.from({ length: 60 }, (_, i) => mkMsg(`b-${i}`)) },
      'pr:c': { messages: Array.from({ length: 60 }, (_, i) => mkMsg(`c-${i}`)) },
      'pr:d': { messages: [mkMsg('d-0')] },
    });
    const state = createThreadDrainState();
    const r = await drainThreads(h.deps, state, [
      mkThread('pr:a', 25),
      mkThread('pr:b', 60),
      mkThread('pr:c', 60),
      mkThread('pr:d', 1),
    ]);
    // 25 + 50 + 25 = exactly the budget; Lumen's 25+50+50=125 overshoot is gone.
    expect(r.injected).toBe(POLL_BUDGET);
    expect(r.ceilingHit).toBe(true);
    expect(h.fetchArgs.map((a) => a.limit)).toEqual([50, 50, 25]);
    expect(h.fetchArgs.map((a) => a.threadKey)).toEqual(['pr:a', 'pr:b', 'pr:c']);
  });

  it('stays budgeted on EVERY poll — no disarm flag', async () => {
    const mkFix = () => ({
      'pr:big': {
        messages: Array.from({ length: 120 }, (_, i) => mkMsg(`big2-${i}-${Math.random()}`)),
      },
    });
    const state = createThreadDrainState();
    const h1 = createHarness(mkFix());
    const r1 = await drainThreads(h1.deps, state, [mkThread('pr:big', 120)]);
    expect(r1.injected).toBeLessThanOrEqual(POLL_BUDGET);
    // Second poll (backlog continues): still capped.
    state.lastThreadMessageId.delete('pr:big'); // simulate fresh cursor
    const h2 = createHarness(mkFix());
    const r2 = await drainThreads(h2.deps, state, [mkThread('pr:big', 120)]);
    expect(r2.injected).toBeLessThanOrEqual(POLL_BUDGET);
  });
});

describe('drainThreads — cold-fetch ack protocol (spec §1)', () => {
  it('cold fetch is markRead:false + channelPoll, then acks the exact last delivered id', async () => {
    const msgs = [mkMsg('m-1'), mkMsg('m-2'), mkMsg('m-3')];
    const h = createHarness({ 'pr:x': { messages: msgs } });
    const state = createThreadDrainState();
    await drainThreads(h.deps, state, [mkThread('pr:x', 3)]);

    expect(h.fetchArgs[0]).toMatchObject({ markRead: false, channelPoll: true });
    expect(h.ackArgs).toEqual([
      expect.objectContaining({ threadKey: 'pr:x', throughMessageId: 'm-3' }),
    ]);
  });

  it('cursored incremental fetch keeps markRead:true and does not ack', async () => {
    const h = createHarness({ 'pr:x': { messages: [mkMsg('m-9')] } });
    const state = createThreadDrainState();
    state.lastThreadMessageId.set('pr:x', 'm-8');
    await drainThreads(h.deps, state, [mkThread('pr:x', 1)]);

    expect(h.fetchArgs[0]).toMatchObject({ markRead: true, afterMessageId: 'm-8' });
    expect(h.ackArgs).toHaveLength(0);
  });

  it('emit failure mid-batch: ack stops at the last SUCCESS, remainder redelivers', async () => {
    const msgs = [mkMsg('ok-1'), mkMsg('bad-2'), mkMsg('never-3')];
    const h = createHarness({ 'pr:x': { messages: msgs } }, { notifyFailOn: 'bad-2' });
    const state = createThreadDrainState();
    const r = await drainThreads(h.deps, state, [mkThread('pr:x', 3)]);

    expect(r.emitFailures).toBe(1);
    expect(r.injected).toBe(1);
    expect(h.ackArgs).toEqual([expect.objectContaining({ throughMessageId: 'ok-1' })]);
    // Cursor stops at the last success so bad-2/never-3 redeliver next poll.
    expect(state.lastThreadMessageId.get('pr:x')).toBe('ok-1');
    expect(state.seenMessageIds.has('bad-2')).toBe(false);
  });

  it('client-filtered messages stay inside the ack range', async () => {
    // Own same-studio message is silently consumed, not delivered — but the
    // ack must walk over it or the thread stays unread forever.
    const own = {
      ...mkMsg('own-1', 'wren'),
      metadata: { pcp: { sender: { studioId: 'studio-1' } } },
    };
    const other = mkMsg('other-2');
    const h = createHarness({ 'pr:x': { messages: [own, other] } });
    const state = createThreadDrainState();
    const r = await drainThreads(h.deps, state, [mkThread('pr:x', 2)]);

    expect(r.injected).toBe(1);
    expect(h.ackArgs).toEqual([expect.objectContaining({ throughMessageId: 'other-2' })]);
  });
});

describe('drainThreads — fetch failures', () => {
  it('a soft fetch failure isolates the thread, blocks the summary, and retries cold next poll', async () => {
    const state = createThreadDrainState();
    const h1 = createHarness({
      'pr:ok': { messages: [mkMsg('ok-1')], skipped: 4 },
      'pr:down': { fail: true },
    });
    const r1 = await drainThreads(h1.deps, state, [mkThread('pr:ok', 1), mkThread('pr:down', 5)]);
    expect(r1.fetchFailures).toBe(1);
    expect(state.summarySent).toBe(false); // not drained — no summary
    expect(state.lastThreadMessageId.has('pr:down')).toBe(false);

    // Next poll: pr:down recovers; still a COLD fetch (markRead:false + ack).
    const h2 = createHarness({ 'pr:down': { messages: [mkMsg('d-1')] } });
    const r2 = await drainThreads(h2.deps, state, [mkThread('pr:down', 1)]);
    expect(r2.fetchFailures).toBe(0);
    expect(h2.fetchArgs[0]).toMatchObject({ markRead: false });
    expect(h2.ackArgs).toHaveLength(1);
  });
});

describe('drainThreads — summary accumulation and drain proof', () => {
  it('accumulates skips across polls and emits ONE summary only at provable drain', async () => {
    const state = createThreadDrainState();

    // Poll 1: skips reported AND ceiling hit → summary must wait.
    const h1 = createHarness({
      'pr:a': {
        messages: Array.from({ length: 110 }, (_, i) => mkMsg(`p1-${i}`)),
        skipped: 30,
      },
    });
    await drainThreads(h1.deps, state, [mkThread('pr:a', 110)]);
    expect(state.summarySent).toBe(false);
    expect(state.skippedTotal).toBe(30);

    // Poll 2: more skips on another thread, drained cleanly → ONE summary
    // covering BOTH polls (30 + 5 = 35).
    const h2 = createHarness({ 'pr:b': { messages: [mkMsg('p2-1')], skipped: 5 } });
    await drainThreads(h2.deps, state, [mkThread('pr:b', 1)]);
    expect(state.summarySent).toBe(true);
    const summary = h2.notifications.find((n) => n.content.includes('cold-start guard'));
    expect(summary).toBeDefined();
    expect(summary!.content).toContain('35 older unread message(s)');
    expect(summary!.content).toContain('2 thread(s)');

    // Poll 3: no second summary.
    const h3 = createHarness({ 'pr:c': { messages: [mkMsg('p3-1')], skipped: 2 } });
    await drainThreads(h3.deps, state, [mkThread('pr:c', 1)]);
    expect(h3.notifications.filter((n) => n.content.includes('cold-start guard'))).toHaveLength(0);
  });

  it('a truncated thread page (paginated unread threads) suppresses the summary', async () => {
    const state = createThreadDrainState();
    const h1 = createHarness({ 'pr:a': { messages: [mkMsg('t-1')], skipped: 3 } });
    await drainThreads(h1.deps, state, [mkThread('pr:a', 1)], { moreThreadsPending: true });
    // Page was quiet but MORE THREADS EXIST — not drain proof.
    expect(state.summarySent).toBe(false);

    const h2 = createHarness({ 'pr:a': { messages: [] } });
    await drainThreads(h2.deps, state, [], { moreThreadsPending: false });
    expect(state.summarySent).toBe(true);
  });
});
