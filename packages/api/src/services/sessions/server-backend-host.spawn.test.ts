/**
 * A turn the API server would run through its own host (P2c): the REAL
 * runner and adapters, createServerBackendHost, and both OS process
 * boundaries replaced. No provider binary runs, and nothing is activated:
 * SessionService does not select this host yet.
 */
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(
  () =>
    [] as Array<{
      args: string[];
      env: Record<string, string>;
      kill: ReturnType<typeof import('vitest').vi.fn>;
    }>
);
const execFile = vi.hoisted(() => vi.fn());
/** When false, a spawned child runs until it is signalled. */
const exitAtOnce = vi.hoisted(() => ({ value: true }));

vi.mock('child_process', () => ({
  execFile,
  spawn: (_binary: string, args: string[], options: { env: Record<string, string> }) => {
    const stream = () => Object.assign(new EventEmitter(), { setEncoding: () => undefined });
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: stream(),
      stderr: stream(),
      stdin: Object.assign(new EventEmitter(), { write: () => true, end: () => undefined }),
      kill: vi.fn((signal: string) => {
        queueMicrotask(() => {
          child.emit('exit', null, signal);
          child.emit('close', null, signal);
        });
        return true;
      }),
    });
    spawned.push({ args: [...args], env: options.env, kill: child.kill });
    if (exitAtOnce.value) queueMicrotask(() => child.emit('close', 0, null));
    return child;
  },
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { SPAWN_NOT_ADMITTED_EXIT_CODE, runBackendTurn } from '@inklabs/shared/providers';
import {
  closeIntakeAndDrain,
  listOwnedChildren,
  registerActiveRun,
  resetActiveRuns,
  stopOwnedChildren,
} from './active-runs.js';
import {
  SERVER_HOST_REFUSALS,
  createServerBackendHost,
  startHostedBackendTurn,
  type ServerBackendHostInput,
} from './server-backend-host.js';

const admission = { sessionId: 'sess-hosted', turnEpoch: 'epoch-hosted' };
let home: string;

function admit(startedAt = Date.now(), turnEpoch = admission.turnEpoch) {
  registerActiveRun({
    sessionId: admission.sessionId,
    userId: 'user-synthetic',
    sbSlug: 'synthetic-sb',
    backend: 'ink',
    startedAt,
    turnEpoch,
  });
}

/** A takeover: a newer generation admitted for the same session. */
const takeOver = () => admit(Date.now(), 'epoch-newer');

function host(overrides: Partial<ServerBackendHostInput> = {}) {
  const { input, mintAccessToken } = hostInput(overrides);
  return { host: createServerBackendHost(input), mintAccessToken };
}

function hostInput(overrides: Partial<ServerBackendHostInput> = {}) {
  const mintAccessToken = vi.fn(() => 'minted-for-this-spawn');
  const input: ServerBackendHostInput = {
    admission,
    budgetMs: 60_000,
    // The server's captured env: its own session, credentials and a key no
    // child may inherit, beside the HOME and PATH the allowlist passes.
    baseEnv: {
      HOME: home,
      CODEX_HOME: join(home, '.codex'),
      PATH: '/usr/bin:/bin',
      INK_SESSION_ID: 'server-own-session',
      INK_ACCESS_TOKEN: 'server-own-token',
      JWT_SECRET: 'synthetic-jwt-secret',
      SUPABASE_SECRET_KEY: 'synthetic-supabase-key',
      SYNTHETIC_HOST_ONLY: 'host-only-value',
    },
    paths: {
      inkFiles: join(home, '.ink', 'files'),
      studiosRoot: join(home, '.ink', 'studios'),
      tempDir: home,
    },
    inkwellMcpUrl: 'http://localhost:3001/mcp',
    mintAccessToken,
    delegationSecret: 'synthetic-delegation-secret',
    resolveBinary: async (name) => name,
    claudeSupportsPartialMessages: async () => false,
    skillMcpServers: async () => [],
    warn: () => undefined,
    ...overrides,
  };
  return { input, mintAccessToken };
}

const request = (backend: string, made: ReturnType<typeof host>['host']) => ({
  backend,
  sbSlug: 'synthetic-sb',
  prompt: 'ping',
  cliAttached: false,
  workingDirectory: home,
  inkSessionId: admission.sessionId,
  studioId: 'studio-hosted',
  host: made,
});

const unhosted = (backend: string) => {
  const { host: _host, ...rest } = request(backend, undefined as never);
  return rest;
};

beforeEach(() => {
  resetActiveRuns();
  spawned.length = 0;
  exitAtOnce.value = true;
  home = mkdtempSync(join(tmpdir(), 'server-host-spawn-'));
  // The server process's own values: the host must never read them.
  vi.stubEnv('SYNTHETIC_PROCESS_ONLY', 'process-value');
  vi.stubEnv('INK_SESSION_ID', 'process-own-session');
  execFile
    .mockReset()
    .mockImplementation(
      (
        _binary: string,
        _args: string[],
        _options: unknown,
        callback: (error: null, stdout: string, stderr: string) => void
      ) => {
        callback(
          null,
          JSON.stringify([
            {
              name: 'inkwell',
              enabled: true,
              disabled_reason: null,
              transport: {
                type: 'streamable_http',
                url: 'http://localhost:3001/mcp',
                bearer_token_env_var: 'INK_ACCESS_TOKEN',
                http_headers: null,
                env_http_headers: null,
                http_headers_helper: null,
              },
            },
          ]),
          ''
        );
        return {};
      }
    );
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetActiveRuns();
  rmSync(home, { recursive: true, force: true });
});

describe('a turn run through the server host', () => {
  it.each(['claude', 'codex', 'gemini'])(
    '%s: the child gets the minted credential and its own session, and none of the server’s',
    async (backend) => {
      admit();
      const { host: made, mintAccessToken } = host();

      expect(await runBackendTurn(request(backend, made))).toMatchObject({ success: true });

      expect(spawned).toHaveLength(1);
      const { env } = spawned[0]!;
      expect(env.INK_ACCESS_TOKEN).toBe('minted-for-this-spawn');
      expect(env.INK_DELEGATION_SECRET).toBe('synthetic-delegation-secret');
      expect(env.INK_SESSION_ID).toBe(admission.sessionId);
      // The captured base env is the child's only inheritance, and only
      // through the allowlist.
      expect(env.HOME).toBe(home);
      for (const name of ['JWT_SECRET', 'SUPABASE_SECRET_KEY', 'SYNTHETIC_HOST_ONLY']) {
        expect(env, name).not.toHaveProperty(name);
      }
      expect(env).not.toHaveProperty('SYNTHETIC_PROCESS_ONLY');
      // One mint, for the spawn's ceiling (the 60 s run budget, less what
      // the preparation took) plus 70 s of grace and skew.
      expect(mintAccessToken).toHaveBeenCalledTimes(1);
      expect(mintAccessToken).toHaveBeenCalledWith({ ttlSeconds: 130 });
    }
  );

  it('codex: the configuration probe carries none of the session’s credentials', async () => {
    admit();
    const { host: made } = host();

    await runBackendTurn(request('codex', made));

    expect(execFile).toHaveBeenCalledTimes(1);
    const options = execFile.mock.calls[0]![2] as { env: Record<string, string> };
    expect(options.env.HOME).toBe(home);
    for (const name of ['INK_ACCESS_TOKEN', 'INK_DELEGATION_SECRET', 'JWT_SECRET']) {
      expect(options.env, name).not.toHaveProperty(name);
    }
  });

  it('starts no spawn, and mints nothing, once the run’s deadline has passed', async () => {
    // Admitted ten seconds ago with a five-second budget.
    admit(Date.now() - 10_000);
    const { host: made, mintAccessToken } = host({ budgetMs: 5_000 });

    expect(await runBackendTurn(request('codex', made))).toMatchObject({
      success: false,
      exitCode: 124,
      childExited: true,
    });
    expect(spawned).toHaveLength(0);
    expect(execFile).not.toHaveBeenCalled();
    expect(mintAccessToken).not.toHaveBeenCalled();
  });

  it('fails the turn before any spawn or probe when no credential is minted', async () => {
    admit();
    const { host: made } = host({ mintAccessToken: () => undefined });

    await expect(runBackendTurn(request('codex', made))).rejects.toThrow(
      SERVER_HOST_REFUSALS.missingCredential
    );
    expect(spawned).toHaveLength(0);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('is stopped through its admitted generation, which waits for the child to close', async () => {
    admit();
    exitAtOnce.value = false;
    const { handle } = startHostedBackendTurn(hostInput().input, unhosted('claude'));
    await vi.waitFor(() => expect(spawned).toHaveLength(1));

    const stopped = await stopOwnedChildren(2_000);

    expect(spawned[0]!.kill).toHaveBeenCalledWith('SIGTERM');
    expect(stopped).toEqual({ confirmed: [admission], unconfirmed: [] });
    expect(listOwnedChildren()).toEqual([]);
    expect(await handle.result).toMatchObject({ childExited: true, exitCode: 143 });
  });

  // Lumen, #701 873209b4: creation-time admission is not standing authority.
  it('a takeover after the start: nothing is minted or spawned, and the turn is given back', async () => {
    admit();
    const { input, mintAccessToken } = hostInput();
    const { handle } = startHostedBackendTurn(input, unhosted('codex'));
    takeOver();

    await expect(handle.result).rejects.toThrow(SERVER_HOST_REFUSALS.notAdmitted);
    await vi.waitFor(() => expect(listOwnedChildren()).toEqual([]));
    expect(mintAccessToken).not.toHaveBeenCalled();
    expect(spawned).toHaveLength(0);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('a takeover after the mint, before the spawn: the host withdraws the spawn', async () => {
    admit();
    const { input } = hostInput({
      // The last host call before the spawn; the takeover lands during it.
      resolveBinary: async (name) => {
        takeOver();
        return name;
      },
    });
    const { handle } = startHostedBackendTurn(input, unhosted('claude'));

    expect(await handle.result).toMatchObject({
      success: false,
      exitCode: SPAWN_NOT_ADMITTED_EXIT_CODE,
      childExited: true,
    });
    expect(spawned).toHaveLength(0);
    await vi.waitFor(() => expect(listOwnedChildren()).toEqual([]));
  });

  it('a takeover after the spawn: the older child stays owned and a drain still stops it', async () => {
    admit();
    exitAtOnce.value = false;
    const { handle } = startHostedBackendTurn(hostInput().input, unhosted('claude'));
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    takeOver();

    expect(listOwnedChildren()).toEqual([admission]);
    const stopped = await stopOwnedChildren(2_000);

    expect(stopped).toEqual({ confirmed: [admission], unconfirmed: [] });
    expect(await handle.result).toMatchObject({ childExited: true });
  });

  // Lumen, #701 d84b473b: the newer generation starts nothing beside the
  // older child until that child's exit is confirmed.
  it('a takeover over a running child: the newer generation starts nothing until the older exit is confirmed', async () => {
    admit();
    exitAtOnce.value = false;
    startHostedBackendTurn(hostInput().input, unhosted('claude'));
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    takeOver();
    const newer = { ...admission, turnEpoch: 'epoch-newer' };

    expect(() =>
      startHostedBackendTurn({ ...hostInput().input, admission: newer }, unhosted('claude'))
    ).toThrow(SERVER_HOST_REFUSALS.olderChildUnconfirmed);
    expect(spawned).toHaveLength(1);

    expect(await stopOwnedChildren(2_000)).toEqual({ confirmed: [admission], unconfirmed: [] });
    exitAtOnce.value = true;
    const { handle } = startHostedBackendTurn(
      { ...hostInput().input, admission: newer },
      unhosted('claude')
    );
    expect(await handle.result).toMatchObject({ success: true, childExited: true });
    expect(spawned).toHaveLength(2);
  });

  it('intake closing before the start: nothing starts', async () => {
    admit();
    await closeIntakeAndDrain(10);

    expect(() => startHostedBackendTurn(hostInput().input, unhosted('claude'))).toThrow(
      SERVER_HOST_REFUSALS.notAdmitted
    );
    expect(spawned).toHaveLength(0);
    expect(listOwnedChildren()).toEqual([]);
  });
});
