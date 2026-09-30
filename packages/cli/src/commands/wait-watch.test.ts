import { describe, it, expect, vi } from 'vitest';
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
  // Timers run alongside whatever the watcher is waiting on, so they fire when
  // virtual time passes them: through a sleep, or through advance() while a
  // call is stuck. They fire a macrotask late, after a sleep that ended at the
  // same instant has resumed: two real timers due together come in no
  // guaranteed order, and this is the order that tests the watcher.
  const timers: Array<{ at: number; fire: () => void }> = [];
  const passTo = (target: number) => {
    now = target;
    while (queue.length > 0 && queue[0][0] <= now) queue.shift()![1]();
    setImmediate(() => {
      for (const timer of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.fire();
      }
    });
  };
  const clock: WaitClock = {
    now: () => now,
    random: () => random,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      if (signal.aborted) return;
      passTo(now + ms);
    },
    timer: (ms, signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const entry = { at: now + ms, fire: resolve };
        timers.push(entry);
        signal.addEventListener(
          'abort',
          () => {
            const i = timers.indexOf(entry);
            if (i >= 0) timers.splice(i, 1);
            resolve();
          },
          { once: true }
        );
      }),
  };
  return { clock, sleeps, now: () => now, advance: (ms: number) => passTo(now + ms) };
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

  it('starts no poll at or after the deadline, in either mode', async () => {
    for (const opts of [
      { ...FOLLOW, timeoutSec: 60 },
      { ...ONE_SHOT, timeoutSec: 60 },
    ]) {
      const server = threadServer();
      const { clock, now } = virtualClock();
      server.bindClock(now);
      const { done } = run(opts, server.call, clock);

      expect(await done).toBe(1);
      expect(now()).toBe(60_000);
      expect(server.calls.length).toBeGreaterThan(1);
      expect(server.calls.filter((c) => c.at >= 60_000)).toEqual([]);
    }
  });

  it('ends a call still in flight when the deadline passes, instead of waiting it out', async () => {
    const { clock, now, advance } = virtualClock();
    let calls = 0;
    const quiet = threadServer();
    const call: WaitToolCall = (tool, args) => {
      calls += 1;
      if (calls === 1) return quiet.call(tool, args); // the baseline, at 0s
      // The first poll, at 15s, hangs as a fetch with a five-minute timeout
      // can, while time runs on past the 30s deadline.
      queueMicrotask(() => advance(60_000));
      return new Promise(() => {});
    };
    const { out, done } = run({ ...FOLLOW, timeoutSec: 30 }, call, clock);

    expect(await done).toBe(1);
    expect(out.errors).toEqual(['[ink wait] Timed out after 30s with no new messages.']);
    expect(calls).toBe(2);
    expect(now()).toBe(75_000);
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
  messages: Msg[];
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

  // get_thread_messages as the server serves it: past the read pointer unless
  // fullHistory, past a strict `newerThan`, oldest-first, latestN the newest.
  const threadMessages = (args: Record<string, unknown>) => {
    if (args.markRead !== false) throw new Error('watcher must not advance a read pointer');
    const t = threads.get(String(args.threadKey));
    if (!t) return { success: false, error: `Thread not found: ${String(args.threadKey)}` };
    let pool = [...t.messages].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    if (args.fullHistory !== true && t.lastReadAt) {
      const floor = t.lastReadAt;
      pool = pool.filter((m) => m.createdAt > floor);
    }
    if (typeof args.newerThan === 'string') {
      const floor = args.newerThan;
      pool = pool.filter((m) => m.createdAt > floor);
    }
    const limit = Math.min(Number(args.limit ?? 50), Number(args.latestN ?? Infinity));
    if (args.latestN !== undefined) {
      const page = pool.slice(-limit);
      return { success: true, messages: page, skippedOlderCount: pool.length - page.length };
    }
    return { success: true, messages: pool.slice(0, limit) };
  };

  const call: WaitToolCall = async (tool, args) => {
    if (tool === 'get_thread_messages') return threadMessages(args);
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
      seq += 1;
      t.messages.push({ id: `t-${seq}`, senderSlug, content, createdAt: stamp(atMs) });
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
        '    from lumen: third',
      ],
    ]);
  });
});

