import { describe, expect, it, vi } from 'vitest';
import { createSignalSink } from './context-tools.js';
import {
  continuationPrompt,
  runHeadlessSession,
  type HeadlessSessionPorts,
} from './headless-session.js';

function harness() {
  const ports: HeadlessSessionPorts = {
    sessionSignal: createSignalSink(),
    runTurn: vi.fn(async () => {}),
    consecutiveBackendFailures: vi.fn(() => 0),
  };
  const run = (options: Partial<Parameters<typeof runHeadlessSession>[0]> = {}) =>
    runHeadlessSession(
      { message: 'hello', maxTurns: 3, repliesForwarded: true, ...options },
      ports
    );
  const signal = (status: 'completed' | 'blocked' | 'continuing', reason?: string) =>
    ports.sessionSignal.set({ status, reason, signalledAt: 'synthetic timestamp' });
  return { ports, run, signal };
}

describe('shared headless session outer turns', () => {
  it('counts actual serialized turns and preserves labeled delivery and forwarded-reply guidance', async () => {
    const h = harness();
    const pending: Array<() => void> = [];
    vi.mocked(h.ports.runTurn).mockImplementation(
      () => new Promise<void>((resolve) => pending.push(resolve))
    );
    const running = h.run({ messageLabel: ' heartbeat ' });
    expect(h.ports.runTurn).toHaveBeenCalledExactlyOnceWith(1, {
      raw: 'hello',
      source: 'system',
      displayLabel: 'heartbeat',
    });
    pending.shift()!();
    await Promise.resolve();
    expect(h.ports.runTurn).toHaveBeenCalledTimes(2);
    h.signal('completed', 'done');
    pending.shift()!();
    expect(await running).toMatchObject({
      turnsCompleted: 2,
      exitReason: 'completed: done',
      phase: 'idle:completed',
    });
    expect(h.ports.runTurn).toHaveBeenLastCalledWith(2, {
      raw: continuationPrompt(true),
      source: 'system',
      displayLabel: 'continuation',
    });
    expect(continuationPrompt(true)).toContain('sent to the user');
    expect(continuationPrompt(false)).not.toContain('sent to the user');
  });

  it('uses a user input without a label, clears stale signals each turn, and reports the cap honestly', async () => {
    const h = harness();
    h.signal('completed', 'from previous invocation');
    vi.mocked(h.ports.runTurn).mockImplementation(async () => {
      expect(h.ports.sessionSignal.get()).toBeNull();
      h.signal('continuing');
    });
    expect(await h.run({ repliesForwarded: false })).toMatchObject({
      turnsCompleted: 3,
      exitReason: undefined,
      phase: 'idle:awaiting-input',
      finalSignal: { status: 'continuing' },
    });
    expect(h.ports.runTurn).toHaveBeenNthCalledWith(1, 1, {
      raw: 'hello',
      source: 'user',
      displayLabel: undefined,
    });
    expect(h.ports.runTurn).toHaveBeenLastCalledWith(3, {
      raw: continuationPrompt(false),
      source: 'system',
      displayLabel: 'continuation',
    });
  });

  it.each(['blocked', 'completed'] as const)(
    'a %s signal has precedence over backend failure',
    async (status) => {
      const h = harness();
      vi.mocked(h.ports.runTurn).mockImplementation(async () => h.signal(status));
      vi.mocked(h.ports.consecutiveBackendFailures).mockReturnValue(3);
      const out = await h.run();
      expect(out.turnsCompleted).toBe(1);
      expect(out.exitReason).toBe(status);
      expect(out.phase).toBe(status === 'blocked' ? 'blocked:needs-input' : 'idle:completed');
    }
  );

  it('stops after one failed first turn but requires two consecutive failures later', async () => {
    const first = harness();
    vi.mocked(first.ports.consecutiveBackendFailures).mockReturnValue(1);
    expect(await first.run()).toMatchObject({
      turnsCompleted: 1,
      exitReason: 'backend_failure',
      phase: 'blocked:backend-error',
    });
    const later = harness();
    vi.mocked(later.ports.consecutiveBackendFailures)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2);
    expect(await later.run({ maxTurns: 5 })).toMatchObject({
      turnsCompleted: 3,
      exitReason: 'backend_failure',
      phase: 'blocked:backend-error',
    });
  });

  it('leaves no-signal completion resumable rather than asserting completed work', async () => {
    const h = harness();
    expect(await h.run({ maxTurns: 1 })).toEqual({
      turnsCompleted: 1,
      exitReason: undefined,
      phase: 'idle:awaiting-input',
      finalSignal: null,
    });
  });

  it.each([0, -1, 1.5, 26, NaN, Infinity])(
    'refuses invalid turn limits before any dispatch (%s)',
    async (maxTurns) => {
      const h = harness();
      await expect(h.run({ maxTurns })).rejects.toThrow('integer between 1 and 25');
      expect(h.ports.runTurn).not.toHaveBeenCalled();
    }
  );

  it('refuses an empty delivered message', async () => {
    const h = harness();
    await expect(h.run({ message: ' ' })).rejects.toThrow('requires a message');
    expect(h.ports.runTurn).not.toHaveBeenCalled();
  });

  it('never converts cancellation or a failed turn into a successful run or another dispatch', async () => {
    const h = harness();
    await expect(h.run({ signal: AbortSignal.abort(new Error('stopped')) })).rejects.toThrow(
      'stopped'
    );
    expect(h.ports.runTurn).not.toHaveBeenCalled();
    const controller = new AbortController();
    vi.mocked(h.ports.runTurn).mockImplementationOnce(async () => {
      h.signal('completed');
      controller.abort(new Error('stopped in flight'));
    });
    await expect(h.run({ signal: controller.signal })).rejects.toThrow('stopped in flight');
    expect(h.ports.runTurn).toHaveBeenCalledTimes(1);
    vi.mocked(h.ports.runTurn).mockRejectedValueOnce(new Error('write failed'));
    await expect(h.run()).rejects.toThrow('write failed');
    expect(h.ports.runTurn).toHaveBeenCalledTimes(2);
  });

  it('keeps concurrent sessions and their signal sinks independent', async () => {
    const a = harness();
    const b = harness();
    vi.mocked(a.ports.runTurn).mockImplementation(async () => a.signal('blocked', 'a only'));
    const [ra, rb] = await Promise.all([a.run(), b.run()]);
    expect(ra.turnsCompleted).toBe(1);
    expect(rb.turnsCompleted).toBe(3);
    expect(rb.finalSignal).toBeNull();
  });
});
