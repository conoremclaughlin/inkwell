import { describe, it, expect } from 'vitest';
import {
  watchMessages,
  WAIT_PAGE_SIZE,
  type MessageWaitOptions,
  type WaitClock,
  type WaitToolCall,
} from './wait-watch.js';

// ── Fixtures ──
//
// The fakes below follow the server contract read from
// packages/api/src/mcp/tools/thread-handlers.ts and inbox-handlers.ts:
// cursors and `newerThan`/`since` are strict (created_at >), cursor pages come
// back oldest-first, `latestN` returns the newest N with `skippedOlderCount`,
// and get_inbox selects oldest-first for status 'unread' and newest-first
// otherwise, displaying newest-first either way.

const BASE = Date.UTC(2026, 8, 30, 0, 0, 0);
/** A server timestamp `ms` after the virtual epoch. One format, so string order is time order. */
const stamp = (ms: number) => new Date(BASE + ms).toISOString();

interface Msg {
  id: string;
  createdAt: string;
  senderSlug: string;
  content: string;
}

type Event = [atMs: number, run: () => void];

function virtualClock(events: Event[] = [], random = 0.5) {
  let now = 0;
  const sleeps: number[] = [];
  const queue = [...events].sort((a, b) => a[0] - b[0]);
  const clock: WaitClock = {
    now: () => now,
    random: () => random,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      if (signal.aborted) return;
      now += ms;
      while (queue.length > 0 && queue[0][0] <= now) queue.shift()![1]();
    },
  };
  return { clock, sleeps, now: () => now };
}

function capture() {
  const batches: string[][] = [];
  const status: string[] = [];
  const errors: string[] = [];
  return {
    batches,
    status,
    errors,
    output: {
      batch: (lines: string[]) => batches.push(lines),
      status: (line: string) => status.push(line),
      error: (line: string) => errors.push(line),
    },
  };
}

function threadServer(threadKey = 'pr:1', exists = true) {
  const messages: Msg[] = [];
  const calls: Array<{ tool: string; args: Record<string, unknown>; at: number }> = [];
  const faults: Array<string | undefined> = [];
  let seq = 0;
  let threadExists = exists;
  let clockNow = () => 0;

  const post = (senderSlug: string, content: string, atMs: number) => {
    threadExists = true;
    seq += 1;
    messages.push({ id: `m-${seq}`, createdAt: stamp(atMs), senderSlug, content });
  };

  const call: WaitToolCall = async (tool, args) => {
    calls.push({ tool, args, at: clockNow() });
    if (tool !== 'get_thread_messages') throw new Error(`unexpected tool ${tool}`);
    // A watcher that falls back to the read pointer races push delivery.
    if (args.fullHistory !== true || args.markRead !== false) {
      throw new Error('watcher must read with fullHistory: true and markRead: false');
    }
    if (args.threadKey !== threadKey)
      throw new Error(`unexpected thread ${String(args.threadKey)}`);
    const fault = faults.shift();
    if (fault) throw new Error(fault);
    if (!threadExists) return { success: false, error: `Thread not found: ${threadKey}` };

    let pool = [...messages].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    if (typeof args.afterMessageId === 'string') {
      const cursor = messages.find((m) => m.id === args.afterMessageId);
      if (cursor) pool = pool.filter((m) => m.createdAt > cursor.createdAt);
    }
    if (typeof args.newerThan === 'string') {
      const floor = args.newerThan;
      pool = pool.filter((m) => m.createdAt > floor);
    }
    const limit = Math.min(Number(args.limit ?? 50), Number(args.latestN ?? Infinity));
    if (args.latestN !== undefined) {
      const page = pool.slice(-limit);
      const skipped = pool.length - page.length;
      return {
        success: true,
        messages: page,
        ...(skipped > 0 ? { skippedOlderCount: skipped } : {}),
      };
    }
    return { success: true, messages: pool.slice(0, limit) };
  };

  return {
    messages,
    calls,
    faults,
    post,
    call,
    bindClock: (now: () => number) => {
      clockNow = now;
    },
  };
}

