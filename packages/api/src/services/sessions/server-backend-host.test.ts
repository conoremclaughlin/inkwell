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

/**
 * startHostedBackendTurn's ownership is tested against a stub runner, so a
 * turn can be held pending or settled with childExited false on demand. The
 * real runner is driven in server-backend-host.spawn.test.ts.
 */
const startTurn = vi.hoisted(() => vi.fn());
vi.mock('@inklabs/shared/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@inklabs/shared/providers')>()),
  startBackendTurn: startTurn,
}));

import { STOP_GIVE_UP_MS, STOP_GRACE_MS } from '@inklabs/shared';
import type { BackendRunResult, BackendTurnHandle } from '@inklabs/shared/providers';
import {
  closeIntakeAndDrain,
  listOwnedChildren,
  registerActiveRun,
  resetActiveRuns,
  stopOwnedChildren,
} from './active-runs.js';
import {
  MINT_SKEW_MS,
  SERVER_HOST_REFUSALS,
  createServerBackendHost,
  HostedSpawnRefusal,
  startHostedBackendTurn,
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

describe('admission after creation (Lumen, #701 873209b4)', () => {
  it('mints nothing for a host whose generation a takeover replaced, and refuses its spawn', async () => {
    admit('epoch-1');
    const given = input();
    const host = createServerBackendHost(given);
    expect(host.admitSpawn?.()).toBe(true);

    admit('epoch-2');

    await expect(host.sessionEnv({ hardTimeoutMs: 1_000 })).rejects.toThrow(HostedSpawnRefusal);
    await expect(host.sessionEnv({ hardTimeoutMs: 1_000 })).rejects.toThrow(
      SERVER_HOST_REFUSALS.notAdmitted
    );
    expect(given.mintAccessToken).not.toHaveBeenCalled();
    expect(host.admitSpawn?.()).toBe(false);
  });

  it('mints nothing, and refuses every spawn, once intake has closed', async () => {
    admit();
    const given = input();
    const host = createServerBackendHost(given);

    await closeIntakeAndDrain(10);

    await expect(host.sessionEnv({ hardTimeoutMs: 1_000 })).rejects.toThrow(
      SERVER_HOST_REFUSALS.notAdmitted
    );
    expect(given.mintAccessToken).not.toHaveBeenCalled();
    expect(host.admitSpawn?.()).toBe(false);
  });

  it('hands over nothing it minted after losing admission during the mint', async () => {
    admit('epoch-1');
    const given = input({
      mintAccessToken: vi.fn(async () => {
        admit('epoch-2');
        return 'minted-too-late';
      }),
    });
    const host = createServerBackendHost(given);

    await expect(host.sessionEnv({ hardTimeoutMs: 1_000 })).rejects.toThrow(
      SERVER_HOST_REFUSALS.notAdmitted
    );
    expect(given.mintAccessToken).toHaveBeenCalledTimes(1);
  });
});

describe('startHostedBackendTurn', () => {
  const request = {
    backend: 'claude',
    sbSlug: 'synthetic-sb',
    prompt: 'ping',
    cliAttached: false,
    workingDirectory: '/synthetic/studio',
    inkSessionId: 'session-1',
    studioId: 'studio-1',
  };

  function stubTurn() {
    let settle!: (result: BackendRunResult) => void;
    let fail!: (error: unknown) => void;
    const result = new Promise<BackendRunResult>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const abort = vi.fn();
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
    startTurn.mockImplementationOnce((given: { host: unknown }) => {
      // What is owned at the moment the runner starts.
      startedWith.push({ host: given.host, ownedAtStart: listOwnedChildren() });
      return { result, abort } satisfies BackendTurnHandle;
    });
    return { abort, finish, fail };
  }
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  let startedWith: unknown[] = [];

  beforeEach(() => {
    startTurn.mockReset();
    startedWith = [];
  });

  it('owns the turn before it starts, with the server host, and gives it back on a confirmed exit', async () => {
    admit();
    const turn = stubTurn();

    const { handle, ownership } = startHostedBackendTurn(input(), request);

    expect(ownership).toBeDefined();
    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(startedWith[0]).toMatchObject({
      host: { deadlineAt: STARTED_AT + BUDGET_MS },
      ownedAtStart: [{ sessionId: 'session-1', turnEpoch: 'epoch-1' }],
    });
    turn.finish(true);
    await handle.result;
    await flush();
    expect(listOwnedChildren()).toEqual([]);
  });

  it('starts nothing, and owns nothing, for a generation no longer admitted or after intake closed', async () => {
    admit('epoch-1');
    admit('epoch-2');
    expect(() => startHostedBackendTurn(input(), request)).toThrow(
      SERVER_HOST_REFUSALS.notAdmitted
    );

    resetActiveRuns();
    admit();
    await closeIntakeAndDrain(10);
    expect(() => startHostedBackendTurn(input(), request)).toThrow(
      SERVER_HOST_REFUSALS.notAdmitted
    );

    expect(startTurn).not.toHaveBeenCalled();
    expect(listOwnedChildren()).toEqual([]);
  });

  it('refuses a request for another session than the one admitted', () => {
    admit();
    expect(() =>
      startHostedBackendTurn(input(), { ...request, inkSessionId: 'someone-else' })
    ).toThrow(SERVER_HOST_REFUSALS.wrongSession);
    expect(startTurn).not.toHaveBeenCalled();
    expect(listOwnedChildren()).toEqual([]);
  });

  it('keeps a turn owned while pending, after a takeover, and after childExited:false; a drain stops it and reports it unconfirmed', async () => {
    admit('epoch-1');
    const lingering = stubTurn();
    startHostedBackendTurn(input(), request);

    // A takeover after the start does not drop the older generation's child.
    admit('epoch-2');
    expect(listOwnedChildren()).toEqual([{ sessionId: 'session-1', turnEpoch: 'epoch-1' }]);

    lingering.finish(false);
    await flush();
    expect(listOwnedChildren()).toHaveLength(1);

    const stopped = await stopOwnedChildren(50);
    expect(lingering.abort).toHaveBeenCalledTimes(1);
    expect(stopped.unconfirmed).toEqual([
      { sessionId: 'session-1', turnEpoch: 'epoch-1', reason: 'not-exited' },
    ]);
    expect(listOwnedChildren()).toHaveLength(1);
  });

  it('keeps a turn that rejects for an unknown reason, and releases one the host refused', async () => {
    admit();
    const unknown = stubTurn();
    const refused = stubTurn();
    startHostedBackendTurn(input(), request);
    startHostedBackendTurn(input(), request);

    unknown.fail(new Error('synthetic runner failure'));
    refused.fail(new HostedSpawnRefusal(SERVER_HOST_REFUSALS.notAdmitted));
    await flush();

    // Only the refusal proves no child started.
    expect(listOwnedChildren()).toHaveLength(1);
    expect((await stopOwnedChildren(50)).unconfirmed).toEqual([
      { sessionId: 'session-1', turnEpoch: 'epoch-1', reason: 'rejected' },
    ]);
  });

  it('gives the reservation back when the runner cannot start at all', () => {
    admit();
    startTurn.mockImplementationOnce(() => {
      throw new Error('synthetic unknown backend');
    });
    expect(() => startHostedBackendTurn(input(), request)).toThrow('synthetic unknown backend');
    expect(listOwnedChildren()).toEqual([]);
  });
});
