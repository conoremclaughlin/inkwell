import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { sessionEventBus, type SessionStreamEvent } from './session-event-bus.js';

// Unique session ids per test keep the process-wide singleton's replay buffers
// from bleeding across cases.
let seq = 0;
const nextSession = () => `sess-${Date.now()}-${seq++}`;

describe('SessionEventBus', () => {
  beforeEach(() => {
    seq += 1000;
  });

  it('delivers published events to a session subscriber', () => {
    const sid = nextSession();
    const received: SessionStreamEvent[] = [];
    const unsub = sessionEventBus.subscribe(sid, (e) => received.push(e));

    sessionEventBus.publish(sid, 'tool_call', { toolName: 'list_emails' });
    sessionEventBus.publish(sid, 'result', { text: 'done' });

    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ sessionId: sid, type: 'tool_call' });
    expect(received[0].data).toEqual({ toolName: 'list_emails' });
    expect(received[1].type).toBe('result');
    expect(typeof received[0].ts).toBe('string');
    unsub();
  });

  it('isolates events between sessions', () => {
    const a = nextSession();
    const b = nextSession();
    const aEvents: SessionStreamEvent[] = [];
    const unsubA = sessionEventBus.subscribe(a, (e) => aEvents.push(e));

    sessionEventBus.publish(b, 'tool_call', { toolName: 'other' });

    expect(aEvents).toHaveLength(0);
    unsubA();
  });

  it('replays the recent tail to a subscriber that attaches mid-turn', () => {
    const sid = nextSession();
    // Two tool calls already ran before anyone attached.
    sessionEventBus.publish(sid, 'tool_call', { toolName: 'a' });
    sessionEventBus.publish(sid, 'tool_call', { toolName: 'b' });

    const seen: string[] = [];
    const unsub = sessionEventBus.subscribe(sid, (e) =>
      seen.push(String(e.data.toolName ?? e.type))
    );

    // Replay of the two past events happens synchronously on subscribe...
    expect(seen).toEqual(['a', 'b']);
    // ...and new events continue to stream.
    sessionEventBus.publish(sid, 'tool_call', { toolName: 'c' });
    expect(seen).toEqual(['a', 'b', 'c']);
    unsub();
  });

  it('can opt out of replay', () => {
    const sid = nextSession();
    sessionEventBus.publish(sid, 'tool_call', { toolName: 'past' });

    const seen: string[] = [];
    const unsub = sessionEventBus.subscribe(sid, (e) => seen.push(String(e.data.toolName)), {
      replay: false,
    });
    expect(seen).toEqual([]);
    sessionEventBus.publish(sid, 'tool_call', { toolName: 'future' });
    expect(seen).toEqual(['future']);
    unsub();
  });

  it('stops delivering after unsubscribe', () => {
    const sid = nextSession();
    const received: SessionStreamEvent[] = [];
    const unsub = sessionEventBus.subscribe(sid, (e) => received.push(e), { replay: false });

    sessionEventBus.publish(sid, 'a', {});
    unsub();
    sessionEventBus.publish(sid, 'b', {});

    expect(received.map((e) => e.type)).toEqual(['a']);
    expect(sessionEventBus.subscriberCount(sid)).toBe(0);
  });

  it('feeds the firehose subscriber for every session', () => {
    const a = nextSession();
    const b = nextSession();
    const all: string[] = [];
    const unsub = sessionEventBus.subscribeAll((e) => all.push(e.sessionId));

    sessionEventBus.publish(a, 'x', {});
    sessionEventBus.publish(b, 'y', {});

    expect(all).toEqual([a, b]);
    unsub();
  });

  it('ignores empty session ids', () => {
    const all: SessionStreamEvent[] = [];
    const unsub = sessionEventBus.subscribeAll((e) => all.push(e));
    sessionEventBus.publish('', 'x', {});
    expect(all).toHaveLength(0);
    unsub();
  });

  it('does not let a throwing subscriber break siblings or the publisher', () => {
    const sid = nextSession();
    const good: SessionStreamEvent[] = [];
    const unsubBad = sessionEventBus.subscribe(
      sid,
      () => {
        throw new Error('boom');
      },
      { replay: false }
    );
    const unsubGood = sessionEventBus.subscribe(sid, (e) => good.push(e), { replay: false });

    expect(() => sessionEventBus.publish(sid, 'tool_call', {})).not.toThrow();
    // EventEmitter delivers to listeners in registration order; the bad one is
    // isolated so the good one still receives the event.
    expect(good).toHaveLength(1);
    unsubBad();
    unsubGood();
  });

  // Regression for Lumen's PR #438 review: the replay tail is re-sent on every
  // (re)connect, so events need stable ids for a client to de-dupe, and the tail
  // must be turn-scoped so a finished turn never replays as if it were live.
  it('assigns unique, monotonically increasing event ids', () => {
    const sid = nextSession();
    const got: number[] = [];
    const unsub = sessionEventBus.subscribe(sid, (e) => got.push(e.id), { replay: false });

    sessionEventBus.publish(sid, 'a', {});
    sessionEventBus.publish(sid, 'b', {});

    expect(got).toHaveLength(2);
    expect(got[1]).toBeGreaterThan(got[0]);
    expect(new Set(got).size).toBe(2);
    unsub();
  });

  it('clearReplay drops the tail so a later attach replays nothing', () => {
    const sid = nextSession();
    sessionEventBus.publish(sid, 'tool_call', { toolName: 'from-finished-turn' });

    // InkRunner calls this at turn start/end.
    sessionEventBus.clearReplay(sid);

    const seen: string[] = [];
    const unsub = sessionEventBus.subscribe(sid, (e) => seen.push(e.type));
    // Nothing stale replayed...
    expect(seen).toEqual([]);
    // ...but the session still streams new events normally.
    sessionEventBus.publish(sid, 'tool_call', { toolName: 'new-turn' });
    expect(seen).toEqual(['tool_call']);
    unsub();
  });
});

