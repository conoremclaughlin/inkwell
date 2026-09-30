import { EventEmitter } from 'events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeContextToken, encodeContextToken } from '../runner/mcp-config.js';

/**
 * What a provider child is actually handed when a host spawns it for a
 * session: through the REAL adapters, with both OS process boundaries replaced.
 * The host process here carries its own, different session values, the way a
 * server hosting several sessions does, and none of them may reach the child.
 */

const spawned = vi.hoisted(
  () =>
    [] as Array<{
      args: string[];
      cwd?: string;
      env: Record<string, string>;
      mcp?: string;
      geminiSettings?: string;
    }>
);

const execFile = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => {
  return {
    execFile,
    spawn: (
      _binary: string,
      args: string[],
      options: { cwd?: string; env: Record<string, string> }
    ) => {
      // The MCP config and Gemini settings are temp files the turn deletes on
      // exit: read them now.
      const at = args.indexOf('--mcp-config');
      const mcp = at >= 0 ? readFileSync(args[at + 1], 'utf8') : undefined;
      const settingsPath = options.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
      const geminiSettings = settingsPath ? readFileSync(settingsPath, 'utf8') : undefined;
      spawned.push({ args: [...args], cwd: options.cwd, env: options.env, mcp, geminiSettings });
      const stream = () => Object.assign(new EventEmitter(), { setEncoding: () => undefined });
      const child = Object.assign(new EventEmitter(), {
        stdout: stream(),
        stderr: stream(),
        stdin: Object.assign(new EventEmitter(), { write: () => true, end: () => undefined }),
        kill: () => true,
      });
      queueMicrotask(() => child.emit('close', 0));
      return child;
    },
  };
});

import { runBackendTurn } from './backend-runner.js';
import type { BackendHost } from './types.js';

let studio: string;

/**
 * A host serving several sessions. Its own ambient session is the host's,
 * which a spawn that names its session must never use; each spawn's
 * credentials are the ones handed to it here. The probe is answered, never
 * run: no installed provider runs in a unit test.
 */
const serverHost = (credentials: Record<string, string>): BackendHost => ({
  paths: {
    inkFiles: join(studio, '.host-files'),
    studiosRoot: join(studio, '.host-studios'),
    tempDir: studio,
  },
  ambientSession: () => ({ inkSessionId: 'host-own-session', studioId: 'host-own-studio' }),
  claudeSupportsPartialMessages: async () => true,
  skillMcpServers: async () => [],
  sessionEnv: async () => ({ ...credentials }),
  baseEnv: async () => process.env,
  inkwellMcpUrl: 'http://localhost:3001/mcp',
  resolveBinary: async (name) => name,
  warn: () => undefined,
});

