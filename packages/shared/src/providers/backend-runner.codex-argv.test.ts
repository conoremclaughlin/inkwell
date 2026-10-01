import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBackendTurn } from './backend-runner.js';
import type { BackendHost } from './types.js';

const os = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('child_process', () => os);

// The real runner and adapter, with both OS boundaries replaced. The fake
// listing applies only the two synthetic config overrides used by these rows;
// it is not a TOML or Codex implementation. A real configuration-only probe
// confirmed these overrides change the listing on Codex 0.158.0.
describe('Codex checks the configuration of the launch it actually performs', () => {
  let root: string;
  let host: BackendHost;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codex-launch-config-'));
    host = {
      paths: { inkFiles: join(root, 'files'), studiosRoot: join(root, 'studios'), tempDir: root },
      ambientSession: () => ({}),
      claudeSupportsPartialMessages: async () => false,
      skillMcpServers: async () => [],
      sessionEnv: async () => ({ INK_ACCESS_TOKEN: 'synthetic-session-token' }),
      baseEnv: async () => ({ HOME: root, CODEX_HOME: root }),
      inkwellMcpUrl: 'http://127.0.0.1:9/mcp',
      resolveBinary: async () => '/synthetic/codex',
      warn: () => undefined,
    };
    os.execFile
      .mockReset()
      .mockImplementation(
        (
          _binary: string,
          args: string[],
          _options: unknown,
          callback: (error: null, stdout: string, stderr: string) => void
        ) => {
          const overriddenRouting = args.some((arg) =>
            arg.startsWith('mcp_servers.inkwell.http_headers.x-ink-session-id=')
          );
          const overriddenUrl = args.some((arg) => arg.includes('mcp_servers.inkwell.url='));
          callback(
            null,
            JSON.stringify([
              {
                name: 'inkwell',
                enabled: true,
                disabled_reason: null,
                transport: {
                  type: 'streamable_http',
                  url: overriddenUrl ? 'http://127.0.0.1:19/mcp' : host.inkwellMcpUrl,
                  bearer_token_env_var: null,
                  http_headers: overriddenRouting
                    ? { 'x-ink-session-id': 'synthetic-stale' }
                    : null,
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
    os.spawn.mockReset().mockImplementation(() => {
      const stream = () => Object.assign(new EventEmitter(), { setEncoding: () => undefined });
      const child = Object.assign(new EventEmitter(), {
        pid: 12345,
        stdout: stream(),
        stderr: stream(),
        stdin: { write: () => true, end: () => undefined },
        kill: vi.fn(),
      });
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (passthroughArgs: string[], prompt = 'synthetic prompt') =>
    startBackendTurn({
      backend: 'codex',
      sbSlug: 'synthetic-agent',
      prompt,
      passthroughArgs,
      cliAttached: false,
      workingDirectory: root,
      inkSessionId: 'synthetic-session',
      studioId: 'synthetic-studio',
      host,
    }).result;

  it('starts the clean control through the fake child boundary', async () => {
    expect(await run([])).toMatchObject({ success: true, exitCode: 0 });
    expect(os.execFile).toHaveBeenCalledTimes(1);
    expect(os.spawn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['-c', 'mcp_servers.inkwell.http_headers.x-ink-session-id="synthetic-stale"'],
    ['--config', 'mcp_servers.inkwell.url="http://127.0.0.1:19/mcp"'],
    ['--config=mcp_servers.inkwell.url="http://127.0.0.1:19/mcp"'],
  ])('refuses launch-only config overrides: %s', async (...passthroughArgs) => {
    expect(await run(passthroughArgs)).toMatchObject({
      success: false,
      exitCode: 78,
      childExited: true,
    });
    expect(os.spawn).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'no caller delimiter', passthrough: [] },
    { name: 'a caller delimiter', passthrough: ['--'] },
  ])('keeps a dash-leading prompt positional with $name', async ({ passthrough }) => {
    const prompt = '--config=model_provider=synthetic_missing_provider';
    expect(await run(passthrough, prompt)).toMatchObject({ success: true });
    const args = os.spawn.mock.calls[0]![1] as string[];
    const delimiter = args.indexOf('--');
    expect(delimiter).toBeGreaterThan(args.indexOf('exec'));
    expect(args.slice(delimiter + 1)).toEqual([prompt]);
    const probeArgs = os.execFile.mock.calls[0]![1] as string[];
    expect(probeArgs).not.toContain(prompt);
  });
});