/**
 * Observer-attach channel (spec:observer-attach M2) — canonical ledger
 * entries keyed by ledger eid, durable replay, atomic cutover, and the
 * overflow-DISCONNECT policy (never skip-ahead). Contracts from Lumen's
 * v2 review, ported from the standalone draft suite.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach } from 'vitest';
import {
  SessionEventBus as _BusForType,
  type ObserverEntry,
  type ObserverSink,
  type ObserverSinkEndReason,
  OBS_QUEUE_MAX_EVENTS,
  OBS_QUEUE_MAX_BYTES,
  OBS_MAX_SUBSCRIBERS,
} from './session-event-bus.js';

const obsEntry = (eid: number, type = 'backend_tool', extra: Record<string, unknown> = {}) =>
  ({
    eid,
    ts: `2026-08-07T00:00:${String(eid).padStart(2, '0')}.000Z`,
    type,
    ...extra,
  }) as ObserverEntry;

/** A test sink with controllable backpressure. */
class TestSink implements ObserverSink {
  received: ObserverEntry[] = [];
  endedWith: ObserverSinkEndReason | null = null;
  blocked = false;
  private drainWaiters: Array<() => void> = [];

  write(e: ObserverEntry): boolean {
    this.received.push(e);
    return !this.blocked;
  }
  waitDrain(): Promise<void> {
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }
  end(reason: ObserverSinkEndReason): void {
    this.endedWith = reason;
  }
  release(): void {
    this.blocked = false;
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const w of waiters) w();
  }
}