const ONE_SHOT: MessageWaitOptions = {
  email: 'user@example.com',
  sbSlug: 'wren',
  threadKey: 'pr:1',
  pending: false,
  follow: false,
  timeoutSec: 300,
  intervalSec: 15,
};
const FOLLOW: MessageWaitOptions = { ...ONE_SHOT, follow: true, timeoutSec: undefined };

function run(
  opts: MessageWaitOptions,
  call: WaitToolCall,
  clock: WaitClock,
  controller = new AbortController()
) {
  const out = capture();
  const done = watchMessages(opts, {
    call,
    clock,
    output: out.output,
    signal: controller.signal,
  });
  return { out, done, controller };
}

/** The message lines of a batch, without its header. */
const bodyOf = (batch: string[]) => batch.slice(1);

// ── Thread mode ──

describe('ink wait: thread, one-shot (default)', () => {
  it('anchors on the true end of a long thread and exits 0 on the first reply from someone else', async () => {
    const server = threadServer();
    for (let i = 1; i <= 250; i++)
      server.post(i % 2 ? 'lumen' : 'wren', `old ${i}`, -1_000_000 + i);
    const { clock } = virtualClock([
      [20_000, () => server.post('wren', 'my own note', 20_000)],
      [40_000, () => server.post('lumen', 'the reply', 40_000)],
    ]);
    const { out, done } = run(ONE_SHOT, server.call, clock);

    expect(await done).toBe(0);
    expect(out.batches).toEqual([
      ['[ink wait] 1 new message(s) on pr:1', '  from lumen: the reply'],
    ]);
    expect(out.status).toContain('[ink wait] Baseline: 250 messages in thread (anchor: m-250)');
  });

  it('wakes on a reply queued behind more than a page of its own messages', async () => {
    const server = threadServer();
    server.post('lumen', 'review request', -5_000);
    const { clock } = virtualClock([
      [
        10_000,
        () => {
          for (let i = 0; i < WAIT_PAGE_SIZE + 10; i++)
            server.post('wren', `note ${i}`, 10_000 + i);
          server.post('lumen', 'LGTM', 12_000);
        },
      ],
    ]);
    const { out, done } = run(ONE_SHOT, server.call, clock);

    expect(await done).toBe(0);
    expect(out.batches).toEqual([['[ink wait] 1 new message(s) on pr:1', '  from lumen: LGTM']]);
  });

  it('times out with exit 1 and the same report when nothing arrives, without overshooting', async () => {
    const server = threadServer();
    server.post('lumen', 'hello', -1_000);
    const { clock, now } = virtualClock();
    const { out, done } = run({ ...ONE_SHOT, timeoutSec: 40 }, server.call, clock);

    expect(await done).toBe(1);
    expect(out.batches).toEqual([]);
    expect(out.errors).toEqual(['[ink wait] Timed out after 40s with no new messages.']);
    expect(out.status).toContain('[ink wait] No new messages yet...');
    expect(now()).toBe(40_000);
  });
});

