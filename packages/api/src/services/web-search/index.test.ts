import { access, readFile, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import type { SpawnOptions } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No test in this directory can invoke a real child process through this module.
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import { searchWeb } from './index.js';
import { LIMITS, CLAUDE_VERSION, readConfig, validateInput } from './config.js';
import * as isolation from './isolation.js';
import { runBounded } from './process.js';
import { FakeChild, HELP, MODEL, searchEvents, SYNTHETIC_ENV } from './fixtures.test-support.js';
import { SearchAdmission, searchAdmission } from './admission.js';

let children: FakeChild[];
let inference: (child: FakeChild) => void;
let help: string;
let version: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  // Replace rather than spread: tests neither consume nor pass real credentials.
  originalEnv = process.env;
  process.env = { ...SYNTHETIC_ENV };
  children = [];
  help = HELP;
  version = `${CLAUDE_VERSION} (Claude Code)`;
  inference = (child) => {
    child.events(searchEvents());
    child.finish();
  };
  const admission = new SearchAdmission();
  vi.spyOn(searchAdmission, 'acquire').mockImplementation(() => admission.acquire());
  vi.spyOn(isolation, 'assertUnmanagedHost').mockResolvedValue();
  vi.spyOn(isolation, 'resolveExecutable').mockResolvedValue('/synthetic/pinned/claude');
  // All signal and process-group probes are intercepted, including escalation.
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    const child = children.find((item) => item.pid === -pid);
    if (!child || !child.groupAlive)
      throw Object.assign(new Error('synthetic absent process'), { code: 'ESRCH' });
    if (signal !== 0) child.kill(signal as NodeJS.Signals);
    return true;
  });
  mocks.spawn.mockImplementation((_executable: string, args: string[], options: SpawnOptions) => {
    const child = new FakeChild(900_000_001 + children.length, args, options, (proc) => {
      if (args.includes('--version')) {
        proc.stdout.write(version);
        proc.finish();
      } else if (args.includes('--help')) {
        proc.stdout.write(help);
        proc.finish();
      } else inference(proc);
    });
    children.push(child);
    return child;
  });
});

afterEach(() => {
  process.env = originalEnv;
  vi.useRealTimers();
  vi.restoreAllMocks();
  mocks.spawn.mockReset();
});

const request = { query: 'synthetic query', maxResults: 3 };
const rootOf = (child: FakeChild) => String(child.options.cwd).replace(/\/work$/, '');

async function expectRemoved() {
  for (const root of new Set(children.map(rootOf))) await expect(access(root)).rejects.toThrow();
}

