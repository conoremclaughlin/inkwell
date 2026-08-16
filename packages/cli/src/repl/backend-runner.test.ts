import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  prepareCalls: [] as Array<{ backend: string; promptParts: string[] }>,
}));

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('../backends/index.js', () => ({
  getBackend: (backend: string) => ({
    name: backend,
    binary: 'mock-backend',
    prepare: (config: { promptParts: string[] }) => {
      state.prepareCalls.push({ backend, promptParts: [...config.promptParts] });
      return {
        binary: 'mock-backend',
        args: [...config.promptParts],
        env: {},
        cleanup: () => undefined,
      };
    },
  }),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

import { runBackendTurn, DEFAULT_TURN_HARD_TIMEOUT_MS } from './backend-runner.js';

function createMockChild(exitCode = 0): EventEmitter & {
  stdout: EventEmitter & { setEncoding: (encoding: string) => void };
  stderr: EventEmitter & { setEncoding: (encoding: string) => void };
} {
  const stdout = new EventEmitter() as EventEmitter & {
    setEncoding: (encoding: string) => void;
  };
  stdout.setEncoding = () => undefined;

  const stderr = new EventEmitter() as EventEmitter & {
    setEncoding: (encoding: string) => void;
  };
  stderr.setEncoding = () => undefined;

  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: (encoding: string) => void };
    stderr: EventEmitter & { setEncoding: (encoding: string) => void };
  };
  child.stdout = stdout;
  child.stderr = stderr;

  queueMicrotask(() => {
    child.emit('close', exitCode);
  });

  return child;
}

describe('runBackendTurn', () => {
  it('uses codex exec mode for non-interactive turns', async () => {
    state.prepareCalls = [];
    spawnMock.mockImplementation(() => createMockChild(0));

    await runBackendTurn({
      backend: 'codex',
      agentId: 'lumen',
      prompt: 'ping',
    });

    expect(state.prepareCalls[0]).toEqual({ backend: 'codex', promptParts: ['exec', 'ping'] });
    expect(spawnMock).toHaveBeenCalledWith(
      'mock-backend',
      ['exec', 'ping'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
  });

  it('keeps existing one-shot prompt flow for non-codex backends', async () => {
    state.prepareCalls = [];
    spawnMock.mockImplementation(() => createMockChild(0));

    await runBackendTurn({
      backend: 'claude',
      agentId: 'wren',
      prompt: 'ping',
    });

    expect(state.prepareCalls[0]).toEqual({ backend: 'claude', promptParts: ['ping'] });
    expect(spawnMock).toHaveBeenCalledWith(
      'mock-backend',
      ['ping'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
  });

  it('default hard backstop is the 4h runaway ceiling, not the old 20-minute cap', async () => {
    vi.useFakeTimers();
    try {
      // Long-lived child: never closes on its own, tracks kill().
      const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
      stdout.setEncoding = () => undefined;
      const stderr = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
      stderr.setEncoding = () => undefined;
      const child = new EventEmitter() as EventEmitter & {
        stdout: typeof stdout;
        stderr: typeof stderr;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = vi.fn();
      spawnMock.mockImplementation(() => child);

      const resultPromise = runBackendTurn({
        backend: 'claude',
        agentId: 'wren',
        prompt: 'marathon',
      });

      // A working turn crosses the old 20-minute cap unharmed.
      await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
      child.stdout.emit('data', 'still working\n');
      expect(child.kill).not.toHaveBeenCalled();

      // Still alive just short of the 4h backstop…
      await vi.advanceTimersByTimeAsync(DEFAULT_TURN_HARD_TIMEOUT_MS - 25 * 60 * 1000 - 1);
      expect(child.kill).not.toHaveBeenCalled();

      // …and reaped as a hard timeout once it crosses.
      await vi.advanceTimersByTimeAsync(2);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      const result = await resultPromise;
      expect(result.timedOut).toBe(true);
      expect(result.timeoutType).toBe('hard');
      expect(result.exitCode).toBe(124);
    } finally {
      vi.useRealTimers();
    }
  });
});