describe('ink wait: thread, --follow', () => {
  it('reports successive batches, each message exactly once, and never its own', async () => {
    const server = threadServer();
    server.post('lumen', 'before', -3_000);
    server.post('wren', 'also before', -2_000);
    const controller = new AbortController();
    const { clock } = virtualClock([
      [20_000, () => server.post('lumen', 'A', 20_000)],
      [
        50_000,
        () => {
          server.post('wren', 'mine', 50_000);
          server.post('lumen', 'B', 50_001);
          server.post('myra', 'C', 50_002);
        },
      ],
      [200_000, () => controller.abort('SIGINT')],
    ]);
    const { out, done } = run(FOLLOW, server.call, clock, controller);

    expect(await done).toBe(130);
    expect(out.batches).toEqual([
      ['[ink wait] 1 new message(s) on pr:1', '  from lumen: A'],
      ['[ink wait] 2 new message(s) on pr:1', '  from lumen: B', '  from myra: C'],
    ]);
    expect(out.status[out.status.length - 1]).toBe('[ink wait] Stopped by SIGINT.');
    // Quiet polls say nothing: in follow mode every line written is an event.
    expect(out.status.some((line) => line.includes('No new messages yet'))).toBe(false);
  });

  it('drains a burst larger than one page into one batch, in order, without gaps', async () => {
    const server = threadServer();
    server.post('lumen', 'before', -1_000);
    const controller = new AbortController();
    const burst = WAIT_PAGE_SIZE * 2 + 20;
    const { clock } = virtualClock([
      [
        10_000,
        () => {
          for (let i = 1; i <= burst; i++) server.post('lumen', `m${i}`, 10_000 + i);
        },
      ],
      [60_000, () => controller.abort('SIGINT')],
    ]);
    const { out, done } = run(FOLLOW, server.call, clock, controller);

    expect(await done).toBe(130);
    expect(out.batches).toHaveLength(1);
    expect(bodyOf(out.batches[0])).toEqual(
      Array.from({ length: burst }, (_, i) => `  from lumen: m${i + 1}`)
    );
  });

  it('loses and repeats nothing when a read fails midway through a drain', async () => {
    const server = threadServer();
    server.post('lumen', 'before', -1_000);
    const controller = new AbortController();
    const burst = WAIT_PAGE_SIZE * 2 + 20;
    const { clock } = virtualClock([
      [
        10_000,
        () => {
          for (let i = 1; i <= burst; i++) server.post('lumen', `m${i}`, 10_000 + i);
          // The next poll reads page 1, then fails on page 2.
          server.faults.push(undefined, 'socket hang up');
        },
      ],
      [200_000, () => controller.abort('SIGINT')],
    ]);
    const { out, done } = run(FOLLOW, server.call, clock, controller);

    expect(await done).toBe(130);
    expect(out.batches).toHaveLength(1);
    expect(bodyOf(out.batches[0])).toEqual(
      Array.from({ length: burst }, (_, i) => `  from lumen: m${i + 1}`)
    );
    expect(out.status.some((line) => line.includes('Poll error #1'))).toBe(true);
  });

  it('with --timeout, stops exactly at the deadline: 0 after a batch, 1 without one', async () => {
    const withBatch = threadServer();
    const a = virtualClock([[20_000, () => withBatch.post('lumen', 'A', 20_000)]]);
    const first = run({ ...FOLLOW, timeoutSec: 60 }, withBatch.call, a.clock);
    expect(await first.done).toBe(0);
    expect(first.out.batches).toHaveLength(1);
    expect(first.out.status[first.out.status.length - 1]).toBe(
      '[ink wait] Deadline of 60s reached; 1 batch(es) delivered.'
    );
    expect(a.now()).toBe(60_000);

    const quiet = threadServer();
    const b = virtualClock();
    const second = run({ ...FOLLOW, timeoutSec: 60 }, quiet.call, b.clock);
    expect(await second.done).toBe(1);
    expect(second.out.errors).toEqual(['[ink wait] Timed out after 60s with no new messages.']);
    expect(b.now()).toBe(60_000);
  });

  it('SIGTERM during a sleep returns 143 and makes no further calls', async () => {
    const server = threadServer();
    const controller = new AbortController();
    const { clock, now } = virtualClock([[25_000, () => controller.abort('SIGTERM')]]);
    server.bindClock(now);
    const { done } = run(FOLLOW, server.call, clock, controller);

    expect(await done).toBe(143);
    expect(server.calls.every((c) => c.at < 25_000)).toBe(true);
  });

  it('abandons a call still in flight when cancelled', async () => {
    const controller = new AbortController();
    let calls = 0;
    const call: WaitToolCall = (tool, args) => {
      calls += 1;
      if (calls === 1) return threadServer().call(tool, args); // baseline
      queueMicrotask(() => controller.abort('SIGINT'));
      return new Promise(() => {}); // a fetch that never settles
    };
    const { clock } = virtualClock();
    const { done } = run(FOLLOW, call, clock, controller);

    expect(await done).toBe(130);
  });

  it('backs off on repeated failures with a bounded delay, never below the interval, and recovers', async () => {
    const server = threadServer();
    const controller = new AbortController();
    const failures = 8;
    const { clock, sleeps } = virtualClock([[3_000_000, () => controller.abort('SIGINT')]]);
    const call: WaitToolCall = async (tool, args) => {
      const polls = server.calls.length;
      const result = await server.call(tool, args);
      if (polls >= 1 && polls <= failures) throw new Error('503 Service Unavailable');
      return result;
    };
    const { done } = run(FOLLOW, call, clock, controller);
    expect(await done).toBe(130);

    // random() = 0.5 → 75% of min(cap, interval · 2^n), floored at the interval.
    expect(sleeps.slice(0, failures + 2)).toEqual([
      15_000, // after the baseline
      22_500,
      45_000,
      90_000,
      90_000,
      90_000,
      90_000,
      90_000,
      90_000,
      15_000, // first success resets
    ]);
    expect(sleeps.every((ms) => ms >= 15_000 && ms <= 120_000)).toBe(true);
  });

  it('never backs off below a long interval', async () => {
    const server = threadServer();
    const controller = new AbortController();
    const { clock, sleeps } = virtualClock([[5_000_000, () => controller.abort('SIGINT')]], 0);
    const call: WaitToolCall = async (tool, args) => {
      const polls = server.calls.length;
      const result = await server.call(tool, args);
      if (polls >= 1) throw new Error('503 Service Unavailable');
      return result;
    };
    const { done } = run({ ...FOLLOW, intervalSec: 300 }, call, clock, controller);
    expect(await done).toBe(130);
    expect(sleeps.length).toBeGreaterThan(3);
    expect(sleeps.every((ms) => ms >= 300_000)).toBe(true);
  });

  it('retries a failed baseline instead of assuming the thread was empty', async () => {
    const server = threadServer();
    for (let i = 1; i <= 5; i++) server.post('lumen', `old ${i}`, -10_000 + i);
    server.faults.push('fetch failed');
    const controller = new AbortController();
    const { clock } = virtualClock([
      [60_000, () => server.post('lumen', 'new', 60_000)],
      [120_000, () => controller.abort('SIGINT')],
    ]);
    const { out, done } = run(FOLLOW, server.call, clock, controller);

    expect(await done).toBe(130);
    expect(out.batches).toEqual([['[ink wait] 1 new message(s) on pr:1', '  from lumen: new']]);
    expect(out.status.some((line) => line.includes('Baseline error #1'))).toBe(true);
  });

  it('watches a thread that does not exist yet from its first message', async () => {
    const server = threadServer('pr:9', false);
    const controller = new AbortController();
    const { clock } = virtualClock([
      [20_000, () => server.post('lumen', 'opening message', 20_000)],
      [60_000, () => controller.abort('SIGINT')],
    ]);
    const { out, done } = run({ ...FOLLOW, threadKey: 'pr:9' }, server.call, clock, controller);

    expect(await done).toBe(130);
    expect(out.batches).toEqual([
      ['[ink wait] 1 new message(s) on pr:9', '  from lumen: opening message'],
    ]);
  });
});