describe('searchWeb operator configuration boundary', () => {
  it.each([undefined, '', 'false', '1', 'TRUE'])(
    'is dark unless explicitly true (%s)',
    async (enabled) => {
      process.env.INK_WEB_SEARCH_ENABLED = enabled;
      await expect(searchWeb(request)).rejects.toMatchObject({
        reason: 'disabled',
        launched: false,
      });
      expect(mocks.spawn).not.toHaveBeenCalled();
    }
  );

  it.each(['INK_WEB_SEARCH_PROVIDER', 'INK_WEB_SEARCH_CLAUDE_PATH', 'INK_WEB_SEARCH_MODEL'])(
    'refuses missing %s before any spawn',
    async (key) => {
      delete process.env[key];
      await expect(searchWeb(request)).rejects.toMatchObject({
        reason: 'missing_configuration',
        launched: false,
      });
      expect(mocks.spawn).not.toHaveBeenCalled();
    }
  );

  it.each(['INK_WEB_SEARCH_CLAUDE_API_KEY', 'INK_WEB_SEARCH_CLAUDE_OAUTH_TOKEN'])(
    'refuses obsolete %s rather than silently selecting different billing',
    async (key) => {
      process.env[key] = 'synthetic-legacy-credential';
      await expect(searchWeb(request)).rejects.toMatchObject({
        reason: 'unsupported_credential',
        launched: false,
      });
      expect(mocks.spawn).not.toHaveBeenCalled();
    }
  );

  it('refuses Codex and PATH lookup instead of falling back', async () => {
    process.env.INK_WEB_SEARCH_PROVIDER = 'codex';
    await expect(searchWeb(request)).rejects.toMatchObject({
      reason: 'unsupported_provider',
      launched: false,
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(() => readConfig({ ...SYNTHETIC_ENV, INK_WEB_SEARCH_CLAUDE_PATH: 'claude' })).toThrow(
      'missing_configuration'
    );
  });

  it('rejects caller overrides and malformed input without launching', async () => {
    for (const input of [
      { ...request, provider: 'claude' },
      { ...request, model: MODEL },
      { ...request, credential: 'synthetic' },
      { ...request, query: ' ' },
      { ...request, query: 'x'.repeat(501) },
      { ...request, query: 'x\nextra' },
      { ...request, maxResults: 0 },
      { ...request, maxResults: 11 },
      { ...request, maxResults: 1.5 },
      { ...request, signal: {} },
    ])
      await expect(searchWeb(input as typeof request)).rejects.toMatchObject({
        reason: 'invalid_input',
        launched: false,
      });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(validateInput({ query: 'x'.repeat(500), maxResults: 10 }).query).toHaveLength(500);
  });

  it('rejects unsafe operator model/executable values rather than building CLI overrides', () => {
    for (const model of [
      '--provider=other',
      'claude-synthetic --settings elsewhere',
      '../synthetic',
      '',
    ]) {
      expect(() => readConfig({ ...SYNTHETIC_ENV, INK_WEB_SEARCH_MODEL: model })).toThrow(
        'missing_configuration'
      );
    }
    expect(() =>
      readConfig({ ...SYNTHETIC_ENV, INK_WEB_SEARCH_CLAUDE_PATH: '/synthetic/cli\u0000' })
    ).toThrow('missing_configuration');
  });
});

describe('owned HOME/config/cwd and inert search lifecycle', () => {
  it('probes without login/query; inference selects only the default login with fixed restrictions', async () => {
    Object.assign(process.env, {
      HOME: '/synthetic/ambient-home',
      PATH: '/synthetic/bin',
      NODE_OPTIONS: '--synthetic',
      NODE_PATH: '/synthetic/modules',
      USER: 'synthetic-ambient-account',
      MAX_THINKING_TOKENS: '999',
      ANTHROPIC_API_KEY: 'synthetic-ambient-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-ambient-oauth',
      OPENAI_API_KEY: 'synthetic-openai',
      SUPABASE_SECRET_KEY: 'synthetic-db',
      INK_CONTEXT: 'synthetic-context',
      MCP_CONFIG: 'synthetic-mcp',
      HTTP_PROXY: 'https://proxy.example.com',
      ANTHROPIC_BASE_URL: 'https://override.example.com',
      CLAUDE_CONFIG_DIR: '/synthetic/ambient-config',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/synthetic/other-login',
      CLAUDE_CODE_SIMPLE: '1',
      ANTHROPIC_PROFILE: 'synthetic-console',
      CLAUDE_CODE_PLUGIN_DIRS: '/synthetic/plugins',
    });
    const query = '--model synthetic-override --mcp-config synthetic-override';
    inference = (child) => {
      child.events(searchEvents(query));
      child.finish();
    };
    const result = await searchWeb({ query, maxResults: 2 });
    expect(result.searchQueries).toEqual([query]);
    expect(children).toHaveLength(3);
    for (const child of children) {
      expect(child.options).toMatchObject({
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const env = child.options.env!;
      expect(env.HOME).toBe(`${rootOf(child)}/home`);
      expect(env.CLAUDE_CONFIG_DIR).toBe(`${rootOf(child)}/config`);
      expect(env.USER).toBe(child.args.includes('--print') ? userInfo().username : undefined);
      expect(env.MAX_THINKING_TOKENS).toBe(child.args.includes('--print') ? '0' : undefined);
      expect(env.PATH).toBe(
        child.args.includes('--print') ? `${rootOf(child)}/bin:/usr/bin:/bin` : '/usr/bin:/bin'
      );
      expect(Object.keys(env).sort()).toEqual(
        [
          'HOME',
          'PATH',
          'TMPDIR',
          'TMP',
          'TEMP',
          'XDG_CONFIG_HOME',
          'XDG_CACHE_HOME',
          'XDG_DATA_HOME',
          'CLAUDE_CONFIG_DIR',
          'DISABLE_AUTOUPDATER',
          'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
          'DISABLE_TELEMETRY',
          'DISABLE_ERROR_REPORTING',
          'CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION',
          'CLAUDE_CODE_WEB_SEARCH_REFILLS_PER_HOUR',
          'CLAUDE_CODE_MAX_RETRIES',
          'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
          ...(child.args.includes('--print')
            ? ['CLAUDE_SECURESTORAGE_CONFIG_DIR', 'USER', 'MAX_THINKING_TOKENS']
            : ['CLAUDE_CODE_SIMPLE']),
        ].sort()
      );
      expect(child.args).not.toContain(query);
      expect(child.args.join(' ')).not.toContain('synthetic-search-only-key');
      for (const flag of [
        '--resume',
        '--continue',
        '--plugin-dir',
        '--dangerously-skip-permissions',
      ])
        expect(child.args).not.toContain(flag);
    }
    for (const probe of children.slice(0, 2)) {
      expect(probe.options.env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(probe.options.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
      expect(probe.options.env?.CLAUDE_CODE_SIMPLE).toBe('1');
      expect(probe.args).toContain('--bare');
      expect(probe.input).toBe('');
    }
    const child = children[2];
    expect(child.options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(child.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(child.options.env?.CLAUDE_CODE_SIMPLE).toBeUndefined();
    expect(child.options.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('');
    expect(child.args).not.toContain('--bare');
    expect(JSON.parse(child.input)).toEqual({ query, maxResults: 2 });
    for (const [flag, value] of [
      ['--tools', 'WebSearch'],
      ['--allowedTools', 'WebSearch'],
      ['--disallowedTools', 'mcp__*'],
      ['--setting-sources', ''],
      ['--permission-mode', 'dontAsk'],
      ['--permission-prompts', 'none'],
      ['--output-format', 'stream-json'],
      ['--model', MODEL],
    ])
      expect(child.args[child.args.indexOf(flag) + 1]).toBe(value);
    for (const flag of [
      '--safe-mode',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
    ])
      expect(child.args).toContain(flag);
    await expectRemoved();
  });

  it('does not retry or borrow ambient config when the CLI cannot use its login', async () => {
    process.env.CLAUDE_CONFIG_DIR = '/synthetic/logged-in-config';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'synthetic-ambient-oauth';
    inference = (child) => {
      child.stderr.write('synthetic private login error');
      child.finish(1);
    };
    await expect(searchWeb(request)).rejects.toMatchObject({
      reason: 'provider_failed',
      launched: true,
      message: 'Web search refused: provider_failed',
    });
    expect(children).toHaveLength(3); // Two probes, exactly one inference attempt.
    expect(children[2].options.env?.CLAUDE_CONFIG_DIR).not.toBe('/synthetic/logged-in-config');
    expect(children[2].options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    await expectRemoved();
  });

  it('writes restrictive fresh config files, cleans each query, and never reuses a home', async () => {
    const observations: Promise<void>[] = [];
    const observationErrors: unknown[] = [];
    inference = (child) => {
      observations.push(
        (async () => {
          const root = rootOf(child);
          expect((await stat(root)).mode & 0o777).toBe(0o700);
          for (const path of ['bin', 'bin/security', 'bin/security.cjs']) {
            expect((await stat(`${root}/${path}`)).mode & 0o777).toBe(0o700);
          }
          const settingsPath = `${root}/config/settings.json`;
          expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
          expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({
            disableAllHooks: true,
            enabledPlugins: {
              'cc-plugin-agents-md@builtin': false,
              'cc-plugin-plugin-authoring@builtin': false,
            },
            autoMemoryEnabled: false,
          });
          expect(JSON.parse(await readFile(`${root}/config/mcp.json`, 'utf8'))).toEqual({
            mcpServers: {},
          });
        })()
          .catch((error: unknown) => {
            observationErrors.push(error);
          })
          .finally(() => {
            child.events(searchEvents());
            child.finish();
          })
      );
    };
    await searchWeb(request);
    await searchWeb(request);
    await Promise.all(observations);
    expect(observationErrors).toEqual([]);
    expect(rootOf(children[0])).not.toBe(rootOf(children[3]));
    await expectRemoved();
  });

  it.each(['version', 'flags'])(
    'refuses unsupported %s before any query is sent and cleans up',
    async (which) => {
      if (which === 'version') version = '9.9.9 (Claude Code)';
      else help = help.replace('--tools', '--unsupported');
      await expect(searchWeb(request)).rejects.toMatchObject({
        reason: 'unsupported_capability',
        launched: false,
      });
      expect(children).toHaveLength(2);
      expect(children.every((child) => !child.input)).toBe(true);
      await expectRemoved();
    }
  );

  it('rejects pre-aborted work without spawn or temp creation', async () => {
    const controller = new AbortController();
    controller.abort();
    const create = vi.spyOn(isolation, 'createSandbox');
    await expect(searchWeb({ ...request, signal: controller.signal })).rejects.toMatchObject({
      reason: 'cancelled',
      launched: false,
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('cancels after inference spawn, waits for physical exit, and cleans temp state', async () => {
    const controller = new AbortController();
    inference = () => controller.abort();
    await expect(searchWeb({ ...request, signal: controller.signal })).rejects.toMatchObject({
      reason: 'cancelled',
      launched: true,
    });
    expect(children[2].signalCode).toBe('SIGTERM');
    expect(children[2].groupAlive).toBe(false);
    await expectRemoved();
  });

  it.each(['stdout', 'stderr', 'line'])('bounds %s and never leaks provider text', async (kind) => {
    inference = (child) => {
      if (kind === 'stdout') child.stdout.write(Buffer.alloc(LIMITS.stdoutBytes + 1, 'x'));
      else if (kind === 'stderr') child.stderr.write(Buffer.alloc(LIMITS.stderrBytes + 1, 'x'));
      else child.stdout.write('x'.repeat(LIMITS.lineBytes + 1));
    };
    await expect(searchWeb(request)).rejects.toMatchObject({
      reason: 'output_limit',
      launched: true,
      message: 'Web search refused: output_limit',
    });
    expect(children[2].groupAlive).toBe(false);
    await expectRemoved();
  });

  it('kills a broad runtime tool surface and never treats its output as successful', async () => {
    inference = (child) => {
      const init = searchEvents()[0];
      init.tools = ['WebSearch', 'Bash'];
      child.events([init]);
    };
    await expect(searchWeb(request)).rejects.toMatchObject({
      reason: 'unsupported_capability',
      launched: true,
    });
    expect(children[2].signals).toEqual(['SIGTERM']);
    await expectRemoved();
  });

  it('stops on explicit subscription rejection and preserves a static launched receipt', async () => {
    inference = (child) => {
      child.events([
        searchEvents()[0],
        {
          type: 'rate_limit_event',
          rate_limit_info: { status: 'rejected', detail: 'synthetic private account detail' },
          uuid: '00000000-0000-4000-8000-000000000001',
          session_id: 'synthetic-session',
        },
      ]);
      // A regression reports a deterministic generic exit, not a test timeout.
      queueMicrotask(() => {
        if (child.groupAlive) child.finish(1);
      });
    };
    await expect(searchWeb(request)).rejects.toMatchObject({
      reason: 'rate_limited',
      launched: true,
      message: 'Web search refused: rate_limited',
    });
    expect(children[2].signals).toEqual(['SIGTERM']);
    expect(children[2].groupAlive).toBe(false);
    await expectRemoved();
  });

  it('refuses nonzero exit even after a valid final result, with no raw stderr/cause', async () => {
    inference = (child) => {
      child.events(searchEvents());
      child.stderr.write('synthetic private provider failure');
      child.finish(1);
    };
    const failure = await searchWeb(request).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      reason: 'provider_failed',
      launched: true,
      message: 'Web search refused: provider_failed',
    });
    expect(failure).not.toHaveProperty('cause');
    await expectRemoved();
  });

  it('maps synchronous spawn errors to static errors and cleans the owned sandbox', async () => {
    const create = vi.spyOn(isolation, 'createSandbox');
    mocks.spawn.mockImplementation(() => {
      throw new Error('synthetic sensitive spawn data');
    });
    await expect(searchWeb(request)).rejects.toMatchObject({
      reason: 'spawn_failed',
      launched: false,
    });
    const sandbox = await create.mock.results[0].value;
    await expect(access(sandbox.root)).rejects.toThrow();
  });

  it('handles asynchronous failed spawn with no pid without signalling any process', async () => {
    const create = vi.spyOn(isolation, 'createSandbox');
    mocks.spawn.mockImplementation((_executable: string, args: string[], options: SpawnOptions) => {
      const child = new FakeChild(900_000_001, args, options, () => {});
      Object.defineProperty(child, 'pid', { value: undefined });
      queueMicrotask(() => child.emit('error', new Error('synthetic private launch detail')));
      return child;
    });
    await expect(searchWeb(request)).rejects.toMatchObject({
      reason: 'spawn_failed',
      launched: false,
    });
    expect(process.kill).not.toHaveBeenCalled();
    const sandbox = await create.mock.results[0].value;
    await expect(access(sandbox.root)).rejects.toThrow();
  });

  it('reports cleanup failures with a static reason, never a raw filesystem error', async () => {
    const original = isolation.createSandbox;
    const create = vi.spyOn(isolation, 'createSandbox').mockImplementation(async () => {
      const sandbox = await original();
      return {
        ...sandbox,
        cleanup: async () => {
          await sandbox.cleanup();
          const { WebSearchError } = await import('./errors.js');
          throw new WebSearchError('cleanup_failed');
        },
      };
    });
    await expect(searchWeb(request)).rejects.toMatchObject({
      reason: 'cleanup_failed',
      launched: true,
      message: 'Web search refused: cleanup_failed',
    });
    const sandbox = await create.mock.results[0].value;
    await expect(access(sandbox.root)).rejects.toThrow();
  });

  it('refuses a managed host before even capability spawn', async () => {
    const { WebSearchError } = await import('./errors.js');
    vi.mocked(isolation.assertUnmanagedHost).mockRejectedValue(
      new WebSearchError('managed_configuration')
    );
    await expect(searchWeb(request)).rejects.toMatchObject({
      reason: 'managed_configuration',
      launched: false,
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('refuses concurrent callers with no queue; capacity releases only after physical exit and cleanup', async () => {
    let ready!: () => void;
    const spawned = new Promise<void>((resolve) => {
      ready = resolve;
    });
    inference = () => ready();
    const first = searchWeb(request);
    await spawned;
    await expect(searchWeb(request)).rejects.toMatchObject({
      reason: 'capacity_exhausted',
      launched: false,
    });
    expect(children).toHaveLength(3);
    children[2].events(searchEvents());
    children[2].finish();
    await first;
    await expectRemoved();
    inference = (child) => {
      child.events(searchEvents());
      child.finish();
    };
    await expect(searchWeb(request)).resolves.toMatchObject({ provider: 'claude' });
    expect(children).toHaveLength(6);
  });

  it('latches refusal after stop_unconfirmed, retaining capacity even after the old child later exits', async () => {
    let ready!: () => void;
    const spawned = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const controller = new AbortController();
    inference = (child) => {
      child.ignoreTerm = true;
      child.ignoreKill = true;
      ready();
    };
    const first = searchWeb({ ...request, signal: controller.signal });
    const rejected = expect(first).rejects.toMatchObject({
      reason: 'stop_unconfirmed',
      launched: true,
    });
    await spawned;
    vi.useFakeTimers();
    controller.abort();
    await vi.advanceTimersByTimeAsync(LIMITS.stopGraceMs + LIMITS.stopGiveUpMs);
    await rejected;
    await expect(searchWeb(request)).rejects.toMatchObject({
      reason: 'service_quarantined',
      launched: false,
    });
    children[2].finish();
    await expect(searchWeb(request)).rejects.toMatchObject({
      reason: 'service_quarantined',
      launched: false,
    });
    expect(children).toHaveLength(3);
    await expectRemoved();
  });

  it('rechecks cancellation after capability validation and before credential launch', async () => {
    const controller = new AbortController();
    vi.mocked(isolation.assertUnmanagedHost).mockImplementation(async () => {
      if (children.length === 2) controller.abort();
    });
    await expect(searchWeb({ ...request, signal: controller.signal })).rejects.toMatchObject({
      reason: 'cancelled',
      launched: false,
    });
    expect(children).toHaveLength(2);
    expect(children.every((child) => !child.options.env?.ANTHROPIC_API_KEY)).toBe(true);
    await expectRemoved();
  });
});

describe('bounded process stop fencing (fake transports and fake signals)', () => {
  const input = () => ({
    executable: '/synthetic/provider',
    args: ['--synthetic'],
    cwd: '/synthetic/owned',
    env: {},
    stdin: '',
    timeoutMs: 20,
  });

  it('does not settle on a successful result until the process physically exits', async () => {
    inference = (child) => child.stdout.write('result arrived');
    let settled = false;
    const run = runBounded({ ...input(), timeoutMs: 1000 }).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    children[0].finish();
    expect(await run).toBe('result arrived');
  });

  it('times out, escalates past SIGTERM despite killed=true semantics, and waits for SIGKILL exit', async () => {
    vi.useFakeTimers();
    inference = (child) => {
      child.ignoreTerm = true;
    };
    const run = runBounded(input());
    const rejected = expect(run).rejects.toMatchObject({ reason: 'timeout' });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);
    expect(children[0].signals).toEqual(['SIGTERM']);
    expect(children[0].groupAlive).toBe(true);
    await vi.advanceTimersByTimeAsync(LIMITS.stopGraceMs);
    await rejected;
    expect(children[0].signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(children[0].signalCode).toBe('SIGKILL');
    expect(children[0].groupAlive).toBe(false);
  });

  it('does not accept a leader exit while descendants remain in the group', async () => {
    vi.useFakeTimers();
    inference = (child) => {
      child.ignoreTerm = true;
      child.finish(0, null, true);
    };
    let settled = false;
    const run = runBounded({ ...input(), timeoutMs: 2000 }).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(children[0].groupAlive).toBe(true);
    await vi.advanceTimersByTimeAsync(LIMITS.stopGraceMs + 100);
    await run;
    expect(children[0].groupAlive).toBe(false);
    expect(children[0].signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('reports an unconfirmed physical stop rather than fabricating a clean cancellation', async () => {
    vi.useFakeTimers();
    inference = (child) => {
      child.ignoreTerm = true;
      child.ignoreKill = true;
    };
    const run = runBounded(input());
    const rejected = expect(run).rejects.toMatchObject({ reason: 'stop_unconfirmed' });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20 + LIMITS.stopGraceMs + LIMITS.stopGiveUpMs);
    await rejected;
    expect(children[0].exitCode).toBeNull();
    expect(children[0].signalCode).toBeNull();
  });

  it('decodes split UTF-8 and split JSON lines without accepting unfinished JSON', async () => {
    const lines: string[] = [];
    inference = (child) => {
      const bytes = Buffer.from('{"title":"café"}\n');
      child.stdout.write(bytes.subarray(0, 14));
      child.stdout.write(bytes.subarray(14));
      child.stdout.write('{"tail":true}');
      child.finish();
    };
    await runBounded({ ...input(), onLine: (line) => lines.push(line) });
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ title: 'café' }, { tail: true }]);
  });

  it('turns stdin transport errors into static failures and physically stops the child', async () => {
    inference = (child) => child.stdin.emit('error', new Error('synthetic private pipe detail'));
    await expect(runBounded(input())).rejects.toMatchObject({ reason: 'provider_failed' });
    expect(children[0].groupAlive).toBe(false);
  });
});
