import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  SessionEventBus,
  OBS_RETENTION_MS,
  type ObserverEntry,
  type ObserverSink,
} from './session-event-bus.js';

const entry = (eid: number): ObserverEntry => ({ eid, ts: 'synthetic', type: 'backend_tool' });
const ledgerPath = join(tmpdir(), 'synthetic-observer', '.ink', 'runtime', 'repl', 'session.jsonl');
const sink = (): ObserverSink => ({
  write: vi.fn(() => true),
  waitDrain: vi.fn(async () => undefined),
  end: vi.fn(),
});

describe('observer channel retention', () => {
  let bus: SessionEventBus;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new SessionEventBus();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // Memory reclamation is the contract under test. Inspect the retained maps,
  // rather than infer collection from an empty replay (which could still leak).
  const channels = () => bus['obsChannels'];

  async function expectEvictionAfterWindow(sessionId = 'synthetic-session') {
    await vi.advanceTimersByTimeAsync(OBS_RETENTION_MS - 1);
    expect(channels().has(sessionId)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(channels().has(sessionId)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  }

  it('rearms eviction when a post-release watcher detaches', async () => {
    bus.publishObserverEntry('synthetic-session', entry(1));
    bus.releaseObserverSession('synthetic-session');
    await vi.advanceTimersByTimeAsync(OBS_RETENTION_MS / 2);
    const unsubscribe = await bus.subscribeObserver('synthetic-session', sink());
    unsubscribe();
    await expectEvictionAfterWindow();
  });

  it('keeps across-turn watchers but evicts after the final watcher leaves', async () => {
    const first = sink();
    const second = sink();
    const unsubscribeFirst = await bus.subscribeObserver('synthetic-session', first);
    const unsubscribeSecond = await bus.subscribeObserver('synthetic-session', second);
    bus.publishObserverEntry('synthetic-session', entry(1));
    bus.releaseObserverSession('synthetic-session');
    await vi.advanceTimersByTimeAsync(OBS_RETENTION_MS * 2);
    unsubscribeFirst();
    await vi.advanceTimersByTimeAsync(OBS_RETENTION_MS * 2);
    expect(second.end).not.toHaveBeenCalled();
    expect(channels().has('synthetic-session')).toBe(true);
    unsubscribeSecond();
    await expectEvictionAfterWindow();
  });

  it('reclaims 100 idle attach/detach channels without requiring another turn', async () => {
    for (let i = 0; i < 100; i++) {
      const unsubscribe = await bus.subscribeObserver(`synthetic-${i}`, sink());
      unsubscribe();
      unsubscribe(); // idempotent cleanup must not introduce extra timers
    }
    expect(channels().size).toBe(100);
    await vi.advanceTimersByTimeAsync(OBS_RETENTION_MS);
    expect(channels().size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires a failed idle replay even when sink cleanup throws', async () => {
    bus.setLocatorStore({
      persist: async () => undefined,
      load: async () => {
        throw new Error('synthetic store failure');
      },
    });
    const observer = sink();
    vi.mocked(observer.end).mockImplementation(() => {
      throw new Error('synthetic close failure');
    });
    await expect(bus.subscribeObserver('synthetic-session', observer)).rejects.toThrow(
      'synthetic store failure'
    );
    expect(observer.end).toHaveBeenCalledWith('replay_failed');
    await expectEvictionAfterWindow();
  });

  it('reclaims a completed replay-only attachment to an idle session', async () => {
    const observer = sink();
    await bus.subscribeObserver('synthetic-session', observer, { follow: false });
    expect(observer.end).toHaveBeenCalledWith('unsubscribed');
    await expectEvictionAfterWindow();
  });

  it.each(['publish', 'register'] as const)(
    'does not expire an active %s channel without watchers',
    async (activity) => {
      if (activity === 'publish') bus.publishObserverEntry('synthetic-session', entry(1));
      else bus.registerLedgerPath('synthetic-session', ledgerPath);
      const unsubscribe = await bus.subscribeObserver('synthetic-session', sink());
      unsubscribe();
      await vi.advanceTimersByTimeAsync(OBS_RETENTION_MS * 2);
      expect(channels().has('synthetic-session')).toBe(true);
      bus.releaseObserverSession('synthetic-session');
      await expectEvictionAfterWindow();
    }
  );

  it('cancels an idle deadline when the next turn starts', async () => {
    bus.publishObserverEntry('synthetic-session', entry(1));
    bus.releaseObserverSession('synthetic-session');
    await vi.advanceTimersByTimeAsync(OBS_RETENTION_MS / 2);
    bus.registerLedgerPath('synthetic-session', ledgerPath);
    await vi.advanceTimersByTimeAsync(OBS_RETENTION_MS * 2);
    const observer = sink();
    const unsubscribe = await bus.subscribeObserver('synthetic-session', observer);
    expect(observer.write).toHaveBeenCalledWith(entry(1));
    unsubscribe();
    bus.releaseObserverSession('synthetic-session');
    await expectEvictionAfterWindow();
  });

  it('recovers durable replay after evicting an idle channel', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'observer-retention-'));
    try {
      const replDir = join(dir, '.ink', 'runtime', 'repl');
      await mkdir(replDir, { recursive: true });
      const path = join(replDir, 'synthetic.jsonl');
      await writeFile(path, `${JSON.stringify(entry(1))}\n`);
      bus.setLocatorStore({
        persist: async () => undefined,
        load: async () => ({ ledgerPath: path, activity: 'completed' as const }),
      });
      bus.registerLedgerPath('synthetic-session', path);
      bus.publishObserverEntry('synthetic-session', entry(1));
      bus.releaseObserverSession('synthetic-session');
      await vi.advanceTimersByTimeAsync(OBS_RETENTION_MS);
      expect(channels().size).toBe(0);
      const observer = sink();
      await bus.subscribeObserver('synthetic-session', observer, { afterEid: 0, follow: false });
      expect(observer.write).toHaveBeenCalledExactlyOnceWith(entry(1));
      await expectEvictionAfterWindow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['abort', 'timeout'] as const)(
    'removes each settled locator waiter on %s',
    async (reason) => {
      bus.locatorWaitMs = 10;
      bus.setLocatorStore({
        persist: async () => undefined,
        load: async () => ({ ledgerPath: null, activity: 'attempted' as const }),
      });
      for (let i = 0; i < 100; i++) {
        const controller = new AbortController();
        const subscribing = bus.subscribeObserver('synthetic-session', sink(), {
          signal: controller.signal,
        });
        const rejected = expect(subscribing).rejects.toThrow(/retry shortly/);
        await vi.advanceTimersByTimeAsync(0);
        if (reason === 'abort') controller.abort();
        else await vi.advanceTimersByTimeAsync(bus.locatorWaitMs);
        await rejected;
      }
      expect(channels().get('synthetic-session')?.subscribers.size).toBe(0);
      expect(channels().get('synthetic-session')?.pathWaiters).toBeUndefined();
      await expectEvictionAfterWindow();
    }
  );

  it('removing one aborted waiter preserves the other until announcement', async () => {
    bus.setLocatorStore({
      persist: async () => undefined,
      load: async () => ({ ledgerPath: null, activity: 'attempted' as const }),
    });
    const controller = new AbortController();
    const first = bus.subscribeObserver('synthetic-session', sink(), { signal: controller.signal });
    const rejected = expect(first).rejects.toThrow(/retry shortly/);
    const secondSink = sink();
    const second = bus.subscribeObserver('synthetic-session', secondSink);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    bus.registerLedgerPath('synthetic-session', ledgerPath);
    const unsubscribe = await second;
    expect(secondSink.end).not.toHaveBeenCalled();
    expect(channels().get('synthetic-session')?.pathWaiters).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    unsubscribe();
    bus.releaseObserverSession('synthetic-session');
    await expectEvictionAfterWindow();
  });
});
