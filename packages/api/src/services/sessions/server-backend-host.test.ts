/**
 * The API server's BackendHost (spec:live-agent-surfaces, P2c): built from
 * explicit inputs for one admitted run, minting per spawn against the run's
 * one deadline, and failing a spawn it has no credential for.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { STOP_GIVE_UP_MS, STOP_GRACE_MS } from '@inklabs/shared';
import type { BackendRunResult, BackendTurnHandle } from '@inklabs/shared/providers';
import { listOwnedChildren, registerActiveRun, resetActiveRuns } from './active-runs.js';
import {
  MINT_SKEW_MS,
  SERVER_HOST_REFUSALS,
  createServerBackendHost,
  ownBackendTurn,
  type ServerBackendHostInput,
} from './server-backend-host.js';

const STARTED_AT = 1_800_000_000_000;
const BUDGET_MS = 4 * 60 * 60 * 1000;
const GRACE_MS = STOP_GRACE_MS + STOP_GIVE_UP_MS + MINT_SKEW_MS;

let clock = STARTED_AT;

function admit(turnEpoch = 'epoch-1') {
  registerActiveRun({
    sessionId: 'session-1',
    userId: 'user-1',
    sbSlug: 'synthetic-sb',
    backend: 'ink',
    startedAt: STARTED_AT,
    turnEpoch,
  });
}

function input(overrides: Partial<ServerBackendHostInput> = {}): ServerBackendHostInput {
  return {
    admission: { sessionId: 'session-1', turnEpoch: 'epoch-1' },
    budgetMs: BUDGET_MS,
    baseEnv: { HOME: '/synthetic/home', PATH: '/synthetic/bin' },
    paths: {
      inkFiles: '/synthetic/home/.ink/files',
      studiosRoot: '/synthetic/home/.ink/studios',
      tempDir: '/synthetic/tmp',
    },
    inkwellMcpUrl: 'http://localhost:3001/mcp',
    mintAccessToken: vi.fn(() => 'synthetic-token'),
    resolveBinary: vi.fn(async (name: string) => `/synthetic/bin/${name}`),
    claudeSupportsPartialMessages: vi.fn(async () => true),
    skillMcpServers: vi.fn(async () => []),
    warn: vi.fn(),
    now: () => clock,
    ...overrides,
  };
}

beforeEach(() => {
  resetActiveRuns();
  clock = STARTED_AT;
});
afterEach(() => resetActiveRuns());

describe('createServerBackendHost', () => {
  it('serves only the generation admitted for its session now', () => {
    expect(() => createServerBackendHost(input())).toThrow(/admitted/);
    admit('epoch-1');
    expect(() =>
      createServerBackendHost(input({ admission: { sessionId: 'session-1', turnEpoch: 'other' } }))
    ).toThrow(/admitted/);
    expect(() => createServerBackendHost(input())).not.toThrow();
    // A takeover replaces the generation: the old one gets no new host.
    admit('epoch-2');
    expect(() => createServerBackendHost(input())).toThrow(/admitted/);
  });

  it('refuses a budget that is not finite and positive, a relative path, and an unreadable MCP URL', () => {
    admit();
    for (const budgetMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createServerBackendHost(input({ budgetMs })), String(budgetMs)).toThrow(
        RangeError
      );
    }
    expect(() =>
      createServerBackendHost(
        input({ paths: { inkFiles: 'relative', studiosRoot: '/a', tempDir: '/b' } })
      )
    ).toThrow(/inkFiles path must be absolute/);
    expect(() => createServerBackendHost(input({ inkwellMcpUrl: 'not a url' }))).toThrow(
      /cannot be read/
    );
  });

  it("puts the run's one deadline at admission plus the budget", () => {
    admit();
    expect(createServerBackendHost(input()).deadlineAt).toBe(STARTED_AT + BUDGET_MS);
  });

  it('answers every other port from its inputs, and names no ambient session', async () => {
    admit();
    const given = input();
    const host = createServerBackendHost(given);
    expect(host.ambientSession()).toEqual({});
    expect(host.paths).toEqual(given.paths);
    expect(host.inkwellMcpUrl).toBe('http://localhost:3001/mcp');
    expect(await host.resolveBinary('codex')).toBe('/synthetic/bin/codex');
    expect(await host.claudeSupportsPartialMessages()).toBe(true);
    expect(await host.skillMcpServers('/synthetic/studio')).toEqual([]);
    expect(given.skillMcpServers).toHaveBeenCalledWith('/synthetic/studio');
    host.warn('synthetic warning');
    expect(given.warn).toHaveBeenCalledWith('synthetic warning');
  });

  it('hands every child the base env captured at creation, never the server env', async () => {
    admit();
    vi.stubEnv('SYNTHETIC_SERVER_ONLY', 'server-value');
    try {
      const source: Record<string, string | undefined> = { HOME: '/synthetic/home' };
      const host = createServerBackendHost(input({ baseEnv: source }));
      source.HOME = '/changed';
      source.LATER = 'added';
      const base = await host.baseEnv();
      expect(base).toEqual({ HOME: '/synthetic/home' });
      expect(Object.isFrozen(base)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("never reads the server's own env, cwd or home", () => {
    const source = readFileSync(join(__dirname, 'server-backend-host.ts'), 'utf8')
      // Prose may name them; code may not.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const ambient of ['process.env', 'process.cwd', 'homedir(', 'tmpdir(']) {
      expect(source, ambient).not.toContain(ambient);
    }
  });
});

describe('sessionEnv', () => {
  it('mints per spawn, for the ceiling plus the settlement grace and the skew', async () => {
    admit();
    const given = input();
    const host = createServerBackendHost(given);
    clock = STARTED_AT + 60_000;

    const env = await host.sessionEnv({ hardTimeoutMs: 30 * 60 * 1000 });

    expect(env).toEqual({ INK_ACCESS_TOKEN: 'synthetic-token' });
    expect(given.mintAccessToken).toHaveBeenCalledWith({
      ttlSeconds: Math.ceil((30 * 60 * 1000 + GRACE_MS) / 1000),
    });
  });

  it("measures the lifetime from the run's deadline, never from a longer ceiling", async () => {
    admit();
    const given = input();
    const host = createServerBackendHost(given);
    // Ten seconds of the four hours left, whatever the spawn asks for.
    clock = STARTED_AT + BUDGET_MS - 10_000;

    await host.sessionEnv({ hardTimeoutMs: BUDGET_MS });

    expect(given.mintAccessToken).toHaveBeenCalledWith({
      ttlSeconds: Math.ceil((10_000 + GRACE_MS) / 1000),
    });
  });

  it('mints nothing once the deadline has passed', async () => {
    admit();
    const given = input();
    const host = createServerBackendHost(given);
    clock = STARTED_AT + BUDGET_MS;

    await expect(host.sessionEnv({ hardTimeoutMs: 1_000 })).rejects.toThrow(
      SERVER_HOST_REFUSALS.deadlinePassed
    );
    expect(given.mintAccessToken).not.toHaveBeenCalled();
  });

  it('refuses a ceiling that is not finite and positive', async () => {
    admit();
    const given = input();
    const host = createServerBackendHost(given);
    for (const hardTimeoutMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(host.sessionEnv({ hardTimeoutMs }), String(hardTimeoutMs)).rejects.toThrow(
        SERVER_HOST_REFUSALS.invalidCeiling
      );
    }
    expect(given.mintAccessToken).not.toHaveBeenCalled();
  });

  it('fails the spawn when no credential is minted, rather than fall back to any other', async () => {
    admit();
    for (const minted of [undefined, '', Promise.resolve(undefined)]) {
      const host = createServerBackendHost(
        input({ mintAccessToken: () => minted as string | undefined })
      );
      await expect(host.sessionEnv({ hardTimeoutMs: 1_000 })).rejects.toThrow(
        SERVER_HOST_REFUSALS.missingCredential
      );
    }
  });

  it('adds the delegation secret when the caller has one, from an async mint too', async () => {
    admit();
    const host = createServerBackendHost(
      input({
        mintAccessToken: async () => 'synthetic-async-token',
        delegationSecret: 'synthetic-delegation-secret',
      })
    );
    expect(await host.sessionEnv({ hardTimeoutMs: 1_000 })).toEqual({
      INK_ACCESS_TOKEN: 'synthetic-async-token',
      INK_DELEGATION_SECRET: 'synthetic-delegation-secret',
    });
  });
});

describe('ownBackendTurn', () => {
  function turn() {
    let settle!: (result: BackendRunResult) => void;
    let fail!: (error: Error) => void;
    const result = new Promise<BackendRunResult>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const handle: BackendTurnHandle = { result, abort: vi.fn() };
    const finish = (childExited: boolean) =>
      settle({
        success: childExited,
        stdout: '',
        stderr: '',
        exitCode: 0,
        durationMs: 1,
        command: 'synthetic',
        childExited,
      });
    return { handle, finish, fail };
  }
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('owns the turn under its generation, and gives it back on a confirmed exit', async () => {
    admit();
    const { handle, finish } = turn();
    expect(ownBackendTurn({ sessionId: 'session-1', turnEpoch: 'epoch-1' }, handle)).toBeDefined();
    expect(listOwnedChildren()).toHaveLength(1);

    finish(true);
    await flush();

    expect(listOwnedChildren()).toEqual([]);
  });

  it('keeps owning a turn that settled without a confirmed exit, or rejected', async () => {
    admit();
    const lingering = turn();
    const rejected = turn();
    ownBackendTurn({ sessionId: 'session-1', turnEpoch: 'epoch-1' }, lingering.handle);
    ownBackendTurn({ sessionId: 'session-1', turnEpoch: 'epoch-1' }, rejected.handle);

    lingering.finish(false);
    rejected.fail(new Error('synthetic turn failure'));
    await flush();

    expect(listOwnedChildren()).toHaveLength(2);
  });

  it('aborts a turn whose generation is no longer admitted, and owns nothing', () => {
    admit('epoch-1');
    admit('epoch-2');
    const { handle } = turn();

    expect(
      ownBackendTurn({ sessionId: 'session-1', turnEpoch: 'epoch-1' }, handle)
    ).toBeUndefined();

    expect(handle.abort).toHaveBeenCalledTimes(1);
    expect(listOwnedChildren()).toEqual([]);
  });
});