describe('SessionEventBus observer channel', () => {
  let bus: InstanceType<typeof _BusForType>;
  let dir: string;

  beforeEach(() => {
    bus = new _BusForType();
    dir = mkdtempSync(join(tmpdir(), 'obs-bus-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeLedger(entries: ObserverEntry[]): string {
    const replDir = join(dir, '.ink', 'runtime', 'repl');
    mkdirSync(replDir, { recursive: true });
    const path = join(replDir, 'sess-1-123.jsonl');
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return path;
  }

  it('fans out published entries to multiple observers in order', async () => {
    const a = new TestSink();
    const b = new TestSink();
    await bus.subscribeObserver('s1', a);
    await bus.subscribeObserver('s1', b);

    bus.publishObserverEntry('s1', obsEntry(1));
    bus.publishObserverEntry('s1', obsEntry(2));
    await new Promise((r) => setImmediate(r));

    expect(a.received.map((e) => e.eid)).toEqual([1, 2]);
    expect(b.received.map((e) => e.eid)).toEqual([1, 2]);
  });

  it('afterEid is exclusive — replay begins at eid > cursor', async () => {
    for (let i = 1; i <= 5; i++) bus.publishObserverEntry('s1', obsEntry(i));
    const sink = new TestSink();
    await bus.subscribeObserver('s1', sink, { afterEid: 3 });
    expect(sink.received.map((e) => e.eid)).toEqual([4, 5]);
  });

  it('default attach (no cursor) replays the ring only', async () => {
    const path = writeLedger([obsEntry(1), obsEntry(2)]);
    bus.registerLedgerPath('s1', path);
    bus.publishObserverEntry('s1', obsEntry(3)); // only eid 3 is in the ring
    const sink = new TestSink();
    await bus.subscribeObserver('s1', sink);
    expect(sink.received.map((e) => e.eid)).toEqual([3]);
  });

  it('backfills from the ledger when the cursor precedes the ring', async () => {
    const path = writeLedger([obsEntry(1), obsEntry(2), obsEntry(3), obsEntry(4)]);
    bus.registerLedgerPath('s1', path);
    bus.publishObserverEntry('s1', obsEntry(3));
    bus.publishObserverEntry('s1', obsEntry(4));

    const sink = new TestSink();
    await bus.subscribeObserver('s1', sink, { afterEid: 1 });
    expect(sink.received.map((e) => e.eid)).toEqual([2, 3, 4]);
  });

  it('CUTOVER RACE: entries published during disk replay arrive gapless and duplicate-free', async () => {
    const ledgerEntries = Array.from({ length: 40 }, (_, i) => obsEntry(i + 1));
    const path = writeLedger(ledgerEntries);
    bus.registerLedgerPath('s1', path);
    for (let i = 35; i <= 40; i++) bus.publishObserverEntry('s1', obsEntry(i));

    const sink = new TestSink();
    const subscribing = bus.subscribeObserver('s1', sink, { afterEid: 0 });
    for (let i = 41; i <= 45; i++) bus.publishObserverEntry('s1', obsEntry(i));
    await subscribing;
    bus.publishObserverEntry('s1', obsEntry(46));
    await new Promise((r) => setImmediate(r));

    const eids = sink.received.map((e) => e.eid);
    expect(eids).toEqual(Array.from({ length: 46 }, (_, i) => i + 1));
  });

  it('overflow DISCONNECTS the observer — it never skips ahead', async () => {
    const sink = new TestSink();
    await bus.subscribeObserver('s1', sink);
    sink.blocked = true;

    for (let i = 1; i <= OBS_QUEUE_MAX_EVENTS + 3; i++) {
      bus.publishObserverEntry('s1', obsEntry(i));
    }
    await new Promise((r) => setImmediate(r));

    expect(sink.endedWith).toBe('overflow');
    const eids = sink.received.map((e) => e.eid);
    expect(eids).toEqual(Array.from({ length: eids.length }, (_, i) => i + 1));
  });

  it('projection bounds entry size at ingest (byte cap remains defense-in-depth)', async () => {
    // Since M4.2, projection truncates previews/content at ingest, so a
    // hostile mega-entry cannot bloat queues — the byte cap (OBS_QUEUE_MAX_BYTES)
    // stays as a backstop for pathological cases rather than the primary bound.
    const sink = new TestSink();
    await bus.subscribeObserver('s1', sink);

    const big = 'x'.repeat(Math.ceil(OBS_QUEUE_MAX_BYTES / 4));
    bus.publishObserverEntry('s1', obsEntry(1, 'backend_text', { preview: big }));
    await new Promise((r) => setImmediate(r));

    expect(sink.received).toHaveLength(1);
    expect(String(sink.received[0].preview).length).toBeLessThanOrEqual(200);
  });

  it('publishObserverEntry never blocks on a stalled observer', async () => {
    const sink = new TestSink();
    await bus.subscribeObserver('s1', sink);
    sink.blocked = true;

    const start = performance.now();
    for (let i = 1; i <= 10; i++) bus.publishObserverEntry('s1', obsEntry(i));
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('enforces the per-session observer cap', async () => {
    for (let i = 0; i < OBS_MAX_SUBSCRIBERS; i++) {
      await bus.subscribeObserver('s1', new TestSink());
    }
    const overflowSink = new TestSink();
    await expect(bus.subscribeObserver('s1', overflowSink)).rejects.toThrow(/limit/i);
    expect(overflowSink.endedWith).toBe('replay_failed');
  });

  it('filters non-projection types at ingest and replay', async () => {
    // The ledger is always a superset of the ring: the runtime appends
    // synchronously BEFORE emitting the obs line.
    const path = writeLedger([
      obsEntry(1, 'user', { content: 'hi' }),
      obsEntry(2, 'hook_injection', { content: 'internal' }),
      obsEntry(3, 'delegation_send', { secret: 'never' }),
      obsEntry(4, 'assistant', { content: 'hello' }),
      obsEntry(6, 'backend_tool'),
    ]);
    bus.registerLedgerPath('s1', path);
    bus.publishObserverEntry('s1', obsEntry(5, 'activity')); // ignored at ingest
    bus.publishObserverEntry('s1', obsEntry(6, 'backend_tool'));

    const sink = new TestSink();
    await bus.subscribeObserver('s1', sink, { afterEid: 0 });
    expect(sink.received.map((e) => e.eid)).toEqual([1, 4, 6]);
  });

  it('fails the subscription when the cursor precedes the ring and no ledger is registered', async () => {
    bus.publishObserverEntry('s1', obsEntry(10));
    const sink = new TestSink();
    await expect(bus.subscribeObserver('s1', sink, { afterEid: 2 })).rejects.toThrow(/ledger/i);
    expect(sink.endedWith).toBe('replay_failed');
  });

  it('rejects relative, non-jsonl, and out-of-tree ledger paths', async () => {
    bus.registerLedgerPath('s1', 'relative/path.jsonl');
    bus.registerLedgerPath('s1', join(dir, '.ink', 'runtime', 'repl', 'not-jsonl.txt'));
    bus.registerLedgerPath('s1', join(dir, 'outside', 'evil.jsonl'));
    bus.publishObserverEntry('s1', obsEntry(5));
    const sink = new TestSink();
    await expect(bus.subscribeObserver('s1', sink, { afterEid: 1 })).rejects.toThrow(/ledger/i);
  });

  it('follow=false replays then ends without following', async () => {
    for (let i = 1; i <= 3; i++) bus.publishObserverEntry('s1', obsEntry(i));
    const sink = new TestSink();
    await bus.subscribeObserver('s1', sink, { afterEid: 0, follow: false });
    bus.publishObserverEntry('s1', obsEntry(4));
    await new Promise((r) => setImmediate(r));

    expect(sink.received.map((e) => e.eid)).toEqual([1, 2, 3]);
    expect(sink.endedWith).toBe('unsubscribed');
  });
});

/**
 * M4.2 (Lumen re-review blockers): projection security boundary, monotonic
 * delivery guard, durable locator recovery, cross-turn subscriber retention.
 */
import { projectObserverEntry, type LedgerLocatorStore } from './session-event-bus.js';

describe('SessionEventBus observer channel — M4.2', () => {
  let bus: InstanceType<typeof _BusForType>;
  let dir: string;

  beforeEach(() => {
    bus = new _BusForType();
    dir = mkdtempSync(join(tmpdir(), 'obs-m42-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeLedger42(entries: Record<string, unknown>[]): string {
    const replDir = join(dir, '.ink', 'runtime', 'repl');
    mkdirSync(replDir, { recursive: true });
    const path = join(replDir, 'sess-1-123.jsonl');
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return path;
  }

  it('SECURITY: secret-bearing fields never cross the wire, at ingest or replay', async () => {
    const secretLedger = writeLedger42([
      {
        eid: 1,
        ts: 't',
        type: 'pcp_tool',
        tool: 'send_to_inbox',
        status: 'done',
        args: { content: 'SECRET_ARGS' },
        result: { token: 'SECRET_RESULT' },
      },
      {
        eid: 2,
        ts: 't',
        type: 'inbox',
        sender: 'myra',
        content: 'hello',
        delegationToken: 'SECRET_DELEGATION',
      },
      {
        eid: 3,
        ts: 't',
        type: 'assistant',
        content: 'fine reply',
        rawContent: 'SECRET_RAW',
        stderr: 'SECRET_STDERR',
      },
      // Ledger-superset invariant: the live entry below exists here too.
      {
        eid: 4,
        ts: 't',
        type: 'local_tool_call',
        tool: 'save_link',
        status: 'running',
        args: { url: 'SECRET_LIVE_ARGS' },
      },
    ]);
    bus.registerLedgerPath('s1', secretLedger);
    // Ring copy of the dirty entry (published before attach).
    bus.publishObserverEntry('s1', {
      eid: 4,
      ts: 't',
      type: 'local_tool_call',
      tool: 'save_link',
      status: 'running',
      args: { url: 'SECRET_LIVE_ARGS' },
    } as never);

    const sink = new TestSink();
    await bus.subscribeObserver('s1', sink, { afterEid: 0 });
    // Live-path ingest after attach — equally dirty, equally projected.
    bus.publishObserverEntry('s1', {
      eid: 5,
      ts: 't',
      type: 'pcp_tool',
      tool: 'get_timezone',
      status: 'done',
      result: { secret: 'SECRET_LIVE_ARGS' },
    } as never);
    await new Promise((r) => setImmediate(r));

    const wire = JSON.stringify(sink.received);
    expect(sink.received.map((e) => e.eid)).toEqual([1, 2, 3, 4, 5]);
    for (const secret of [
      'SECRET_ARGS',
      'SECRET_RESULT',
      'SECRET_DELEGATION',
      'SECRET_RAW',
      'SECRET_STDERR',
      'SECRET_LIVE_ARGS',
    ]) {
      expect(wire).not.toContain(secret);
    }
    // The useful projection survives.
    expect(wire).toContain('send_to_inbox');
    expect(wire).toContain('fine reply');
  });

  it('monotonic guard: overlapping ledger + ring + live delivery is duplicate-free', async () => {
    const path = writeLedger42(
      Array.from({ length: 20 }, (_, i) => obsEntry(i + 1) as Record<string, unknown>)
    );
    bus.registerLedgerPath('s1', path);
    // Ring holds a mid-window overlap of the same entries.
    for (let i = 10; i <= 20; i++) bus.publishObserverEntry('s1', obsEntry(i));

    const sink = new TestSink();
    const subscribing = bus.subscribeObserver('s1', sink, { afterEid: 0 });
    // Live entries during replay, including a re-publish overlap.
    bus.publishObserverEntry('s1', obsEntry(20));
    bus.publishObserverEntry('s1', obsEntry(21));
    await subscribing;
    await new Promise((r) => setImmediate(r));

    const eids = sink.received.map((e) => e.eid);
    expect(eids).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
  });

  it('DURABILITY: a fresh channel recovers the locator from the store and serves full history', async () => {
    const path = writeLedger42(
      Array.from({ length: 5 }, (_, i) => obsEntry(i + 1) as Record<string, unknown>)
    );
    const store: LedgerLocatorStore = {
      persist: async () => undefined,
      load: async (sessionId) => (sessionId === 's1' ? path : null),
    };
    bus.setLocatorStore(store);

    // Simulate post-restart: nothing in memory at all for s1.
    const sink = new TestSink();
    await bus.subscribeObserver('s1', sink, { afterEid: 0 });
    expect(sink.received.map((e) => e.eid)).toEqual([1, 2, 3, 4, 5]);
  });

  it('CROSS-TURN: turn-end release never detaches subscribers; later turns still deliver', async () => {
    vi.useFakeTimers();
    try {
      const sink = new TestSink();
      await bus.subscribeObserver('s1', sink);
      bus.publishObserverEntry('s1', obsEntry(1));

      // Turn ends; retention window elapses fully.
      bus.releaseObserverSession('s1');
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(sink.endedWith).toBeNull();

      // Next turn re-registers and publishes — still delivered.
      bus.publishObserverEntry('s1', obsEntry(2));
      await vi.advanceTimersByTimeAsync(0);
      expect(sink.received.map((e) => e.eid)).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts channel memory after the window when nobody is watching', async () => {
    vi.useFakeTimers();
    try {
      bus.publishObserverEntry('s1', obsEntry(1));
      bus.releaseObserverSession('s1');
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      // New default attach sees an empty ring (memory reclaimed)…
      const sink = new TestSink();
      await bus.subscribeObserver('s1', sink);
      expect(sink.received).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
