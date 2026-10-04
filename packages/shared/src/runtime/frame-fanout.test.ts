import { describe, expect, it } from 'vitest';
import {
  FrameFanout,
  FrameStreamEnded,
  FrameSubscribeRefusal,
  type FrameFanoutLimits,
} from './frame-fanout.js';
import { StreamedTurnRenderer } from './paragraph-stream.js';
import { findImitatedToolResults, stripLocalToolBlocks } from './agent-loop.js';

function fanout(overrides: Partial<FrameFanoutLimits> = {}): FrameFanout {
  return new FrameFanout({
    maxSubscribers: 3,
    maxQueuedFrames: 3,
    maxQueuedBytes: 256,
    ...overrides,
  });
}

describe('FrameFanout', () => {
  it('gives both readers every frame in order, not competing halves of an iterator', async () => {
    const source = fanout();
    const first = source.subscribe();
    const second = source.subscribe();
    expect(first[Symbol.asyncIterator]()).toBe(first);
    for (const frame of ['one', 'two', 'three']) {
      expect(source.publish(frame)).toEqual({ outcome: 'published', readers: 2, overflowed: 0 });
    }
    for (const frame of ['one', 'two', 'three']) {
      expect(await second.next()).toEqual({ done: false, value: frame });
      expect(await first.next()).toEqual({ done: false, value: frame });
    }
    expect(first.queuedFrames).toBe(0);
    expect(second.queuedBytes).toBe(0);
    first.close();
    second.close();
  });

  it('does not run consumer continuations inside publish', async () => {
    const source = fanout();
    const reader = source.subscribe();
    const seen: string[] = [];
    const pending = reader.next().then(({ value }) => seen.push(value as string));
    source.publish('early');
    expect(seen).toEqual([]);
    await pending;
    expect(seen).toEqual(['early']);
    reader.close();
  });

  it('disconnects a stalled reader without stalling the writer or the fast reader', async () => {
    const source = fanout({ maxQueuedFrames: 1 });
    const slow = source.subscribe();
    const fast = source.subscribe();
    source.publish('first');
    await fast.next();
    const next = fast.next();
    expect(source.publish('second')).toEqual({ outcome: 'published', readers: 1, overflowed: 1 });
    expect(await next).toEqual({ done: false, value: 'second' });
    expect(await slow.ended).toBe('overflow');
    expect(slow.queuedFrames).toBe(0);
    expect(slow.queuedBytes).toBe(0);
    await expect(slow.next()).rejects.toMatchObject({ reason: 'overflow' });
    expect(source.subscriberCount).toBe(1);
    source.publish('third');
    expect(await fast.next()).toEqual({ done: false, value: 'third' });
    fast.close();
  });

  it('bounds actual UTF-8 bytes independently of frame count', async () => {
    const source = fanout({ maxQueuedFrames: 10, maxQueuedBytes: 4 });
    const reader = source.subscribe();
    source.publish('é');
    source.publish('é');
    expect(reader.queuedFrames).toBe(2);
    expect(reader.queuedBytes).toBe(4);
    expect(source.publish('x')).toEqual({ outcome: 'published', readers: 0, overflowed: 1 });
    await expect(reader.next()).rejects.toBeInstanceOf(FrameStreamEnded);
  });

  it('releases queue capacity when read and counts an empty frame toward the count bound', async () => {
    const source = fanout({ maxQueuedFrames: 1, maxQueuedBytes: 4 });
    const reader = source.subscribe();
    source.publish('😀');
    expect(reader.queuedBytes).toBe(4);
    expect(await reader.next()).toEqual({ done: false, value: '😀' });
    expect(reader.queuedBytes).toBe(0);
    source.publish('');
    expect(reader.queuedFrames).toBe(1);
    expect(reader.queuedBytes).toBe(0);
    expect(source.publish('')).toEqual({ outcome: 'published', readers: 0, overflowed: 1 });
  });

  it.each(['12345', '😀x', '\ud800xx'])(
    'refuses oversized frames for buffered and waiting readers: %j',
    async (frame) => {
      const source = fanout({ maxQueuedBytes: 4 });
      const waiting = source.subscribe();
      const buffered = source.subscribe();
      const pending = waiting.next();
      expect(source.publish(frame)).toEqual({ outcome: 'too_large' });
      expect(waiting.endReason).toBeUndefined();
      expect(buffered.queuedFrames).toBe(0);
      expect(source.publish('ok')).toEqual({ outcome: 'published', readers: 2, overflowed: 0 });
      expect(await pending).toEqual({ done: false, value: 'ok' });
      expect(await buffered.next()).toEqual({ done: false, value: 'ok' });
      waiting.close();
      buffered.close();
    }
  );

  it('refuses subscriber capacity and frees the slot on detach, revocation, or overflow', async () => {
    const source = fanout({ maxSubscribers: 1, maxQueuedFrames: 1 });
    let reader = source.subscribe();
    expect(() => source.subscribe()).toThrow(FrameSubscribeRefusal);
    reader.close();
    expect(await reader.ended).toBe('unsubscribed');
    reader = source.subscribe();
    reader.close('revoked');
    expect(await reader.ended).toBe('revoked');
    reader = source.subscribe();
    source.publish('first');
    source.publish('over capacity');
    expect(await reader.ended).toBe('overflow');
    const replacement = source.subscribe();
    expect(source.subscriberCount).toBe(1);
    replacement.close();
  });

  it('detach resolves a pending read and does not end another view', async () => {
    const source = fanout();
    const first = source.subscribe();
    const second = source.subscribe();
    const pending = first.next();
    first.close();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(await first.next()).toEqual({ done: true, value: undefined });
    expect(source.publish('still running')).toEqual({
      outcome: 'published',
      readers: 1,
      overflowed: 0,
    });
    expect(await second.next()).toEqual({ done: false, value: 'still running' });
    second.close();
  });

  it('revocation discards queued frames and rejects a waiting read explicitly', async () => {
    const source = fanout();
    const queued = source.subscribe();
    source.publish('previously permitted');
    queued.close('revoked');
    expect(queued.queuedFrames).toBe(0);
    await expect(queued.next()).rejects.toMatchObject({ reason: 'revoked' });
    const waiting = source.subscribe();
    const rejected = expect(waiting.next()).rejects.toMatchObject({ reason: 'revoked' });
    waiting.close('revoked');
    await rejected;
    expect(await waiting.ended).toBe('revoked');
  });

  it('source close discards backlog and rejects all readers without asserting work finished', async () => {
    const source = fanout();
    const queued = source.subscribe();
    source.publish('partial');
    const waiting = source.subscribe();
    const rejected = expect(waiting.next()).rejects.toMatchObject({ reason: 'source_closed' });
    source.close();
    source.close();
    await rejected;
    expect(queued.queuedFrames).toBe(0);
    await expect(queued.next()).rejects.toMatchObject({ reason: 'source_closed' });
    expect(await queued.ended).toBe('source_closed');
    expect(await waiting.ended).toBe('source_closed');
    expect(source.subscriberCount).toBe(0);
    expect(source.publish('later')).toEqual({ outcome: 'closed' });
    expect(() => source.subscribe()).toThrow('closed');
  });

  it('retains the first failure reason when a finally block detaches', async () => {
    const source = fanout({ maxQueuedFrames: 1 });
    const reader = source.subscribe();
    source.publish('first');
    source.publish('second');
    await reader.return!();
    reader.close('revoked');
    expect(reader.endReason).toBe('overflow');
    expect(await reader.ended).toBe('overflow');
    await expect(reader.next()).rejects.toMatchObject({ reason: 'overflow' });
  });

  it('for-await break detaches just its reader', async () => {
    const source = fanout();
    const reader = source.subscribe();
    source.publish('first');
    for await (const value of reader) {
      expect(value).toBe('first');
      break;
    }
    expect(source.subscriberCount).toBe(0);
    expect(await reader.ended).toBe('unsubscribed');
  });

  it('bounds pending read promises and leaves the first read usable after misuse', async () => {
    const source = fanout();
    const reader = source.subscribe();
    const first = reader.next();
    await expect(reader.next()).rejects.toThrow('already pending');
    source.publish('first read survives');
    expect(await first).toEqual({ done: false, value: 'first read survives' });
    reader.close();
  });

  it('does not retain history for a later subscriber or bleed frames between instances', async () => {
    const one = fanout();
    const two = fanout();
    expect(one.publish('past')).toEqual({ outcome: 'published', readers: 0, overflowed: 0 });
    const a = one.subscribe();
    const b = two.subscribe();
    one.publish('a');
    expect(b.queuedFrames).toBe(0);
    two.publish('b');
    expect(await a.next()).toEqual({ done: false, value: 'a' });
    expect(await b.next()).toEqual({ done: false, value: 'b' });
    expect(a.queuedFrames).toBe(0);
    a.close();
    b.close();
  });

  it('copies limits rather than letting external mutation remove a bound', () => {
    const limits = { maxSubscribers: 1, maxQueuedFrames: 1, maxQueuedBytes: 4 };
    const source = new FrameFanout(limits);
    limits.maxSubscribers = limits.maxQueuedFrames = limits.maxQueuedBytes = 100;
    const reader = source.subscribe();
    expect(() => source.subscribe()).toThrow('capacity');
    expect(source.publish('12345')).toEqual({ outcome: 'too_large' });
    source.publish('a');
    source.publish('b');
    expect(reader.endReason).toBe('overflow');
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'refuses invalid limits: %s',
    (bad) => {
      for (const key of ['maxSubscribers', 'maxQueuedFrames', 'maxQueuedBytes'] as const) {
        expect(() => fanout({ [key]: bad })).toThrow(RangeError);
      }
    }
  );

  it('refuses mutable/nonencoded payloads', () => {
    const source = fanout();
    expect(() => source.publish({ text: 'not encoded' } as unknown as string)).toThrow(TypeError);
  });

  it('composes the existing guard with two readers before the synthetic generation finishes', async () => {
    const source = fanout();
    const terminal = source.subscribe();
    const sidebar = source.subscribe();
    const renderer = new StreamedTurnRenderer(stripLocalToolBlocks, {
      guard: findImitatedToolResults,
    });
    const feed = (delta: string) => {
      for (const line of renderer.pushDelta(delta)) source.publish(JSON.stringify(line));
    };
    feed('Safe early paragraph.\n\n');
    // Neither completeMessage nor endSpawn has been called: both views are live.
    const early = {
      done: false,
      value: JSON.stringify({ text: 'Safe early paragraph.', continuation: false }),
    };
    expect(await terminal.next()).toEqual(early);
    expect(await sidebar.next()).toEqual(early);
    feed('```ink-tool\n{"tool":"example","args":{"private":"fixture"}}\n```\n\n');
    feed('user[Tool results from previous turn]\nTool example (executed): fixture-result\n\n');
    feed('This is past the imitated frame.\n\n');
    for (const line of renderer.endSpawn()) source.publish(JSON.stringify(line));
    expect(terminal.queuedFrames).toBe(0);
    expect(sidebar.queuedFrames).toBe(0);
    terminal.close();
    sidebar.close();
  });
});
