import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  prepareCalls: [] as Array<{ backend: string; promptParts: string[] }>,
  prepareConfigs: [] as Array<Record<string, unknown>>,
}));

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('../backends/index.js', () => ({
  getBackend: (backend: string) => ({
    name: backend,
    binary: 'mock-backend',
    prepare: (config: { promptParts: string[] }) => {
      state.prepareCalls.push({ backend, promptParts: [...config.promptParts] });
      state.prepareConfigs.push({ ...config });
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

import {
  runBackendTurn,
  DEFAULT_TURN_HARD_TIMEOUT_MS,
  type BackendRunRequest,
} from './backend-runner.js';

// Even fake spawns name their host context. Only the explicit JavaScript
// omission case below intentionally violates the request contract.
const spawnContext: Pick<
  BackendRunRequest,
  'cliAttached' | 'workingDirectory' | 'inkSessionId' | 'studioId' | 'sessionEnv'
> = {
  cliAttached: false,
  workingDirectory: '/synthetic/studio',
  inkSessionId: undefined,
  studioId: undefined,
  sessionEnv: {},
};

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
  // spec:sender-token-binding Phase 0 (Lumen, #694 r1). The provider child
  // serves the caller's session: the caller hands it that session's
  // credentials and identity explicitly (ink chat: sessionEnvHandoff(), its
  // own), and never the host's secrets. The FINAL env handed to spawn is
  // asserted, through the real shared spawnBackend, with the adapter's own env
  // winning where it sets a name.
  it('hands the provider child the session env it is given, and nothing secret', async () => {
    state.prepareCalls = [];
    spawnMock.mockImplementation(() => createMockChild(0));
    vi.stubEnv('INK_ACCESS_TOKEN', 'host-process-token');
    vi.stubEnv('INK_SESSION_ID', 'host-process-session');
    vi.stubEnv('JWT_SECRET', 'synthetic-jwt-secret');
    vi.stubEnv('SUPABASE_SECRET_KEY', 'synthetic-service-key');
    try {
      await runBackendTurn({
        backend: 'claude',
        sbSlug: 'wren',
        prompt: 'ping',
        cliAttached: false,
        workingDirectory: '/synthetic/studio',
        inkSessionId: 'sess-served',
        studioId: 'studio-served',
        sessionEnv: {
          INK_ACCESS_TOKEN: 'child-session-token',
          INK_DELEGATION_SECRET: 'synthetic-derived-secret',
          INK_SESSION_ID: 'sess-served',
          INK_STUDIO_ID: 'studio-served',
          INK_CONTEXT: 'context-served',
        },
      });
      const [, , options] = spawnMock.mock.calls[0] as [
        string,
        string[],
        { env: Record<string, string>; cwd?: string },
      ];
      expect(options.env.INK_ACCESS_TOKEN).toBe('child-session-token');
      expect(options.env.INK_DELEGATION_SECRET).toBe('synthetic-derived-secret');
      // Routing is the request's ids alone: the adapter writes these from
      // them (this fake adapter writes none), and sessionEnv's are dropped.
      expect('INK_SESSION_ID' in options.env).toBe(false);
      expect('INK_STUDIO_ID' in options.env).toBe(false);
      expect('INK_CONTEXT' in options.env).toBe(false);
      expect(options.cwd).toBe('/synthetic/studio');
      expect(state.prepareConfigs.at(-1)).toMatchObject({
        cwd: '/synthetic/studio',
        explicitSession: true,
        inkSessionId: 'sess-served',
        studioId: 'studio-served',
      });
      expect('JWT_SECRET' in options.env).toBe(false);
      expect('SUPABASE_SECRET_KEY' in options.env).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      spawnMock.mockReset();
    }
  });

  // The request type requires sessionEnv; a JavaScript caller can still omit
  // it. The child then gets no session credentials, never the host process's.
  it('gives a child whose caller omitted sessionEnv none of the host’s session values', async () => {
    spawnMock.mockImplementation(() => createMockChild(0));
    vi.stubEnv('INK_ACCESS_TOKEN', 'host-process-token');
    vi.stubEnv('INK_SESSION_ID', 'host-process-session');
    try {
      await runBackendTurn({
        backend: 'claude',
        sbSlug: 'wren',
        prompt: 'ping',
      } as unknown as Parameters<typeof runBackendTurn>[0]);
      const env = (spawnMock.mock.calls[0]?.[2] as { env: Record<string, string> }).env;
      expect('INK_ACCESS_TOKEN' in env).toBe(false);
      expect('INK_SESSION_ID' in env).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      spawnMock.mockReset();
    }
  });

  it('uses codex exec mode for non-interactive turns', async () => {
    state.prepareCalls = [];
    spawnMock.mockImplementation(() => createMockChild(0));

    await runBackendTurn({
      ...spawnContext,
      backend: 'codex',
      sbSlug: 'lumen',
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
      ...spawnContext,
      backend: 'claude',
      sbSlug: 'wren',
      prompt: 'ping',
    });

    expect(state.prepareCalls[0]).toEqual({ backend: 'claude', promptParts: ['ping'] });
    expect(spawnMock).toHaveBeenCalledWith(
      'mock-backend',
      ['ping'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
  });

  // The adapter writes this into the child's INK_CONTEXT, and the child's
  // hooks write it onto the chat's session. Dropped here, every adapter falls
  // back to its own default and a headless run marks itself attached.
  it('passes the chat process attachment through to the adapter', async () => {
    spawnMock.mockImplementation(() => createMockChild(0));
    for (const cliAttached of [false, true]) {
      state.prepareConfigs = [];
      await runBackendTurn({
        ...spawnContext,
        backend: 'claude',
        sbSlug: 'myra',
        prompt: 'ping',
        cliAttached,
      });
      expect(state.prepareConfigs[0]?.cliAttached).toBe(cliAttached);
    }
  });

  // The child's on-prompt hook reads this. Without it, a headless child's
  // cliAttached:false is a detach, and the route clears the turn marker the
  // chat process opened while that process is still running (PR #685 r2).
  it('marks every child as a turn owned by the parent chat process', async () => {
    for (const cliAttached of [false, true]) {
      spawnMock.mockReset();
      spawnMock.mockImplementation(() => createMockChild(0));
      await runBackendTurn({
        ...spawnContext,
        backend: 'claude',
        sbSlug: 'myra',
        prompt: 'ping',
        cliAttached,
      });
      const env = (spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> })?.env;
      expect(env?.INK_TURN_OWNER).toBe('parent');
    }
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
        ...spawnContext,
        backend: 'claude',
        sbSlug: 'wren',
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
