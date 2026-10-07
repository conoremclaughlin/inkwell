import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

// Every process and credential is synthetic; no CLI host/config discovery.
const spawnContext = {
  cliAttached: false,
  workingDirectory: '/synthetic/studio',
  inkSessionId: 'sess-from-parent',
  studioId: 'studio-from-parent',
  host: {
    paths: {
      inkFiles: '/synthetic/files',
      studiosRoot: '/synthetic/studios',
      tempDir: '/synthetic/tmp',
    },
    ambientSession: () => ({}),
    claudeSupportsPartialMessages: async () => false,
    skillMcpServers: async () => [],
    sessionEnv: async () => ({
      INK_ACCESS_TOKEN: 'child-session-token',
      INK_DELEGATION_SECRET: 'synthetic-derived-secret',
    }),
    baseEnv: async () => ({ HOME: '/synthetic/home' }),
    inkwellMcpUrl: 'http://localhost:3001/mcp',
    resolveBinary: async (name: string) => name,
    warn: () => undefined,
  },
};

const state = vi.hoisted(() => ({
  prepareCalls: [] as Array<{ backend: string; promptParts: string[] }>,
  prepareConfigs: [] as Array<Record<string, unknown>>,
}));

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('../../../shared/src/providers/registry.js', () => ({
  getBackend: (backend: string) => ({
    name: backend,
    binary: 'mock-backend',
    prepare: (config: { promptParts: string[]; contextImages?: unknown[] }) => {
      state.prepareCalls.push({ backend, promptParts: [...config.promptParts] });
      state.prepareConfigs.push({ ...config });
      return {
        binary: 'mock-backend',
        args: [...config.promptParts],
        env: {
          INK_SESSION_ID: 'sess-from-parent',
          INK_STUDIO_ID: 'studio-from-parent',
          INK_CONTEXT: 'context-from-parent',
        },
        cleanup: () => undefined,
        // An adapter that carries only the first image it is offered, the way
        // a request budget or a vanished file makes a real one refuse the rest.
        ...(config.contextImages?.length
          ? { contextImagesDelivered: config.contextImages.slice(0, 1) }
          : {}),
      };
    },
  }),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

import { runBackendTurn } from './backend-runner.js';

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
  // serves this same session: the ink chat process hands it its own session
  // credentials and identity explicitly, and never the server's secrets (which
  // are not in this process after Phase 0, and would not cross regardless).
  // The FINAL env handed to spawn is asserted, through the real shared
  // spawnBackend, with the adapter's own env winning where it sets a name.
  it('hands the provider child this session’s credentials and identity, and nothing secret', async () => {
    state.prepareCalls = [];
    spawnMock.mockImplementation(() => createMockChild(0));
    vi.stubEnv('INK_ACCESS_TOKEN', 'child-session-token');
    vi.stubEnv('INK_DELEGATION_SECRET', 'synthetic-derived-secret');
    vi.stubEnv('INK_SESSION_ID', 'sess-from-parent');
    vi.stubEnv('INK_STUDIO_ID', 'studio-from-parent');
    vi.stubEnv('INK_CONTEXT', 'context-from-parent');
    vi.stubEnv('JWT_SECRET', 'synthetic-jwt-secret');
    vi.stubEnv('SUPABASE_SECRET_KEY', 'synthetic-service-key');
    try {
      await runBackendTurn({ ...spawnContext, backend: 'claude', sbSlug: 'wren', prompt: 'ping' });
      const [, , options] = spawnMock.mock.calls[0] as [
        string,
        string[],
        { env: Record<string, string> },
      ];
      expect(options.env.INK_ACCESS_TOKEN).toBe('child-session-token');
      expect(options.env.INK_DELEGATION_SECRET).toBe('synthetic-derived-secret');
      expect(options.env.INK_SESSION_ID).toBe('sess-from-parent');
      expect(options.env.INK_STUDIO_ID).toBe('studio-from-parent');
      expect(options.env.INK_CONTEXT).toBe('context-from-parent');
      expect('JWT_SECRET' in options.env).toBe(false);
      expect('SUPABASE_SECRET_KEY' in options.env).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      spawnMock.mockReset();
    }
  });

  it('uses codex exec mode for non-interactive turns', async () => {
    state.prepareCalls = [];
    spawnMock.mockImplementation(() => createMockChild(0));

    await runBackendTurn({ ...spawnContext, backend: 'codex', sbSlug: 'lumen', prompt: 'ping' });

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

    await runBackendTurn({ ...spawnContext, backend: 'claude', sbSlug: 'wren', prompt: 'ping' });

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

  // The host records an image as seen from this report alone (PR #708): the
  // offered list is what it asked for, not what the provider received.
  it('reports the context images the adapter carried, not the ones it was offered', async () => {
    spawnMock.mockImplementation(() => createMockChild(0));
    state.prepareConfigs = [];
    const offered = [
      { path: '/virtual/a.png', mimeType: 'image/png' },
      { path: '/virtual/b.png', mimeType: 'image/png' },
    ];
    const result = await runBackendTurn({
      ...spawnContext,
      backend: 'claude',
      sbSlug: 'myra',
      prompt: 'ping',
      contextImages: offered,
      cliAttached: false,
    });
    expect(state.prepareConfigs[0]?.contextImages).toEqual(offered);
    expect(result.contextImagesDelivered).toEqual([offered[0]]);

    const none = await runBackendTurn({
      ...spawnContext,
      backend: 'claude',
      sbSlug: 'myra',
      prompt: 'ping',
      cliAttached: false,
    });
    expect(none).not.toHaveProperty('contextImagesDelivered');
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

  /** A long-lived child: never closes on its own, tracks kill(). */
  function longLivedChild() {
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
    return child;
  }

  it('has no hard backstop by default: a working turn runs past the old 4h ceiling', async () => {
    vi.useFakeTimers();
    try {
      const child = longLivedChild();
      spawnMock.mockImplementation(() => child);

      const resultPromise = runBackendTurn({
        ...spawnContext,
        backend: 'claude',
        sbSlug: 'wren',
        prompt: 'marathon',
      });

      // Six hours of work, past the old 20-minute cap and the 4h backstop
      // that replaced it (both gone; Conor, 2026-10-04).
      for (let hour = 0; hour < 6; hour++) {
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        child.stdout.emit('data', 'still working\n');
      }
      expect(child.kill).not.toHaveBeenCalled();

      child.emit('close', 0);
      const result = await resultPromise;
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an explicit timeoutMs is still a hard ceiling', async () => {
    vi.useFakeTimers();
    try {
      const child = longLivedChild();
      spawnMock.mockImplementation(() => child);

      const resultPromise = runBackendTurn({
        ...spawnContext,
        backend: 'claude',
        sbSlug: 'wren',
        prompt: 'bounded',
        timeoutMs: 60 * 60 * 1000,
      });

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000 - 1);
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      child.emit('close', null, 'SIGTERM');
      const result = await resultPromise;
      expect(result.timedOut).toBe(true);
      expect(result.timeoutType).toBe('hard');
      expect(result.exitCode).toBe(124);
    } finally {
      vi.useRealTimers();
    }
  });
});
