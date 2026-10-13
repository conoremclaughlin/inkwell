/** The real hosted launch path, with no filesystem, database or OS process effects. */
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  mode: 'close' as 'close' | 'wait' | 'unkillable' | 'throw',
  envs: [] as Array<Record<string, string>>,
  order: [] as string[],
  kills: [] as string[],
  cleanups: 0,
  close: [] as Array<() => void>,
  checkRefusal: undefined as string | undefined,
}));
vi.mock('child_process', () => ({
  execFile: vi.fn(() => {
    throw new Error('no probe process is permitted');
  }),
  spawn: (_binary: string, _args: string[], options: { env: Record<string, string> }) => {
    state.order.push('spawn');
    if (state.mode === 'throw') throw new Error('synthetic spawn uncertainty');
    state.envs.push(options.env);
    const stream = () => Object.assign(new EventEmitter(), { setEncoding() {} });
    const child = Object.assign(new EventEmitter(), {
      pid: 4242 + state.envs.length,
      stdout: stream(),
      stderr: stream(),
      kill: (signal: string) => {
        state.kills.push(signal);
        if (state.mode !== 'unkillable') queueMicrotask(() => child.emit('close', null, signal));
        return true;
      },
    });
    state.close.push(() => child.emit('close', 0, null));
    if (state.mode === 'close') queueMicrotask(() => child.emit('close', 0, null));
    return child;
  },
}));
vi.mock('../../../../shared/src/providers/registry.js', () => ({
  getBackend: () => ({
    prepare: async () => ({
      binary: '/synthetic/provider',
      args: [],
      // Neither credentials nor adapter config may reuse an earlier row.
      env: { INK_LAUNCH_ID: 'stale-adapter-launch' },
      cleanup: async () => {
        state.cleanups += 1;
      },
    }),
    checkEffectiveConfig: async () => state.checkRefusal,
  }),
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { STOP_GIVE_UP_MS } from '@inklabs/shared';
import { runBackendTurn, SPAWN_NOT_ADMITTED_EXIT_CODE } from '@inklabs/shared/providers';
import { listOwnedChildren, registerActiveRun, resetActiveRuns } from './active-runs.js';
import {
  createServerBackendHost,
  HostedSpawnRefusal,
  SERVER_HOST_REFUSALS,
  startHostedBackendTurn,
  type ServerBackendHostInput,
} from './server-backend-host.js';
import type { LaunchReservation } from './launched-processes.js';

const admission = { sessionId: 'synthetic-session', turnEpoch: 'synthetic-epoch' };
const request = (backend = 'claude') => ({
  backend,
  sbSlug: 'synthetic-sb',
  prompt: 'ping',
  workingDirectory: '/synthetic/studio',
  inkSessionId: admission.sessionId,
  cliAttached: false,
});
const reserved = () => ({
  env: { INK_LAUNCH_ID: 'synthetic-launch' },
  spawned: vi.fn(),
  exited: vi.fn(),
});
function input(overrides: Partial<ServerBackendHostInput> = {}): ServerBackendHostInput {
  return {
    admission,
    budgetMs: 60_000,
    baseEnv: { HOME: '/synthetic/home', PATH: '/synthetic/bin' },
    paths: {
      inkFiles: '/synthetic/files',
      studiosRoot: '/synthetic/studios',
      tempDir: '/synthetic/tmp',
    },
    inkwellMcpUrl: 'http://localhost:4991/mcp',
    mintAccessToken: async () => 'synthetic-token',
    resolveBinary: async (name) => name,
    claudeSupportsPartialMessages: async () => false,
    skillMcpServers: async () => [],
    warn: vi.fn(),
    ...overrides,
  };
}
beforeEach(() => {
  resetActiveRuns();
  state.mode = 'close';
  state.envs = [];
  state.order = [];
  state.kills = [];
  state.close = [];
  state.cleanups = 0;
  state.checkRefusal = undefined;
  registerActiveRun({
    ...admission,
    userId: 'synthetic-user',
    sbSlug: 'synthetic-sb',
    backend: 'ink',
    startedAt: Date.now(),
  });
});
afterEach(() => {
  resetActiveRuns();
  vi.useRealTimers();
});

describe('hosted provider attempt recording', () => {
  it.each([
    ['claude', 'claude-code'],
    ['codex', 'codex-cli'],
    ['gemini', 'gemini'],
  ])(
    '%s reserves its own executable row before spawn, tags first, records pid and confirms exit',
    async (backend, key) => {
      const row = reserved();
      row.spawned.mockImplementation(() => {
        state.order.push('pid');
      });
      row.exited.mockImplementation(() => {
        state.order.push('exit');
      });
      const reserveLaunch = vi.fn(async () => {
        state.order.push('reserve');
        return row;
      });
      const { handle } = startHostedBackendTurn(input({ reserveLaunch }), request(backend));
      expect(await handle.result).toMatchObject({ success: true, childExited: true });
      expect(reserveLaunch).toHaveBeenCalledWith(admission.sessionId, key);
      expect(state.order).toEqual(['reserve', 'spawn', 'pid', 'exit']);
      expect(Object.keys(state.envs[0])[0]).toBe('INK_LAUNCH_ID');
      expect(state.envs[0].INK_LAUNCH_ID).toBe('synthetic-launch');
      // spawnBackend does not detach: a pid is not evidence of a group id.
      expect(row.spawned).toHaveBeenCalledWith({ pid: 4243 });
      expect(row.exited).toHaveBeenCalledTimes(1);
      expect(listOwnedChildren()).toEqual([]);
    }
  );

  it.each(['unconfigured', 'failed-store', 'refused', 'empty-tag'])(
    '%s recording refuses without spawning and returns ownership',
    async (kind) => {
      const reserveLaunch =
        kind === 'unconfigured'
          ? undefined
          : vi.fn(async () => {
              if (kind === 'failed-store') throw new Error('synthetic store failure');
              return {
                ...reserved(),
                ...(kind === 'refused' ? { refused: 'synthetic refusal' } : { env: {} }),
              };
            });
      const { handle } = startHostedBackendTurn(input({ reserveLaunch }), request());
      await expect(handle.result).rejects.toThrow(SERVER_HOST_REFUSALS.launchUnrecorded);
      expect(state.envs).toEqual([]);
      expect(listOwnedChildren()).toEqual([]);
      expect(state.cleanups).toBe(1);
    }
  );

  it('refuses an unknown executable identity rather than recording the outer ink backend', async () => {
    const reserveLaunch = vi.fn();
    const host = createServerBackendHost(input({ reserveLaunch }));
    await expect(host.reserveSpawn!('unknown')).rejects.toThrow(
      SERVER_HOST_REFUSALS.unknownProvider
    );
    expect(reserveLaunch).not.toHaveBeenCalled();
  });

  it('checks caller admission before minting and again immediately before spawning', async () => {
    let refused: string | undefined;
    const row = reserved();
    const given = input({
      admitSpawn: () => refused,
      reserveLaunch: async () => {
        refused = 'synthetic survivor hold';
        return row;
      },
    });
    const { handle } = startHostedBackendTurn(given, request());
    expect(await handle.result).toMatchObject({
      exitCode: SPAWN_NOT_ADMITTED_EXIT_CODE,
      childExited: true,
    });
    expect(state.envs).toEqual([]);
    expect(row.spawned).not.toHaveBeenCalled();
    expect(row.exited).toHaveBeenCalledOnce();
    expect(() => createServerBackendHost(given)).toThrow('synthetic survivor hold');
  });

  it('checks caller admission after an awaited mint', async () => {
    let refused: string | undefined;
    const reserveLaunch = vi.fn();
    const { handle } = startHostedBackendTurn(
      input({
        admitSpawn: () => refused,
        reserveLaunch,
        mintAccessToken: async () => {
          refused = 'synthetic hold';
          return 'synthetic-token';
        },
      }),
      request()
    );
    await expect(handle.result).rejects.toThrow('synthetic hold');
    expect(reserveLaunch).not.toHaveBeenCalled();
    expect(state.envs).toEqual([]);
  });

  it.each(['abort', 'deadline'])(
    'retires an unspawned record after %s during reservation',
    async (reason) => {
      let finish!: (row: LaunchReservation) => void;
      const reserveLaunch = vi.fn(
        () =>
          new Promise<LaunchReservation>((resolve) => {
            finish = resolve;
          })
      );
      const row = reserved();
      const { handle } = startHostedBackendTurn(input({ reserveLaunch }), request());
      await vi.waitFor(() => expect(reserveLaunch).toHaveBeenCalledOnce());
      if (reason === 'abort') handle.abort();
      else {
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 61_000);
      }
      finish(row);
      expect(await handle.result).toMatchObject({
        success: false,
        childExited: true,
        exitCode: reason === 'abort' ? 143 : 124,
      });
      expect(state.envs).toEqual([]);
      expect(row.exited).toHaveBeenCalledOnce();
    }
  );

  it('does not reserve a rejected effective configuration', async () => {
    state.checkRefusal = 'synthetic bad config';
    const reserveLaunch = vi.fn();
    const { handle } = startHostedBackendTurn(input({ reserveLaunch }), request('codex'));
    expect(await handle.result).toMatchObject({ success: false, childExited: true });
    expect(reserveLaunch).not.toHaveBeenCalled();
    expect(state.envs).toEqual([]);
  });

  it('leaves an unknown spawn outcome open instead of stamping it exited', async () => {
    state.mode = 'throw';
    const row = reserved();
    const { handle } = startHostedBackendTurn(input({ reserveLaunch: async () => row }), request());
    await expect(handle.result).rejects.toThrow('synthetic spawn uncertainty');
    expect(row.exited).not.toHaveBeenCalled();
    expect(listOwnedChildren()).toEqual([admission]);
  });

  it('leaves a child whose stop gave up recorded and owned', async () => {
    state.mode = 'unkillable';
    const row = reserved();
    const { handle } = startHostedBackendTurn(input({ reserveLaunch: async () => row }), request());
    await vi.waitFor(() => expect(state.envs).toHaveLength(1));
    vi.useFakeTimers();
    handle.abort();
    await vi.advanceTimersByTimeAsync(3000 + STOP_GIVE_UP_MS);
    expect(await handle.result).toMatchObject({ childExited: false });
    expect(state.kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(row.exited).not.toHaveBeenCalled();
    expect(listOwnedChildren()).toEqual([admission]);
  });

  it('stops and waits after a pid callback throws, never calls that a pre-spawn refusal', async () => {
    state.mode = 'wait';
    const row = reserved();
    row.spawned.mockImplementation(() => {
      throw new HostedSpawnRefusal('synthetic callback failure');
    });
    const { handle } = startHostedBackendTurn(input({ reserveLaunch: async () => row }), request());
    const error = await handle.result.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HostedSpawnRefusal);
    expect(state.kills).toEqual(['SIGTERM']);
    expect(row.exited).toHaveBeenCalledOnce();
  });

  it('keeps each concurrent attempt tied to its own reservation, even when the host is shared', async () => {
    state.mode = 'wait';
    const rows = [reserved(), reserved()];
    rows[0].env.INK_LAUNCH_ID = 'synthetic-first';
    rows[1].env.INK_LAUNCH_ID = 'synthetic-second';
    let index = 0;
    const host = createServerBackendHost(input({ reserveLaunch: async () => rows[index++] }));
    const first = runBackendTurn({ ...request(), host });
    const second = runBackendTurn({ ...request(), host });
    await vi.waitFor(() => expect(state.envs).toHaveLength(2));
    expect(state.envs.map((env) => env.INK_LAUNCH_ID)).toEqual([
      'synthetic-first',
      'synthetic-second',
    ]);
    state.close[1]();
    await second;
    expect(rows[0].exited).not.toHaveBeenCalled();
    expect(rows[1].exited).toHaveBeenCalledOnce();
    state.close[0]();
    await first;
    expect(rows[0].exited).toHaveBeenCalledOnce();
    expect(rows[0].spawned).toHaveBeenCalledWith({ pid: 4243 });
    expect(rows[1].spawned).toHaveBeenCalledWith({ pid: 4244 });
  });
});
