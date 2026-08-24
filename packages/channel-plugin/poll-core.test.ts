import { describe, expect, it, vi } from 'vitest';
import {
  createThreadDrainState,
  drainThreads,
  drainLegacyInbox,
  POLL_BUDGET,
  type PollDeps,
} from './poll-core.js';

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

    expect(h.fetchArgs[0]).toMatchObject({
      markRead: false,
      channelPoll: true,
      // System events are excluded from delivery — candidacy excludes them
      // too, so ack ranges and candidacy never drift (round 4).
      includeSystemEvents: false,
    });
    expect(h.ackArgs).toEqual([
      expect.objectContaining({ threadKey: 'pr:x', throughMessageId: 'm-3' }),
    ]);
  });

  it('cursored incremental fetch is ALSO markRead:false and acks (uniform §7 protocol)', async () => {
    const h = createHarness({ 'pr:x': { messages: [mkMsg('m-9')] } });
    const state = createThreadDrainState();
    state.lastThreadMessageId.set('pr:x', 'm-8');
    await drainThreads(h.deps, state, [mkThread('pr:x', 1)]);

    expect(h.fetchArgs[0]).toMatchObject({ markRead: false, afterMessageId: 'm-8' });
    expect(h.ackArgs).toEqual([expect.objectContaining({ throughMessageId: 'm-9' })]);
    expect(state.lastThreadMessageId.get('pr:x')).toBe('m-9');
  });

  it('ack failure holds cursors, counts against drain proof, and retries next poll', async () => {
    const state = createThreadDrainState();
    const msgs = [mkMsg('a-1'), mkMsg('a-2')];

    // Poll 1: emit succeeds but the ack write fails.
    const h1 = createHarness({ 'pr:x': { messages: msgs, skipped: 3 } });
    (h1.deps.callPcp as ReturnType<typeof vi.fn>).mockImplementation(
      async (tool: string, args: Record<string, unknown>) => {
        if (tool === 'get_thread_messages') {
          h1.fetchArgs.push(args);
          return { success: true, messages: msgs, skippedOlderCount: 3 };
        }
        if (tool === 'mark_thread_read') {
          h1.ackArgs.push(args);
          return { success: false, error: 'db write failed' };
        }
        return { success: true };
      }
    );
    const r1 = await drainThreads(h1.deps, state, [mkThread('pr:x', 2)]);
    expect(r1.ackFailures).toBe(1);
    // Cursor NOT advanced — next poll must re-fetch cold and retry the ack.
    expect(state.lastThreadMessageId.has('pr:x')).toBe(false);
    // Skips exist but ack failed → NOT drained → no summary.
    expect(state.summarySent).toBe(false);

    // Poll 2: same window re-fetched; messages dedup by seen-set (no double
    // render); the ack retries and succeeds.
    const h2 = createHarness({ 'pr:x': { messages: msgs, skipped: 3 } });
    const r2 = await drainThreads(h2.deps, state, [mkThread('pr:x', 2)]);
    expect(r2.injected).toBe(0); // seen-set: nothing re-rendered
    expect(r2.ackFailures).toBe(0);
    expect(h2.ackArgs).toEqual([expect.objectContaining({ throughMessageId: 'a-2' })]);
    expect(state.lastThreadMessageId.get('pr:x')).toBe('a-2');
    // Skip map replaced (not added): 3, not 6 — and now drained → summary.
    expect(state.summarySent).toBe(true);
    const summary = h2.notifications.find((n) => n.content.includes('cold-start guard'));
    expect(summary!.content).toContain('3 older unread message(s)');
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
    expect([...state.skippedByThread.values()].reduce((a, b) => a + b, 0)).toBe(30);

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

  it('an INCOMPLETE poll (server candidacy failure) suppresses the summary — outage is not drain', async () => {
    const state = createThreadDrainState();
    const h1 = createHarness({ 'pr:a': { messages: [mkMsg('i-1')], skipped: 2 } });
    await drainThreads(h1.deps, state, [mkThread('pr:a', 1)], { pollIncomplete: true });
    expect(state.summarySent).toBe(false);

    const h2 = createHarness({});
    await drainThreads(h2.deps, state, [], { pollIncomplete: false });
    expect(state.summarySent).toBe(true);
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

describe('drainLegacyInbox — exact-id consumption (Lumen #504 r1 P1)', () => {
  function legacyHarness(opts: { notifyFailOn?: string; ackFail?: boolean } = {}) {
    const ackArgs: Array<Record<string, unknown>> = [];
    const notifications: Array<{ content: string; meta: Record<string, unknown> }> = [];
    const deps: PollDeps = {
      callPcp: vi.fn(async (tool: string, args: Record<string, unknown>) => {
        if (tool === 'mark_inbox_read') {
          ackArgs.push(args);
          return opts.ackFail ? { success: false } : { success: true };
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
    return { deps, ackArgs, notifications };
  }

  it('acks through the last delivered message after a clean batch', async () => {
    const { deps, ackArgs, notifications } = legacyHarness();
    const seen = new Set<string>();
    // Newest-first page, as get_inbox serves it.
    const res = await drainLegacyInbox(
      deps,
      seen,
      [mkMsg('m3'), mkMsg('m2'), mkMsg('m1')].map((m, i) => ({
        ...m,
        createdAt: new Date(1700000100000 - i * 1000).toISOString(),
      })),
      () => false
    );

    expect(res.injected).toBe(3);
    expect(notifications).toHaveLength(3);
    // Delivered oldest-first; the ack is the newest processed id.
    expect(ackArgs).toHaveLength(1);
    expect(ackArgs[0]).toMatchObject({ agentId: 'wren', throughMessageId: 'm3' });
  });

  it('an emit failure stops the ack range — the newer remainder redelivers', async () => {
    const { deps, ackArgs } = legacyHarness({ notifyFailOn: 'content m2' });
    const seen = new Set<string>();
    const page = [
      { ...mkMsg('m3'), createdAt: '2026-08-16T12:00:00Z' },
      { ...mkMsg('m2'), createdAt: '2026-08-16T11:00:00Z' },
      { ...mkMsg('m1'), createdAt: '2026-08-16T10:00:00Z' },
    ];

    const res = await drainLegacyInbox(deps, seen, page, () => 'deliver' as const);

    expect(res.injected).toBe(1);
    expect(res.emitFailures).toBe(1);
    // Only m1 (older, delivered) is acked; m2/m3 stay unread for redelivery.
    expect(ackArgs[0]).toMatchObject({ throughMessageId: 'm1' });
    expect(seen.has('m2')).toBe(false);
  });

  it('deliberately skipped rows stay inside the ack range', async () => {
    const { deps, ackArgs, notifications } = legacyHarness();
    const seen = new Set<string>();
    const page = [
      { ...mkMsg('own'), senderAgentId: 'wren', createdAt: '2026-08-16T12:00:00Z' },
      { ...mkMsg('m1'), createdAt: '2026-08-16T10:00:00Z' },
    ];

    // Skip own messages (the caller-side filter).
    const res = await drainLegacyInbox(deps, seen, page, (m) =>
      m.senderAgentId === 'wren' ? 'skip' : 'deliver'
    );

    expect(res.injected).toBe(1);
    expect(notifications).toHaveLength(1);
    // The skipped OWN message is newer and still consumed — seen, not lost.
    expect(ackArgs[0]).toMatchObject({ throughMessageId: 'own' });
  });

  it('a failed ack holds the pointer and reports — next poll retries', async () => {
    const { deps, ackArgs } = legacyHarness({ ackFail: true });
    const seen = new Set<string>();

    const res = await drainLegacyInbox(deps, seen, [mkMsg('m1')], () => 'deliver' as const);

    expect(res.injected).toBe(1);
    expect(res.ackFailures).toBe(1);
    expect(ackArgs).toHaveLength(1);
    // The seen-set keeps the render deduped while the ack retries.
    expect(seen.has('m1')).toBe(true);
  });

  it('a foreign-studio row STOPS the ack range — never consumed globally', async () => {
    // mark_inbox_read advances one global (user, agent) pointer. Acking past
    // a row routed to another studio would consume mail this studio never
    // owned (Lumen #504 r2 P1). The walk stops AT the foreign row: earlier
    // own rows are acked, everything from the foreign row on redelivers.
    const { deps, ackArgs, notifications } = legacyHarness();
    const seen = new Set<string>();
    const page = [
      { ...mkMsg('mine-new'), createdAt: '2026-08-16T12:00:00Z' },
      { ...mkMsg('foreign-mid'), createdAt: '2026-08-16T11:00:00Z' },
      { ...mkMsg('mine-old'), createdAt: '2026-08-16T10:00:00Z' },
    ];

    const res = await drainLegacyInbox(deps, seen, page, (m) =>
      m.id === 'foreign-mid' ? 'foreign' : 'deliver'
    );

    expect(res.stoppedAtForeignStudio).toBe(true);
    expect(res.injected).toBe(1);
    expect(notifications.map((n) => n.meta.message_id)).toEqual(['mine-old']);
    // Ack stops BEFORE the foreign row — mine-new stays unread too
    // (contiguity: it cannot be acked without consuming foreign-mid).
    expect(ackArgs).toHaveLength(1);
    expect(ackArgs[0]).toMatchObject({ throughMessageId: 'mine-old' });
  });

  it('a leading foreign-studio row acks nothing at all', async () => {
    const { deps, ackArgs } = legacyHarness();
    const res = await drainLegacyInbox(
      deps,
      new Set<string>(),
      [{ ...mkMsg('foreign-1'), createdAt: '2026-08-16T10:00:00Z' }],
      () => 'foreign' as const
    );
    expect(res.stoppedAtForeignStudio).toBe(true);
    expect(ackArgs).toHaveLength(0);
  });

  it('a mid-tie-group emit failure acks only through the PRIOR complete group', async () => {
    // Two rows share a timestamp; the second twin's emit fails. Acking the
    // first twin would move the timestamp pointer past BOTH — the failed
    // sibling vanishes globally (Lumen #504 r3 P1). The ack must stop at the
    // previous complete created_at group.
    const { deps, ackArgs } = legacyHarness({ notifyFailOn: 'content twin-b' });
    const page = [
      { ...mkMsg('twin-b'), content: 'content twin-b', createdAt: '2026-08-16T11:00:00Z' },
      { ...mkMsg('twin-a'), content: 'content twin-a', createdAt: '2026-08-16T11:00:00Z' },
      { ...mkMsg('older'), createdAt: '2026-08-16T10:00:00Z' },
    ];

    const res = await drainLegacyInbox(deps, new Set<string>(), page, () => 'deliver' as const);

    expect(res.injected).toBe(2); // older + twin-a delivered
    expect(res.emitFailures).toBe(1);
    expect(ackArgs).toHaveLength(1);
    // NOT twin-a: its group is split. The prior complete group is 'older'.
    expect(ackArgs[0]).toMatchObject({ throughMessageId: 'older' });
  });

  it('a mid-tie-group foreign row acks only through the PRIOR complete group', async () => {
    const { deps, ackArgs } = legacyHarness();
    // ids chosen so THIS studio's twin sorts first: the walk is genuinely
    // inside the tie group when it hits the foreign sibling.
    const page = [
      { ...mkMsg('twin-z-foreign'), createdAt: '2026-08-16T11:00:00Z' },
      { ...mkMsg('twin-a-mine'), createdAt: '2026-08-16T11:00:00Z' },
      { ...mkMsg('older'), createdAt: '2026-08-16T10:00:00Z' },
    ];

    const res = await drainLegacyInbox(deps, new Set<string>(), page, (m) =>
      m.id === 'twin-z-foreign' ? 'foreign' : 'deliver'
    );

    expect(res.stoppedAtForeignStudio).toBe(true);
    expect(ackArgs).toHaveLength(1);
    expect(ackArgs[0]).toMatchObject({ throughMessageId: 'older' });
  });

  it('a fully processed tie group at the end of the batch acks through its last row', async () => {
    const { deps, ackArgs } = legacyHarness();
    const page = [
      { ...mkMsg('twin-b'), createdAt: '2026-08-16T11:00:00Z' },
      { ...mkMsg('twin-a'), createdAt: '2026-08-16T11:00:00Z' },
    ];

    const res = await drainLegacyInbox(deps, new Set<string>(), page, () => 'deliver' as const);

    expect(res.injected).toBe(2);
    // Both twins processed — the group is complete and acks through its max.
    expect(ackArgs[0]).toMatchObject({ throughMessageId: 'twin-b' });
  });

  it('an empty or fully-skipped-by-seen page still acks (retry path)', async () => {
    const { deps, ackArgs } = legacyHarness();
    const seen = new Set<string>(['m1']);

    // Previously delivered but unacked (ack failed last poll): the retry
    // must ack without re-rendering.
    const res = await drainLegacyInbox(deps, seen, [mkMsg('m1')], () => 'deliver' as const);

    expect(res.injected).toBe(0);
    expect(ackArgs[0]).toMatchObject({ throughMessageId: 'm1' });
  });
});