// ── Pending queue ──

describe('ink wait --pending', () => {
  it('does not let a failing pending check stop the thread watch, and reports it once', async () => {
    const server = threadServer();
    const { clock } = virtualClock([[50_000, () => server.post('lumen', 'reply', 50_000)]]);
    const call: WaitToolCall = async (tool, args) => {
      if (tool === 'get_pending_messages') {
        throw new Error('Inkwell tool call failed: Input validation error: channel');
      }
      return server.call(tool, args);
    };
    const { out, done } = run({ ...ONE_SHOT, pending: true }, call, clock);

    expect(await done).toBe(0);
    expect(out.batches).toEqual([['[ink wait] 1 new message(s) on pr:1', '  from lumen: reply']]);
    expect(out.status.filter((line) => line.includes('--pending check failed'))).toHaveLength(1);
  });

  it('in follow mode reports a pending entry once though the server keeps returning it', async () => {
    const server = threadServer();
    const controller = new AbortController();
    const marked: unknown[] = [];
    let queued = false;
    const { clock } = virtualClock([
      [20_000, () => (queued = true)],
      [120_000, () => controller.abort('SIGINT')],
    ]);
    const call: WaitToolCall = async (tool, args) => {
      if (tool === 'get_pending_messages') {
        // The queue keeps entries after they are marked read.
        const messages = queued
          ? [{ id: 'p-1', timestamp: stamp(-1), sender: { id: 'lumen' }, content: 'wake up' }]
          : [];
        return { success: true, messages };
      }
      if (tool === 'mark_messages_read') {
        marked.push(args.messageIds);
        return { success: true };
      }
      return server.call(tool, args);
    };
    // Pending timestamps are compared with the watcher's own start stamp.
    const { out, done } = run({ ...FOLLOW, pending: true }, call, clock, controller);

    expect(await done).toBe(130);
    expect(out.batches).toEqual([
      ['[ink wait] 1 pending trigger message(s) found', '  from lumen: wake up'],
    ]);
    expect(marked).toEqual([['p-1']]);
  });
});