// Lumen's independent review of #702 at d7e59536: each of these was red there.
// Synthetic data and an injected transport only.
describe('#702 review regressions (Lumen)', () => {
  it('thread drain does not drop siblings of a page-boundary timestamp', async () => {
    const server = threadServer();
    server.post('lumen', 'baseline', -1000);
    const { clock } = virtualClock([
      [
        10000,
        () => {
          for (let i = 0; i < WAIT_PAGE_SIZE + 1; i++) server.post('lumen', `tied ${i}`, 10000);
        },
      ],
    ]);
    const { out, done } = run({ ...FOLLOW, timeoutSec: 60 }, server.call, clock);
    await done;
    expect(out.batches.flatMap(bodyOf)).toHaveLength(WAIT_PAGE_SIZE + 1);
  });

  it('inbox since pagination does not drop siblings of a page-boundary timestamp', async () => {
    const server = inboxServer();
    server.deliver('lumen', 'baseline', -1000);
    const { clock } = virtualClock([
      [
        10000,
        () => {
          for (let i = 0; i < WAIT_PAGE_SIZE + 1; i++) server.deliver('lumen', `tied ${i}`, 10000);
        },
      ],
    ]);
    const { out, done } = run({ ...INBOX_FOLLOW, timeoutSec: 60 }, server.call, clock);
    await done;
    expect(out.batches.flatMap(bodyOf)).toHaveLength(WAIT_PAGE_SIZE + 1);
  });

  it('inbox does not lose a still-unread reply underneath three self-targeted messages', async () => {
    const server = inboxServer();
    server.postToThread('pr:5', 'lumen', 'baseline', -1000);
    const { clock } = virtualClock([
      [
        10000,
        () => {
          server.postToThread('pr:5', 'lumen', 'new reply', 10000);
          for (let i = 0; i < 3; i++)
            server.postToThread('pr:5', 'wren', `own ${i}`, 10001 + i, true);
        },
      ],
    ]);
    const { out, done } = run({ ...INBOX_FOLLOW, timeoutSec: 60 }, server.call, clock);
    await done;
    expect(out.batches.flat().join('\n')).toContain('new reply');
  });

  it('inbox does not replay a read reply when only a new self-targeted message arrives', async () => {
    const server = inboxServer();
    server.postToThread('pr:5', 'lumen', 'old already read reply', -2000);
    server.postToThread('pr:5', 'wren', 'read through this own post', -1000);
    const { clock } = virtualClock([
      [10000, () => server.postToThread('pr:5', 'wren', 'new self-targeted note', 10000, true)],
    ]);
    const { out, done } = run({ ...INBOX_FOLLOW, timeoutSec: 60 }, server.call, clock);
    await done;
    expect(out.batches).toEqual([]);
  });

  // Round two, at 1ab9e0da.
  it('does not replay history after a newly discovered thread is consumed before its first read', async () => {
    const server = inboxServer();
    server.postToThread('pr:5', 'lumen', 'old already read reply', -2000);
    server.postToThread('pr:5', 'wren', 'old own post marks read', -1000);
    let raced = false;
    const call: WaitToolCall = async (tool, args) => {
      if (tool === 'get_thread_messages' && args.fullHistory !== true && !raced) {
        raced = true;
        // Another session reads and answers between the inbox listing and this fetch.
        server.postToThread('pr:5', 'wren', 'concurrent reader', 10001);
      }
      return server.call(tool, args);
    };
    const { clock } = virtualClock([
      [
        10000,
        () => server.postToThread('pr:5', 'lumen', 'reply consumed by another session', 10000),
      ],
      [30000, () => server.postToThread('pr:5', 'lumen', 'genuinely new reply', 30000)],
    ]);
    const { out, done } = run({ ...INBOX_FOLLOW, timeoutSec: 60 }, call, clock);
    await done;
    const received = out.batches.flat().join('\n');
    expect(received).toContain('genuinely new reply');
    expect(received).not.toContain('old already read reply');
    expect(received).not.toContain('reply consumed by another session');
  });

  it('does not begin another poll once the deadline has been reached', async () => {
    const server = threadServer();
    const { clock, now } = virtualClock();
    server.bindClock(now);
    const { done } = run({ ...FOLLOW, timeoutSec: 10, intervalSec: 5 }, server.call, clock);
    await done;
    expect(server.calls.filter((c) => c.at >= 10000)).toEqual([]);
  });

  it('settles at the deadline even if an earlier poll never settles (real timers, faked)', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      let calls = 0;
      const call: WaitToolCall = async () => {
        calls++;
        if (calls === 1) return { success: true, messages: [] };
        return new Promise(() => {});
      };
      const delay = (ms: number, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true }
          );
        });
      const clock: WaitClock = {
        now: () => Date.now(),
        random: () => 0,
        sleep: delay,
        timer: delay,
      };
      let result: number | undefined;
      const { done } = run({ ...FOLLOW, timeoutSec: 10, intervalSec: 5 }, call, clock, controller);
      void done.then((code) => {
        result = code;
      });
      await vi.advanceTimersByTimeAsync(10000);
      expect(result).toBe(1);
    } finally {
      controller.abort('SIGINT');
      vi.useRealTimers();
    }
  });
});
