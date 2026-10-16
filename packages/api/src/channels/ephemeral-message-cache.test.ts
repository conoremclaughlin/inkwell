import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EphemeralMessageCache } from './ephemeral-message-cache';

const TTL = 30 * 60_000;
const message = (chatId = 'synthetic-chat', timestamp = new Date()) => ({ chatId, timestamp });

describe('EphemeralMessageCache', () => {
  let cache: EphemeralMessageCache<ReturnType<typeof message>>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    cache = new EphemeralMessageCache();
  });
  afterEach(() => {
    cache.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('prunes only the expired messages in a quiet chat', async () => {
    cache.add(message());
    await vi.advanceTimersByTimeAsync(60_000);
    const newer = message();
    cache.add(newer);
    await vi.advanceTimersByTimeAsync(TTL - 60_000);
    expect(cache.getStats()).toEqual({ chatCount: 1, totalMessages: 1 });
    expect(cache.getRecent('synthetic-chat')).toEqual([newer]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cache.getStats()).toEqual({ chatCount: 0, totalMessages: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires on reads before the next sweep and releases the last timer', async () => {
    await vi.advanceTimersByTimeAsync(30_000);
    cache.add(message('synthetic-chat', new Date(Date.now() - TTL + 10_000)));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cache.getRecent('synthetic-chat')).toEqual([]);
    expect(cache.getStats()).toEqual({ chatCount: 0, totalMessages: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns an independent array, preserving cached order and membership', () => {
    const first = message();
    const second = message();
    cache.add(first);
    cache.add(second);
    const result = cache.getRecent('synthetic-chat');
    result.reverse().pop();
    expect(cache.getRecent('synthetic-chat')).toEqual([first, second]);
  });

  it('uses a single unreferenced timer only while holding data', () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    expect(vi.getTimerCount()).toBe(0);
    for (let i = 0; i < 100; i++) cache.add(message(`synthetic-${i}`));
    expect(interval).toHaveBeenCalledTimes(1);
    expect(interval.mock.results[0].value.hasRef()).toBe(false);
    cache.stop();
    expect(vi.getTimerCount()).toBe(0);
    cache.start();
    expect(vi.getTimerCount()).toBe(0);
    cache.add(message());
    expect(interval).toHaveBeenCalledTimes(2);
  });

  it('does not retain messages with invalid timestamps', () => {
    cache.add(message('synthetic-chat', new Date(NaN)));
    expect(cache.getStats()).toEqual({ chatCount: 0, totalMessages: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes recency on writes as well as reads', () => {
    for (let i = 0; i < 256; i++) cache.add(message(`synthetic-${i}`));
    cache.add(message('synthetic-0'));
    cache.add(message('synthetic-new'));
    expect(cache.getRecent('synthetic-0')).toHaveLength(2);
    expect(cache.getRecent('synthetic-1')).toEqual([]);
    expect(cache.getStats()).toEqual({ chatCount: 256, totalMessages: 257 });
  });

  it('prunes expired chats before evicting a fresh LRU chat at capacity', () => {
    cache.add(message('synthetic-fresh'));
    for (let i = 1; i < 256; i++)
      cache.add(message(`synthetic-${i}`, new Date(Date.now() - TTL + 1)));
    vi.setSystemTime(Date.now() + 1);
    cache.add(message('synthetic-new'));
    expect(cache.getRecent('synthetic-fresh')).toHaveLength(1);
    expect(cache.getStats()).toEqual({ chatCount: 2, totalMessages: 2 });
  });
});