beforeEach(() => {
  spawned.length = 0;
  studio = mkdtempSync(join(tmpdir(), 'provider-context-'));
  vi.stubEnv('HOME', studio);
  vi.stubEnv('CODEX_HOME', join(studio, '.codex'));
  execFile
    .mockReset()
    .mockImplementation(
      (
        _binary: string,
        _args: string[],
        _options: unknown,
        callback: (error: null, stdout: string, stderr: string) => void
      ) => {
        // The effective-config guard still runs; only its listing process is
        // replaced. Never invoke an installed provider from this unit harness.
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
  // The host's own session, which a hosted spawn must never inherit.
  vi.stubEnv('INK_SESSION_ID', 'host-own-session');
  vi.stubEnv('INK_STUDIO_ID', 'host-own-studio');
  vi.stubEnv('INK_ACCESS_TOKEN', 'host-own-token');
  vi.stubEnv(
    'INK_CONTEXT',
    encodeContextToken({
      sessionId: 'host-own-session',
      studioId: 'host-own-studio',
      sbSlug: 'host',
      cliAttached: true,
      runtime: 'ink',
    })
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(studio, { recursive: true, force: true });
});

const hosted = (backend: string) => ({
  backend,
  sbSlug: 'myra',
  prompt: 'ping',
  cliAttached: false,
  workingDirectory: studio,
  inkSessionId: 'sess-hosted',
  studioId: 'studio-hosted',
  host: serverHost({ INK_ACCESS_TOKEN: 'minted-for-this-spawn', INK_SESSION_ID: 'sess-hosted' }),
});

describe('a provider spawned for a session', () => {
  it.each(['claude', 'codex'])(
    '%s: names that session, stays headless, and carries none of the host’s own values',
    async (backend) => {
      expect(await runBackendTurn(hosted(backend))).toMatchObject({ success: true });
      expect(spawned).toHaveLength(1);
      if (backend === 'codex') {
        expect(execFile).toHaveBeenCalledTimes(1);
        const [binary, args, options] = execFile.mock.calls[0]!;
        expect(binary).toBe('codex');
        expect(args.slice(0, 3)).toEqual(['mcp', 'list', '--json']);
        expect(options.cwd).toBe(studio);
        expect(options.env.INK_ACCESS_TOKEN).toBeUndefined();
      } else {
        expect(execFile).not.toHaveBeenCalled();
      }
      const [child] = spawned;

      expect(child.cwd).toBe(studio);
      // The studios root it is granted is the host's, not the server's home.
      expect(child.args).toContain(join(studio, '.host-studios'));
      expect(child.env.INK_ACCESS_TOKEN).toBe('minted-for-this-spawn');
      expect(child.env.INK_SESSION_ID).toBe('sess-hosted');
      expect(child.env.INK_STUDIO_ID).toBe('studio-hosted');
      // #698's startup gate reads only this token's cliAttached (hooks.ts
      // isHeadlessSession); the adapter's own default would be true.
      expect(decodeContextToken(child.env.INK_CONTEXT)).toMatchObject({
        sessionId: 'sess-hosted',
        studioId: 'studio-hosted',
        cliAttached: false,
      });
      expect(JSON.stringify(child.env)).not.toContain('host-own');
    }
  );

  it('codex: a failed config probe cannot reach even the fake provider spawn', async () => {
    execFile.mockImplementationOnce(
      (
        _binary: string,
        _args: string[],
        _options: unknown,
        callback: (error: null, stdout: string, stderr: string) => void
      ) => {
        callback(null, 'not a JSON listing', '');
        return {};
      }
    );
    expect(await runBackendTurn(hosted('codex'))).toMatchObject({ success: false, exitCode: 78 });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(spawned).toHaveLength(0);
  });

  it('reads its MCP config from the working directory, not the host’s', async () => {
    writeFileSync(
      join(studio, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
          'studio-only-fixture': { type: 'http', url: 'http://127.0.0.1:9/mcp' },
        },
      })
    );
    await runBackendTurn(hosted('claude'));
    expect(spawned[0].mcp).toBeDefined();
    expect(JSON.parse(spawned[0].mcp!).mcpServers).toHaveProperty('studio-only-fixture');
  });
});

/**
 * The negative space (Lumen, P1 review): a caller that names no session or
 * studio, the root checkout or a session not yet started, must not have one
 * supplied by the host's env or ambient session, by routing names in the
 * credentials its host hands over, or by a routing header the project config
 * carries.
 */
describe('a provider spawned with no session or studio named', () => {
  const writeStaleProjectConfig = () =>
    writeFileSync(
      join(studio, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: {
            type: 'http',
            url: 'http://localhost:3001/mcp',
            headers: {
              'X-Ink-Session-Id': 'stale-configured-session',
              'x-ink-studio-id': 'stale-configured-studio',
              'x-ink-context': 'stale-configured-context',
            },
          },
        },
      })
    );
  const unnamed = (backend: string) => ({
    ...hosted(backend),
    inkSessionId: undefined,
    studioId: undefined,
    host: serverHost({
      INK_ACCESS_TOKEN: 'minted-for-this-spawn',
      INK_SESSION_ID: 'routing-in-session-env',
      INK_CONTEXT: 'routing-in-session-env',
    }),
  });
  const lowerKeys = (headers: Record<string, string>) =>
    Object.keys(headers).map((name) => name.toLowerCase());

  it('claude: routes by nothing the host, the session env or the project config supplies', async () => {
    writeStaleProjectConfig();
    await runBackendTurn(unnamed('claude'));
    const [child] = spawned;

    const headers = JSON.parse(child.mcp!).mcpServers.inkwell.headers as Record<string, string>;
    expect(lowerKeys(headers)).not.toContain('x-ink-session-id');
    expect(lowerKeys(headers)).not.toContain('x-ink-studio-id');
    expect(headers['x-ink-context']).toBe('${INK_CONTEXT}');
    expect('INK_SESSION_ID' in child.env).toBe(false);
    expect('INK_STUDIO_ID' in child.env).toBe(false);
    expect(decodeContextToken(child.env.INK_CONTEXT)).toMatchObject({
      sessionId: '',
      studioId: '',
      cliAttached: false,
    });
    expect(child.env.INK_ACCESS_TOKEN).toBe('minted-for-this-spawn');
    const everything = JSON.stringify(child);
    expect(everything).not.toContain('host-own');
    expect(everything).not.toContain('stale-configured');
    expect(everything).not.toContain('routing-in-session-env');
  });

  it('claude: named ids replace the project’s configured routing headers', async () => {
    writeStaleProjectConfig();
    await runBackendTurn(hosted('claude'));
    const headers = JSON.parse(spawned[0].mcp!).mcpServers.inkwell.headers as Record<
      string,
      string
    >;
    expect(headers['x-ink-session-id']).toBe('${INK_SESSION_ID}');
    expect(headers['x-ink-studio-id']).toBe('${INK_STUDIO_ID}');
    expect(JSON.stringify(spawned[0])).not.toContain('stale-configured');
  });

  it('gemini: its settings carry no session or studio the caller did not name', async () => {
    writeStaleProjectConfig();
    await runBackendTurn(unnamed('gemini'));
    const [child] = spawned;
    expect(child.args).toContain(join(studio, '.host-studios'));
    const headers = JSON.parse(child.geminiSettings!).mcpServers.inkwell.headers as Record<
      string,
      string
    >;
    expect(lowerKeys(headers)).not.toContain('x-ink-session-id');
    expect(lowerKeys(headers)).not.toContain('x-ink-studio-id');
    expect(decodeContextToken(headers['x-ink-context'])).toMatchObject({
      sessionId: '',
      studioId: '',
    });
    const everything = JSON.stringify(child);
    expect(everything).not.toContain('host-own');
    expect(everything).not.toContain('stale-configured');
    expect(everything).not.toContain('routing-in-session-env');
  });
});