// ── Inbox mode ──

interface ThreadState {
  messages: Array<{ senderSlug: string; createdAt: string; content: string }>;
  lastReadAt?: string;
}

function inboxServer() {
  const legacy: Msg[] = [];
  let pointer: string | undefined;
  const threads = new Map<string, ThreadState>();
  let seq = 0;

  const unreadLegacy = () => legacy.filter((m) => !pointer || m.createdAt > pointer);
  const threadUnread = (t: ThreadState) =>
    t.messages.filter((m) => !t.lastReadAt || m.createdAt > t.lastReadAt).length;

  const call: WaitToolCall = async (tool, args) => {
    if (tool !== 'get_inbox') throw new Error(`unexpected tool ${tool}`);
    if (args.markRead !== false) throw new Error('watcher must not drain the inbox');
    const since = typeof args.since === 'string' ? args.since : undefined;
    const limit = Number(args.limit ?? 20);
    const byTime = (a: Msg, b: Msg) => (a.createdAt < b.createdAt ? -1 : 1);
    let messages: Msg[];
    if (args.status === 'unread') {
      messages = unreadLegacy()
        .filter((m) => !since || m.createdAt > since)
        .sort(byTime)
        .slice(0, limit)
        .reverse();
    } else {
      messages = legacy
        .filter((m) => !since || m.createdAt > since)
        .sort(byTime)
        .reverse()
        .slice(0, limit);
    }
    const threadsWithUnread = [...threads.entries()]
      .map(([threadKey, t]) => ({
        threadKey,
        unreadCount: threadUnread(t),
        lastMessageAt: t.messages[t.messages.length - 1]?.createdAt ?? null,
        previewMessages: t.messages.slice(-3),
      }))
      .filter((t) => t.unreadCount > 0);
    const threadUnreadCount = threadsWithUnread.reduce((sum, t) => sum + t.unreadCount, 0);
    return {
      success: true,
      unreadCount: unreadLegacy().length,
      threadUnreadCount,
      totalUnreadCount: unreadLegacy().length + threadUnreadCount,
      messages,
      threadsWithUnread,
    };
  };

  return {
    call,
    deliver(senderSlug: string, content: string, atMs: number) {
      seq += 1;
      legacy.push({ id: `i-${seq}`, createdAt: stamp(atMs), senderSlug, content });
    },
    readThrough(atMs: number) {
      pointer = stamp(atMs);
    },
    /**
     * send_to_inbox advances the sender's own read pointer through its post,
     * except when an SB addresses another of its own sessions or studios
     * (`selfTargeted`), where the target's delivery must still see it unread.
     */
    postToThread(
      threadKey: string,
      senderSlug: string,
      content: string,
      atMs: number,
      selfTargeted = false
    ) {
      const t = threads.get(threadKey) ?? { messages: [] };
      t.messages.push({ senderSlug, content, createdAt: stamp(atMs) });
      if (senderSlug === 'wren' && !selfTargeted) t.lastReadAt = stamp(atMs);
      threads.set(threadKey, t);
    },
  };
}

