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
});
