import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  prepareCalls: [] as Array<{ backend: string; promptParts: string[] }>,
  prepareConfigs: [] as Array<Record<string, unknown>>,
  cleanups: 0,
  /** When set, the prepared cleanup resolves only when this does. */
  cleanupGate: undefined as Promise<void> | undefined,
  /** When set, the adapter has an effective-config check that runs this. */
  check: undefined as undefined | ((check: EffectiveConfigCheck) => Promise<string | undefined>),
  /** The env the adapter prepares, for the check's session names. */
  preparedEnv: {} as Record<string, string>,
  /** The launch config the adapter prepares, when it prepares one. */
  preparedLaunchConfig: undefined as undefined | { args: string[] } | { refusal: string },
}));

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('./registry.js', () => ({
  getBackend: (backend: string) => ({
    name: backend,
    binary: 'mock-backend',
    prepare: (config: { promptParts: string[] }) => {
      state.prepareCalls.push({ backend, promptParts: [...config.promptParts] });
      state.prepareConfigs.push({ ...config });
      return {
        binary: 'mock-backend',
        args: [...config.promptParts],
        env: { ...state.preparedEnv },
        ...(state.preparedLaunchConfig ? { launchConfig: state.preparedLaunchConfig } : {}),
        cleanup: async () => {
          state.cleanups += 1;
          await state.cleanupGate;
        },
      };
    },
    ...(state.check
      ? { checkEffectiveConfig: (check: EffectiveConfigCheck) => state.check!(check) }
      : {}),
  }),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

import {
  runBackendTurn,
  startBackendTurn,
  CONFIG_REFUSED_EXIT_CODE,
  DEFAULT_TURN_HARD_TIMEOUT_MS,
  EFFECTIVE_CONFIG_CHECK_FAILED,
  type BackendRunRequest,
} from './backend-runner.js';
import { SPAWN_ENV_INHERITED_NAMES } from '../runner/spawn-backend.js';
import type { BackendHost, EffectiveConfigCheck } from './types.js';

/** A host that answers everything and touches nothing. */
function fakeHost(overrides: Partial<BackendHost> = {}): BackendHost {
  return {
    paths: {
      inkFiles: '/synthetic/ink-files',
      studiosRoot: '/synthetic/studios',
      tempDir: '/synthetic/tmp',
    },
    ambientSession: () => ({}),
    claudeSupportsPartialMessages: async () => false,
    skillMcpServers: async () => [],
    sessionEnv: async () => ({}),
    baseEnv: async () => process.env,
    inkwellMcpUrl: 'http://localhost:3001/mcp',
    resolveBinary: async (name) => name,
    warn: () => undefined,
    ...overrides,
  };
}

// Even fake spawns name their host context. Only the explicit JavaScript
// omission case below intentionally violates the request contract.
const spawnContext: Pick<
  BackendRunRequest,
  'cliAttached' | 'workingDirectory' | 'inkSessionId' | 'studioId' | 'host'
> = {
  cliAttached: false,
  workingDirectory: '/synthetic/studio',
  inkSessionId: undefined,
  studioId: undefined,
  host: fakeHost(),
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
  // serves the caller's session: its host hands it that session's
  // credentials and identity explicitly (ink chat: sessionEnvHandoff(), its
  // own), and never the host process's secrets. The FINAL env handed to
  // spawn is asserted, through the real shared spawnBackend, with the
  // adapter's own env winning where it sets a name.
  it('hands the provider child the credentials its host gives, and nothing secret', async () => {
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
        host: fakeHost({
          sessionEnv: async () => ({
            INK_ACCESS_TOKEN: 'child-session-token',
            INK_DELEGATION_SECRET: 'synthetic-derived-secret',
            INK_SESSION_ID: 'sess-served',
            INK_STUDIO_ID: 'studio-served',
            INK_CONTEXT: 'context-served',
          }),
        }),
      });
      const [, , options] = spawnMock.mock.calls[0] as [
        string,
        string[],
        { env: Record<string, string>; cwd?: string },
      ];
      expect(options.env.INK_ACCESS_TOKEN).toBe('child-session-token');
      expect(options.env.INK_DELEGATION_SECRET).toBe('synthetic-derived-secret');
      // Routing is the request's ids alone: the adapter writes these from
      // them (this fake adapter writes none), and the host's are dropped.
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

  // The request type requires a host; a JavaScript caller can still omit it.
  // Nothing then spawns, so no child can fall back to the host process's own
  // session values.
  it('spawns nothing for a caller that omitted the host', async () => {
    spawnMock.mockReset().mockImplementation(() => createMockChild(0));
    vi.stubEnv('INK_ACCESS_TOKEN', 'host-process-token');
    vi.stubEnv('INK_SESSION_ID', 'host-process-session');
    try {
      await expect(
        runBackendTurn({
          backend: 'claude',
          sbSlug: 'wren',
          prompt: 'ping',
        } as unknown as Parameters<typeof runBackendTurn>[0])
      ).rejects.toThrow(TypeError);
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      spawnMock.mockReset();
    }
  });

  it('asks the host for credentials after preparation, with the spawn’s hard ceiling', async () => {
    spawnMock.mockReset().mockImplementation(() => createMockChild(0));
    state.prepareCalls = [];
    const asked: Array<{ hardTimeoutMs: number; preparedBefore: number }> = [];
    try {
      for (const timeoutMs of [undefined, 1234]) {
        await runBackendTurn({
          ...spawnContext,
          backend: 'claude',
          sbSlug: 'wren',
          prompt: 'ping',
          timeoutMs,
          host: fakeHost({
            sessionEnv: async (spawn) => {
              asked.push({ ...spawn, preparedBefore: state.prepareCalls.length });
              return {};
            },
          }),
        });
      }
      expect(asked).toEqual([
        { hardTimeoutMs: DEFAULT_TURN_HARD_TIMEOUT_MS, preparedBefore: 1 },
        { hardTimeoutMs: 1234, preparedBefore: 2 },
      ]);
    } finally {
      spawnMock.mockReset();
    }
  });

  it('spawns the binary the host resolves, and reports it in the command', async () => {
    spawnMock.mockReset().mockImplementation(() => createMockChild(0));
    try {
      const result = await runBackendTurn({
        ...spawnContext,
        backend: 'claude',
        sbSlug: 'wren',
        prompt: 'ping',
        host: fakeHost({ resolveBinary: async (name) => `/synthetic/bin/${name}` }),
      });
      expect(spawnMock.mock.calls[0]?.[0]).toBe('/synthetic/bin/mock-backend');
      expect(result.command).toBe('/synthetic/bin/mock-backend ping');
    } finally {
      spawnMock.mockReset();
    }
  });

  it('removes the per-spawn files and spawns nothing when the host cannot hand over credentials', async () => {
    spawnMock.mockReset().mockImplementation(() => createMockChild(0));
    state.cleanups = 0;
    try {
      await expect(
        runBackendTurn({
          ...spawnContext,
          backend: 'claude',
          sbSlug: 'wren',
          prompt: 'ping',
          host: fakeHost({
            sessionEnv: async () => {
              throw new Error('synthetic mint failure');
            },
          }),
        })
      ).rejects.toThrow('synthetic mint failure');
      expect(spawnMock).not.toHaveBeenCalled();
      expect(state.cleanups).toBe(1);
    } finally {
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
      child.emit('close', null, 'SIGTERM');
      const result = await resultPromise;
      expect(result.timedOut).toBe(true);
      expect(result.timeoutType).toBe('hard');
      expect(result.exitCode).toBe(124);
      expect(result.childExited).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // The turn is over when its child is, not when a signal was sent: the
  // per-spawn files are removed after the close, and abort's SIGKILL is
  // cancelled by it (#701 P2).
  describe('lifetime', () => {
    /** A child that closes only when the test says so, and records kill(). */
    function createHeldChild() {
      const stream = () => Object.assign(new EventEmitter(), { setEncoding: () => undefined });
      return Object.assign(new EventEmitter(), {
        stdout: stream(),
        stderr: stream(),
        kill: vi.fn(),
      });
    }

    /** Preparation is asynchronous: the child exists once spawn was called. */
    const untilSpawned = () => vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    // The adapter's effective-config check (Myra, #701 9bd3f8a9, 5f569213,
    // 2c705c16): given the session's names from the spawn's own additions,
    // a probe env with none of them, and a refusal that spawns nothing.
    describe('effective-config check', () => {
      const credentialHost = () =>
        fakeHost({
          sessionEnv: async () => ({
            INK_ACCESS_TOKEN: 'synthetic-token',
            INK_DELEGATION_SECRET: 'synthetic-secret',
          }),
          baseEnv: async () => ({
            HOME: '/synthetic/home',
            PATH: '/synthetic/bin',
            SYNTHETIC_HOST_ONLY: 'x',
          }),
        });

      it("is given the session's names from the spawn's additions, and a probe env with none of them", async () => {
        const seen: EffectiveConfigCheck[] = [];
        state.preparedEnv = { AGENT_ID: 'wren', SB_SLUG: 'wren', HOME: '/synthetic/adapter-home' };
        state.check = async (check) => {
          seen.push(check);
          return undefined;
        };
        spawnMock.mockReset().mockImplementation(() => createMockChild(0));
        try {
          const result = await runBackendTurn({
            ...spawnContext,
            backend: 'codex',
            sbSlug: 'wren',
            prompt: 'synthetic',
            host: credentialHost(),
          });
          expect(result.success).toBe(true);
          expect(seen).toHaveLength(1);
          const check = seen[0]!;
          // The credentials' names are there, and so is the adapter's own
          // AGENT_ID; an allowlisted basic (HOME) is not.
          expect(check.sessionEnvNames).toEqual(
            expect.arrayContaining(['INK_ACCESS_TOKEN', 'INK_DELEGATION_SECRET', 'AGENT_ID'])
          );
          expect(check.sessionEnvNames).not.toContain('HOME');
          // The probe env is the base env through the allowlist, nothing more.
          expect(check.probeEnv).toEqual({ HOME: '/synthetic/home', PATH: '/synthetic/bin' });
          const inherited = new Set(SPAWN_ENV_INHERITED_NAMES);
          expect(Object.keys(check.probeEnv).every((name) => inherited.has(name))).toBe(true);
          expect(check.inkwellMcpUrl).toBe('http://localhost:3001/mcp');
          expect(check.binary).toBe('mock-backend');
          // The adapter's own env, as prepared, for settings it passes that way.
          expect(check.adapterEnv).toEqual(state.preparedEnv);
          expect(check.timeoutMs).toBeGreaterThan(0);
          expect(check.timeoutMs).toBeLessThanOrEqual(10_000);
          // Nothing the spawn would not get, and none of the session's own
          // names (Myra, c41d867e).
          const spawnEnv = spawnMock.mock.calls[0]![2].env as Record<string, string>;
          const probeNames = Object.keys(check.probeEnv);
          expect(probeNames.every((name) => name in spawnEnv)).toBe(true);
          expect(probeNames.filter((name) => check.sessionEnvNames.includes(name))).toEqual([]);
        } finally {
          state.check = undefined;
          state.preparedEnv = {};
          spawnMock.mockReset();
        }
      });

      it('is given the launch config the adapter prepared, and an empty one when it prepared none (Lumen, #701 cb80aa4b)', async () => {
        const seen: EffectiveConfigCheck[] = [];
        state.check = async (check) => {
          seen.push(check);
          return undefined;
        };
        spawnMock.mockReset().mockImplementation(() => createMockChild(0));
        try {
          state.preparedLaunchConfig = { args: ['-c', 'synthetic.key=1'] };
          await runBackendTurn({
            ...spawnContext,
            backend: 'codex',
            sbSlug: 'wren',
            prompt: 'synthetic',
            host: credentialHost(),
          });
          state.preparedLaunchConfig = undefined;
          await runBackendTurn({
            ...spawnContext,
            backend: 'codex',
            sbSlug: 'wren',
            prompt: 'synthetic',
            host: credentialHost(),
          });
          expect(seen.map((check) => check.launchConfig)).toEqual([
            { args: ['-c', 'synthetic.key=1'] },
            { args: [] },
          ]);
        } finally {
          state.check = undefined;
          state.preparedLaunchConfig = undefined;
          spawnMock.mockReset();
        }
      });

      it('spawns nothing on a refusal, reports the fixed reason, and removes the per-spawn files', async () => {
        state.cleanups = 0;
        state.check = async () => 'synthetic fixed refusal';
        spawnMock.mockReset().mockImplementation(() => createMockChild(0));
        try {
          const result = await runBackendTurn({
            ...spawnContext,
            backend: 'codex',
            sbSlug: 'wren',
            prompt: 'synthetic',
            host: credentialHost(),
          });
          expect(result).toMatchObject({
            success: false,
            exitCode: CONFIG_REFUSED_EXIT_CODE,
            stderr: 'synthetic fixed refusal',
            childExited: true,
          });
          expect(spawnMock).not.toHaveBeenCalled();
          expect(state.cleanups).toBe(1);
        } finally {
          state.check = undefined;
          spawnMock.mockReset();
        }
      });

      it('ends the check on abort, and reports the abort, not what the check answered', async () => {
        let checkSignal: AbortSignal | undefined;
        // An aborted Codex probe answers with a reason (`aborted`), so the
        // abort must win over it (Myra's M4, c41d867e).
        state.check = (check) =>
          new Promise((resolve) => {
            checkSignal = check.signal;
            check.signal.addEventListener('abort', () => resolve('synthetic reason on abort'));
          });
        spawnMock.mockReset().mockImplementation(() => createMockChild(0));
        try {
          const turn = startBackendTurn({
            ...spawnContext,
            backend: 'codex',
            sbSlug: 'wren',
            prompt: 'synthetic',
            host: credentialHost(),
          });
          await vi.waitFor(() => expect(checkSignal).toBeDefined());
          turn.abort();
          expect(await turn.result).toMatchObject({ exitCode: 143, childExited: true });
          expect(checkSignal!.aborted).toBe(true);
          expect(spawnMock).not.toHaveBeenCalled();
        } finally {
          state.check = undefined;
          spawnMock.mockReset();
        }
      });

      it("takes the check's time out of the spawn's ceiling (Myra, 2c705c16)", async () => {
        vi.useFakeTimers();
        const child = createHeldChild();
        state.check = () => new Promise((resolve) => setTimeout(() => resolve(undefined), 300));
        spawnMock.mockReset().mockImplementation(() => child);
        try {
          const turn = startBackendTurn({
            ...spawnContext,
            backend: 'codex',
            sbSlug: 'wren',
            prompt: 'synthetic',
            timeoutMs: 400,
          });
          await vi.advanceTimersByTimeAsync(300);
          expect(spawnMock).toHaveBeenCalledTimes(1);
          // 400 minted, 300 spent in the check: the child has 100 left.
          await vi.advanceTimersByTimeAsync(100);
          expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
          child.emit('close', null, 'SIGTERM');
          expect(await turn.result).toMatchObject({ timedOut: true, exitCode: 124 });
        } finally {
          state.check = undefined;
          vi.useRealTimers();
          spawnMock.mockReset();
        }
      });

      // A slow mint (Myra's M1 and M2a, c41d867e): the check's budget, and
      // then the child's ceiling, count from before the mint.
      const slowMintHost = (mintMs: number) =>
        fakeHost({
          sessionEnv: () => new Promise((resolve) => setTimeout(() => resolve({}), mintMs)),
        });

      it('gives the check only what the mint left', async () => {
        vi.useFakeTimers();
        const seen: number[] = [];
        state.check = async (check) => {
          seen.push(check.timeoutMs);
          return 'synthetic refusal';
        };
        spawnMock.mockReset().mockImplementation(() => createMockChild(0));
        try {
          const turn = startBackendTurn({
            ...spawnContext,
            backend: 'codex',
            sbSlug: 'wren',
            prompt: 'synthetic',
            timeoutMs: 400,
            host: slowMintHost(300),
          });
          await vi.advanceTimersByTimeAsync(300);
          expect(await turn.result).toMatchObject({ exitCode: CONFIG_REFUSED_EXIT_CODE });
          expect(seen).toEqual([100]);
        } finally {
          state.check = undefined;
          vi.useRealTimers();
          spawnMock.mockReset();
        }
      });

      it('reports a deadline, not a refusal, when the mint spent the whole budget', async () => {
        vi.useFakeTimers();
        const check = vi.fn(async () => 'synthetic refusal');
        state.check = check;
        spawnMock.mockReset().mockImplementation(() => createMockChild(0));
        try {
          const turn = startBackendTurn({
            ...spawnContext,
            backend: 'codex',
            sbSlug: 'wren',
            prompt: 'synthetic',
            timeoutMs: 400,
            host: slowMintHost(500),
          });
          await vi.advanceTimersByTimeAsync(500);
          expect(await turn.result).toMatchObject({ exitCode: 124, timedOut: true });
          expect(check).not.toHaveBeenCalled();
          expect(spawnMock).not.toHaveBeenCalled();
        } finally {
          state.check = undefined;
          vi.useRealTimers();
          spawnMock.mockReset();
        }
      });

      it('refuses with a fixed reason when the check rejects', async () => {
        state.check = async () => {
          throw new Error('synthetic-canary-check-threw');
        };
        spawnMock.mockReset().mockImplementation(() => createMockChild(0));
        try {
          const result = await runBackendTurn({
            ...spawnContext,
            backend: 'codex',
            sbSlug: 'wren',
            prompt: 'synthetic',
          });
          expect(result).toMatchObject({
            exitCode: CONFIG_REFUSED_EXIT_CODE,
            stderr: EFFECTIVE_CONFIG_CHECK_FAILED,
          });
          expect(result.stderr).not.toContain('synthetic-canary');
          expect(spawnMock).not.toHaveBeenCalled();
        } finally {
          state.check = undefined;
          spawnMock.mockReset();
        }
      });
    });

    // One run, one deadline: a continuation late in the run gets the time
    // left, and its credentials are minted for exactly that (Lumen, ff78c1b3).
    it('ends a spawn by the run’s deadline, and mints for the time left', async () => {
      vi.useFakeTimers();
      try {
        const child = createHeldChild();
        spawnMock.mockReset().mockImplementation(() => child);
        const deadlineAt = Date.now() + 1_000;
        const asked: Array<{ hardTimeoutMs: number; leftAtMint: number }> = [];
        const turn = startBackendTurn({
          ...spawnContext,
          backend: 'claude',
          sbSlug: 'wren',
          prompt: 'synthetic continuation',
          host: fakeHost({
            deadlineAt,
            sessionEnv: async ({ hardTimeoutMs }) => {
              asked.push({ hardTimeoutMs, leftAtMint: deadlineAt - Date.now() });
              // The mint takes 300 ms: the child still ends at the deadline.
              vi.setSystemTime(Date.now() + 300);
              return {};
            },
          }),
        });
        // waitFor moves the fake clock while it polls, so measure what is
        // left rather than assume the whole second.
        await untilSpawned();
        expect(asked).toHaveLength(1);
        expect(asked[0]!.hardTimeoutMs).toBe(asked[0]!.leftAtMint);
        expect(asked[0]!.hardTimeoutMs).toBeGreaterThan(0);
        expect(asked[0]!.hardTimeoutMs).toBeLessThanOrEqual(1_000);
        const left = deadlineAt - Date.now();
        await vi.advanceTimersByTimeAsync(left - 1);
        expect(child.kill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
        child.emit('close', null, 'SIGTERM');
        expect(await turn.result).toMatchObject({ timedOut: true, timeoutType: 'hard' });
      } finally {
        vi.useRealTimers();
        spawnMock.mockReset();
      }
    });

    it('starts nothing when the deadline passes while its credentials are minted', async () => {
      vi.useFakeTimers();
      spawnMock.mockReset().mockImplementation(() => createHeldChild());
      try {
        const deadlineAt = Date.now() + 100;
        const result = await runBackendTurn({
          ...spawnContext,
          backend: 'claude',
          sbSlug: 'wren',
          prompt: 'synthetic',
          host: fakeHost({
            deadlineAt,
            sessionEnv: async () => {
              vi.setSystemTime(deadlineAt + 1);
              return {};
            },
          }),
        });
        expect(result).toMatchObject({ exitCode: 124, timedOut: true, childExited: true });
        expect(spawnMock).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
        spawnMock.mockReset();
      }
    });

    it('keeps a spawn’s own ceiling when it is shorter than the time left', async () => {
      spawnMock.mockReset().mockImplementation(() => createMockChild(0));
      const asked: number[] = [];
      try {
        await runBackendTurn({
          ...spawnContext,
          backend: 'claude',
          sbSlug: 'wren',
          prompt: 'synthetic',
          timeoutMs: 500,
          host: fakeHost({
            deadlineAt: Date.now() + 60 * 60 * 1000,
            sessionEnv: async ({ hardTimeoutMs }) => {
              asked.push(hardTimeoutMs);
              return {};
            },
          }),
        });
        expect(asked).toEqual([500]);
      } finally {
        spawnMock.mockReset();
      }
    });

    it('starts nothing, and mints nothing, once the run’s deadline has passed', async () => {
      spawnMock.mockReset().mockImplementation(() => createHeldChild());
      state.cleanups = 0;
      const sessionEnv = vi.fn(async () => ({}));
      try {
        const result = await runBackendTurn({
          ...spawnContext,
          backend: 'claude',
          sbSlug: 'wren',
          prompt: 'synthetic',
          host: fakeHost({ deadlineAt: Date.now() - 1, sessionEnv }),
        });
        expect(result).toMatchObject({
          success: false,
          exitCode: 124,
          timedOut: true,
          timeoutType: 'hard',
          childExited: true,
        });
        expect(spawnMock).not.toHaveBeenCalled();
        expect(sessionEnv).not.toHaveBeenCalled();
        expect(state.cleanups).toBe(1);
      } finally {
        spawnMock.mockReset();
      }
    });

    it('an abort during preparation mints and spawns nothing, and removes the per-spawn files', async () => {
      spawnMock.mockReset().mockImplementation(() => createHeldChild());
      state.cleanups = 0;
      // A minting host's credential for an aborted turn would stay live until
      // its expiry (Myra, P2b-2a review).
      const sessionEnv = vi.fn(async () => ({}));
      try {
        const turn = startBackendTurn({
          ...spawnContext,
          backend: 'claude',
          sbSlug: 'wren',
          prompt: 'synthetic',
          host: fakeHost({ sessionEnv }),
        });
        turn.abort();
        expect(await turn.result).toMatchObject({
          success: false,
          exitCode: 143,
          stderr: 'aborted before the backend was spawned',
          timedOut: false,
          childExited: true,
        });
        expect(sessionEnv).not.toHaveBeenCalled();
        expect(spawnMock).not.toHaveBeenCalled();
        expect(state.cleanups).toBe(1);
      } finally {
        spawnMock.mockReset();
      }
    });

    // Settled means the per-spawn cleanup has finished its attempt: a hosted
    // run releases on this result (Myra's R1, 72027fba review). Removal
    // errors are swallowed, so it is not proof every file is gone.
    it('settles only once its per-spawn cleanup has finished', async () => {
      spawnMock.mockReset().mockImplementation(() => createMockChild(0));
      state.cleanups = 0;
      let openGate!: () => void;
      state.cleanupGate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      try {
        let settled = false;
        const result = runBackendTurn({
          ...spawnContext,
          backend: 'claude',
          sbSlug: 'wren',
          prompt: 'synthetic',
        }).then((value) => {
          settled = true;
          return value;
        });
        await vi.waitFor(() => expect(state.cleanups).toBe(1));
        // The child has closed and cleanup has begun, but not finished.
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(settled).toBe(false);

        openGate();
        expect(await result).toMatchObject({ success: true, childExited: true });
      } finally {
        state.cleanupGate = undefined;
        spawnMock.mockReset();
      }
    });

    it('an abort during the mint spawns nothing', async () => {
      spawnMock.mockReset().mockImplementation(() => createHeldChild());
      let turn: ReturnType<typeof startBackendTurn> | undefined;
      const sessionEnv = vi.fn(async () => {
        turn!.abort();
        return {};
      });
      try {
        turn = startBackendTurn({
          ...spawnContext,
          backend: 'claude',
          sbSlug: 'wren',
          prompt: 'synthetic',
          host: fakeHost({ sessionEnv }),
        });
        expect(await turn.result).toMatchObject({ exitCode: 143, childExited: true });
        expect(sessionEnv).toHaveBeenCalledTimes(1);
        expect(spawnMock).not.toHaveBeenCalled();
      } finally {
        spawnMock.mockReset();
      }
    });

    it('abort() sends SIGTERM, and the close cancels its SIGKILL', async () => {
      vi.useFakeTimers();
      try {
        const child = createHeldChild();
        spawnMock.mockReset().mockImplementation(() => child);
        const turn = startBackendTurn({
          ...spawnContext,
          backend: 'claude',
          sbSlug: 'wren',
          prompt: 'synthetic',
        });
        await untilSpawned();
        turn.abort();
        expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
        child.emit('close', null, 'SIGTERM');
        const result = await turn.result;
        expect(result).toMatchObject({ exitCode: 143, timedOut: false, childExited: true });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
      } finally {
        vi.useRealTimers();
        spawnMock.mockReset();
      }
    });

    it('abort() escalates to SIGKILL after three seconds', async () => {
      vi.useFakeTimers();
      try {
        const child = createHeldChild();
        spawnMock.mockReset().mockImplementation(() => child);
        const turn = startBackendTurn({
          ...spawnContext,
          backend: 'claude',
          sbSlug: 'wren',
          prompt: 'synthetic',
        });
        await untilSpawned();
        turn.abort();
        await vi.advanceTimersByTimeAsync(2_999);
        expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
        await vi.advanceTimersByTimeAsync(1);
        expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
        child.emit('close', null, 'SIGKILL');
        expect(await turn.result).toMatchObject({ exitCode: 137, childExited: true });
      } finally {
        vi.useRealTimers();
        spawnMock.mockReset();
      }
    });

    it('says so when it gave up on a child that never closed', async () => {
      vi.useFakeTimers();
      try {
        const child = createHeldChild();
        spawnMock.mockReset().mockImplementation(() => child);
        const turn = startBackendTurn({
          ...spawnContext,
          backend: 'claude',
          sbSlug: 'wren',
          prompt: 'synthetic',
        });
        await untilSpawned();
        turn.abort();
        await vi.advanceTimersByTimeAsync(3_000 + 5_000);
        expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
        expect(await turn.result).toMatchObject({
          success: false,
          exitCode: 137,
          childExited: false,
        });
      } finally {
        vi.useRealTimers();
        spawnMock.mockReset();
      }
    });

    it('removes the per-spawn files only after the timed-out child has closed', async () => {
      vi.useFakeTimers();
      try {
        state.cleanups = 0;
        const child = createHeldChild();
        spawnMock.mockReset().mockImplementation(() => child);
        const turn = startBackendTurn({
          ...spawnContext,
          backend: 'claude',
          sbSlug: 'wren',
          prompt: 'synthetic',
          timeoutMs: 100,
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
        expect(state.cleanups).toBe(0);

        child.emit('close', null, 'SIGTERM');
        expect(await turn.result).toMatchObject({ timedOut: true, exitCode: 124 });
        expect(state.cleanups).toBe(1);
      } finally {
        vi.useRealTimers();
        spawnMock.mockReset();
      }
    });
  });
});
