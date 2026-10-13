import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBackendTurn, type BackendRunRequest } from './backend-runner.js';
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
  let output: string;
  let exitCode: number;

  beforeEach(() => {
    output = '';
    exitCode = 0;
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
      queueMicrotask(() => {
        child.stdout.emit('data', output);
        child.emit('close', exitCode);
      });
      return child;
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (
    passthroughArgs: string[],
    prompt = 'synthetic prompt',
    options: Partial<BackendRunRequest> = {}
  ) =>
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
      ...options,
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

  const line = (event: unknown) => `${JSON.stringify(event)}\n`;
  const message = (text: string) =>
    line({ type: 'item.completed', item: { type: 'agent_message', text } });
  const completed = line({
    type: 'turn.completed',
    usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 300 },
  });

  it('normalizes exec JSONL in the shared runner after checking the exact launch config', async () => {
    output = message('Progress.') + message('Answer.') + completed;
    const result = await run([], 'hello', { stream: true });
    expect(result).toMatchObject({
      success: true,
      responseText: 'Answer.',
      childExited: true,
      usage: { cacheReadTokens: 1000, totalTokens: 1500 },
    });
    expect(result.usage?.contextTokens).toBeUndefined();
    expect(os.spawn.mock.calls[0]![1]).toContain('--json');
    expect(os.execFile).toHaveBeenCalledTimes(1);
  });

  it('treats failed or incomplete JSON streams as failures even when the child exits zero', async () => {
    for (const terminal of [
      '',
      line({ type: 'turn.failed', error: { message: 'synthetic failure' } }),
    ]) {
      output = message('Progress.') + terminal;
      const result = await run([], 'hello', { stream: true });
      expect(result).toMatchObject({ success: false, responseText: '', exitCode: 1 });
      expect(result.stderr).not.toBe('');
    }
  });

  it('preserves a nonzero child exit after a complete result', async () => {
    output = message('Answer.') + completed;
    exitCode = 7;
    expect(await run([], 'hello', { stream: true })).toMatchObject({ success: false, exitCode: 7 });
  });

  it('honors an explicit empty final result instead of returning progress', async () => {
    output = message('Progress.') + message('') + completed;
    expect(await run([], 'hello', { stream: true })).toMatchObject({
      success: true,
      responseText: '',
    });
  });

  it('keeps the effective-config fence on streaming resumes, including after exec-scoped flags', async () => {
    expect(
      await run(['-c', 'mcp_servers.inkwell.url="http://127.0.0.1:19/mcp"'], 'hello', {
        stream: true,
        backendSessionId: 'synthetic-resume',
      })
    ).toMatchObject({ success: false, exitCode: 78 });
    expect(os.spawn).not.toHaveBeenCalled();
    expect(os.execFile).toHaveBeenCalledTimes(1);
  });

  it('carries resume identity and media as data, without moving them into the config probe', async () => {
    output = message('Answer.') + completed;
    const prompt = '--config=model_provider=not-an-option';
    const result = await run(['--skip-git-repo-check'], prompt, {
      stream: true,
      backendSessionId: 'synthetic-resume',
      media: [{ path: '/synthetic/image.png', mimeType: 'image/png' }],
    });
    expect(result.success).toBe(true);
    const args = os.spawn.mock.calls[0]![1] as string[];
    expect(args.slice(args.indexOf('exec'))).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      'resume',
      '--image=/synthetic/image.png',
      '--',
      'synthetic-resume',
      prompt,
    ]);
    const probeArgs = os.execFile.mock.calls[0]![1] as string[];
    for (const value of [prompt, 'synthetic-resume', '--image=/synthetic/image.png']) {
      expect(probeArgs).not.toContain(value);
    }
  });
});