const INBOX_ONE_SHOT: MessageWaitOptions = { ...ONE_SHOT, threadKey: undefined };
const INBOX_FOLLOW: MessageWaitOptions = { ...FOLLOW, threadKey: undefined };

describe('ink wait: inbox', () => {
  it('one-shot exits when the unread total rises above the baseline', async () => {
    const server = inboxServer();
    server.deliver('lumen', 'old 1', -2_000);
    server.deliver('lumen', 'old 2', -1_000);
    const { clock } = virtualClock([[20_000, () => server.deliver('myra', 'new', 20_000)]]);
    const { out, done } = run(INBOX_ONE_SHOT, server.call, clock);

    expect(await done).toBe(0);
    expect(out.batches[0][0]).toBe('[ink wait] 1 new unread message(s)');
    expect(out.status).toContain('[ink wait] Baseline: 2 unread');
  });

  // The reason follow mode does not reuse the count: a read and an arrival in
  // the same interval cancel out.
  const readAndArrival = (server: ReturnType<typeof inboxServer>): Event => [
    20_000,
    () => {
      server.readThrough(-1);
      server.deliver('myra', 'new', 20_000);
    },
  ];

  it('(control) the one-shot unread count cannot see an arrival that a read cancels out', async () => {
    const server = inboxServer();
    server.deliver('lumen', 'old', -1_000);
    const { clock } = virtualClock([readAndArrival(server)]);
    const { done } = run({ ...INBOX_ONE_SHOT, timeoutSec: 60 }, server.call, clock);
    expect(await done).toBe(1);
  });

  it('follow reports that arrival anyway', async () => {
    const server = inboxServer();
    server.deliver('lumen', 'old', -1_000);
    const controller = new AbortController();
    const { clock } = virtualClock([
      readAndArrival(server),
      [60_000, () => controller.abort('SIGINT')],
    ]);
    const { out, done } = run(INBOX_FOLLOW, server.call, clock, controller);

    expect(await done).toBe(130);
    expect(out.batches).toEqual([
      [
        '[ink wait] New unread: 1 inbox message(s), 0 thread(s) with new activity',
        '  inbox: from myra: new',
      ],
    ]);
  });

  it('follow never reports the unread backlog present at baseline, however long', async () => {
    const server = inboxServer();
    for (let i = 1; i <= WAIT_PAGE_SIZE + 20; i++)
      server.deliver('lumen', `old ${i}`, -100_000 + i);
    const controller = new AbortController();
    const { clock } = virtualClock([
      [20_000, () => server.deliver('myra', 'new', 20_000)],
      [60_000, () => controller.abort('SIGINT')],
    ]);
    const { out, done } = run(INBOX_FOLLOW, server.call, clock, controller);

    expect(await done).toBe(130);
    expect(out.batches).toHaveLength(1);
    expect(bodyOf(out.batches[0])).toEqual(['  inbox: from myra: new']);
  });

  it("follow reports new thread activity from others once, and not the watcher's own posts", async () => {
    const server = inboxServer();
    server.postToThread('pr:5', 'lumen', 'first', -2_000);
    server.postToThread('pr:5', 'lumen', 'second', -1_000);
    const controller = new AbortController();
    const { clock } = virtualClock([
      // Addressed to another of its own sessions, so the thread stays listed
      // with this post as its newest message.
      [20_000, () => server.postToThread('pr:5', 'wren', 'note to my other session', 20_000, true)],
      [40_000, () => server.postToThread('pr:5', 'lumen', 'third', 40_000)],
      [120_000, () => controller.abort('SIGINT')],
    ]);
    const { out, done } = run(INBOX_FOLLOW, server.call, clock, controller);

    expect(await done).toBe(130);
    expect(out.batches).toEqual([
      [
        '[ink wait] New unread: 0 inbox message(s), 1 thread(s) with new activity',
        '  thread pr:5: 4 unread',
        '    latest from lumen: third',
      ],
    ]);
  });
});
