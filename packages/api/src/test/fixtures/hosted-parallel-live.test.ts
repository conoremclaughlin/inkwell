/** Token-free checks of the live harness itself. No provider or login is used. */
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, realpath, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnBackend } from '@inklabs/shared';
import { CodexAdapter, type BackendHost } from '@inklabs/shared/providers';
import { parallelLiveDriver } from './hosted-parallel-live';

const roots: string[] = [];
const originalSpawn = childProcess.spawn;
const originalExecFile = childProcess.execFile;
afterEach(async () => {
  vi.restoreAllMocks();
  childProcess.spawn = originalSpawn;
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup(fakeChild?: childProcess.ChildProcess) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ink-live-driver-unit-')));
  roots.push(root);
  const cwd = join(root, 'cwd');
  await mkdir(cwd);
  vi.stubEnv('INK_LIVE_TESTS', '1');
  vi.stubEnv('INK_PARALLEL_LIVE', '1');
  const plan = {
    providerHome: '/synthetic-provider-home-not-read',
    claudeBinary: '/bin/echo',
    codexBinary: '/usr/bin/true',
    codexConfig: ['features.hooks=false', 'plugins."fixture@builtin".enabled=false'],
  };
  const driver = parallelLiveDriver(plan, true);
  // A plain lower-level port, not another spy: vi.spyOn reuses an existing
  // mock, which would make the observer's captured delegate call itself.
  if (fakeChild) childProcess.spawn = (() => fakeChild) as typeof childProcess.spawn;
  const onViolation = vi.fn();
  await driver.install({ root, serverUrl: 'http://127.0.0.1:49001', onViolation });
  const token = { sub: 'fixture-owner', sessionId: 'fixture-session', sbSlug: 'fixture' };
  const env = {
    HOME: plan.providerHome,
    INK_ACCESS_TOKEN: `fixture.${Buffer.from(JSON.stringify(token)).toString('base64url')}.fixture`,
    INK_CONTEXT: Buffer.from(
      JSON.stringify({ sessionId: token.sessionId, sbSlug: 'fixture', studioId: 'fixture-studio' })
    ).toString('base64url'),
  };
  return { root, cwd, plan, driver, env, onViolation };
}

const codexArgs = ['--json', '--sandbox', 'read-only', '-c', 'features.shell_tool=false'];

async function observeProvider(
  provider: 'claude' | 'codex' = 'claude',
  args = provider === 'codex' ? codexArgs : []
) {
  // The native-executable forwarding test below is separate. These adversarial
  // protocol inputs never launch any process or touch a provider account.
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdout,
  }) as unknown as childProcess.ChildProcess;
  const fixture = await setup(child);
  childProcess.spawn(fixture.driver.binary(provider), args, { cwd: fixture.cwd, env: fixture.env });
  child.emit('spawn');
  const finish = () =>
    fixture.driver.finish({ root: fixture.root, cleaned: true, calls: [], ledgers: new Map() });
  const evidence = async () =>
    JSON.parse(await readFile(join(fixture.root, 'acceptance-evidence.json'), 'utf8')) as {
      records: Array<Record<string, unknown>>;
    };
  const close = (code: number | null, signal: string | null = null) => {
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  };
  return { ...fixture, stdout, close, finish, evidence };
}

const emptyInit = { type: 'system', subtype: 'init', tools: [], plugins: [], mcp_servers: [] };

describe('opt-in live acceptance observer (without real providers)', () => {
  it('disables only named optional builtins in owned settings, never the security plugin', async () => {
    const run = await setup();
    const settings = JSON.parse(await readFile(join(run.root, 'claude-settings.json'), 'utf8'));
    expect(settings.enabledPlugins).toEqual({
      'cc-plugin-agents-md@builtin': false,
      'cc-plugin-plugin-authoring@builtin': false,
      'cc-plugin-telemetry@builtin': false,
    });
    expect(settings.enabledPlugins).not.toHaveProperty('cc-plugin-sec-default@builtin');
  });
  it('passes the master switch last through the real adapter and its config-check record', async () => {
    const run = await setup();
    const host: BackendHost = {
      paths: { inkFiles: run.cwd, studiosRoot: join(run.root, 'studios'), tempDir: run.root },
      ambientSession: () => ({}),
      claudeSupportsPartialMessages: async () => false,
      skillMcpServers: async () => [],
      sessionEnv: async () => ({}),
      baseEnv: async () => ({}),
      inkwellMcpUrl: 'http://127.0.0.1:49001/mcp',
      resolveBinary: async (name) => name,
      warn: () => undefined,
    };
    const prepared = await new CodexAdapter().prepare(
      {
        sbSlug: 'fixture',
        cwd: run.cwd,
        cliAttached: false,
        promptParts: ['exec', 'fixture'],
        passthroughArgs: ['--sandbox', 'read-only', '-c', 'features.shell_tool=true'],
        stream: true,
      },
      host
    );
    try {
      expect(prepared.args.filter((arg) => arg.startsWith('features.shell_tool='))).toEqual([
        'features.shell_tool=true',
        'features.shell_tool=false',
      ]);
      expect(prepared.launchConfig).toMatchObject({
        args: expect.arrayContaining(['features.shell_tool=false']),
      });
    } finally {
      await prepared.cleanup();
    }
  });
  it.each([
    { listing: 'shell_tool stable false\nunified_exec stable true\n', accepted: true },
    { listing: 'shell_tool stable true\nunified_exec stable true\n', accepted: false },
    { listing: 'unified_exec stable true\n', accepted: false },
    { listing: 'shell_tool stable false\n', accepted: false },
    { listing: 'shell_tool\nunified_exec stable false\n', accepted: false },
  ])(
    'checks the real feature probe answer, not the requested config (%#)',
    async ({ listing, accepted }) => {
      const invocations: Array<{
        args: string[];
        options: childProcess.ExecFileOptionsWithStringEncoding;
      }> = [];
      childProcess.execFile = ((
        _binary: string,
        args: string[],
        options: childProcess.ExecFileOptionsWithStringEncoding,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        invocations.push({ args, options });
        callback(null, args[0] === 'mcp' ? '[]' : listing, '');
        return new EventEmitter() as childProcess.ChildProcess;
      }) as typeof childProcess.execFile;
      const run = await setup();
      const options = {
        cwd: run.cwd,
        env: { HOME: run.plan.providerHome },
        encoding: 'utf8' as const,
        timeout: 1000,
      };
      const error = await new Promise<Error | null>((resolve) => {
        childProcess.execFile(
          run.driver.binary('codex'),
          ['mcp', 'list', '--json', '-c', 'features.shell_tool=false'],
          options,
          (error) => resolve(error)
        );
      });
      expect(invocations[1]).toEqual({
        args: ['features', 'list', '-c', 'features.shell_tool=false'],
        options,
      });
      expect(error === null).toBe(accepted);
      expect(run.onViolation).toHaveBeenCalledTimes(accepted ? 0 : 1);
      if (accepted) {
        await run.driver.finish({ root: run.root, cleaned: true, calls: [], ledgers: new Map() });
        const evidence = JSON.parse(
          await readFile(join(run.root, 'acceptance-evidence.json'), 'utf8')
        );
        expect(evidence.probes[0].features).toEqual({ shell_tool: false, unified_exec: true });
        expect(evidence.knownProviderHomeWrites).toContain(
          'Claude project transcripts and ~/.claude.json'
        );
      }
    }
  );
  it('records explicit Codex sandbox and a complete stream without native tool items', async () => {
    const run = await observeProvider('codex');
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'fixture' },
    });
    run.stdout.write(line.slice(0, 15));
    run.stdout.write(line.slice(15)); // no final newline: inspected at close
    run.close(0);
    await run.finish();
    expect(run.onViolation).not.toHaveBeenCalled();
    expect((await run.evidence()).records[0]).toMatchObject({
      codexSandbox: 'read-only',
      codexRequestedShellConfig: { shell_tool: false },
      nativeToolStatus: 'complete',
    });
  });
  it.each(['item.started', 'item.updated', 'item.completed'])(
    'aborts immediately on Codex %s command_execution',
    async (type) => {
      const run = await observeProvider('codex');
      run.stdout.write(
        JSON.stringify({ type, item: { type: 'command_execution', command: 'true' } }) + '\n'
      );
      expect(run.onViolation).toHaveBeenCalledTimes(1);
      expect(run.stdout.listenerCount('data')).toBe(0);
      expect(() => run.driver.binary('codex')).toThrow('configuration was not accepted');
      run.close(0);
      await expect(run.finish()).rejects.toThrow('native tool item');
      expect((await run.evidence()).records[0]).toMatchObject({
        nativeToolStatus: 'invalid',
        nativeToolViolation: { eventType: type, itemType: 'command_execution' },
      });
      expect(run.onViolation).toHaveBeenCalledTimes(1);
    }
  );
  it('inspects a final Codex command item without a newline', async () => {
    const run = await observeProvider('codex');
    run.stdout.write(
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } })
    );
    run.close(0);
    expect(run.onViolation).toHaveBeenCalledTimes(1);
    await expect(run.finish()).rejects.toThrow('native tool item');
  });
  it.each(['file_change', 'mcp_tool_call', 'web_search'])(
    'also refuses unexpected Codex %s items',
    async (type) => {
      const run = await observeProvider('codex');
      run.stdout.write(JSON.stringify({ type: 'item.started', item: { type } }) + '\n');
      expect(run.onViolation).toHaveBeenCalledTimes(1);
      run.close(0);
      await expect(run.finish()).rejects.toThrow('native tool item');
    }
  );
  it('does not call interrupted Codex observation complete', async () => {
    const run = await observeProvider('codex');
    run.close(null, 'SIGKILL');
    await run.finish();
    expect((await run.evidence()).records[0].nativeToolStatus).toBe('interrupted');
  });
  it.each(['invalid JSON\n', ' '.repeat(1_048_577)])(
    'fails closed on unreadable or oversized Codex observation (%#)',
    async (input) => {
      const run = await observeProvider('codex');
      run.stdout.write(input);
      expect(run.onViolation).toHaveBeenCalledTimes(1);
      expect(run.stdout.listenerCount('data')).toBe(0);
      run.close(0);
      await expect(run.finish()).rejects.toThrow();
    }
  );
  it.each(
    [
      [],
      ['--json', '--sandbox', 'workspace-write', ...codexArgs.slice(3)],
      [...codexArgs, '--full-auto'],
      [...codexArgs, '--dangerously-bypass-approvals-and-sandbox'],
      [...codexArgs, '-c', 'features.shell_tool=true'],
      codexArgs.filter((arg) => arg !== '--json'),
    ].map((args) => ({ args }))
  )(
    'refuses a missing or conflicting native shell boundary before spawn (%#)',
    async ({ args }) => {
      const child = new EventEmitter() as childProcess.ChildProcess;
      const run = await setup(child);
      expect(() =>
        childProcess.spawn(run.driver.binary('codex'), args, { cwd: run.cwd, env: run.env })
      ).toThrow('Codex acceptance launch');
      expect(run.onViolation).toHaveBeenCalledTimes(1);
    }
  );
  it('verifies only complete empty Claude initialization inventories', async () => {
    const run = await observeProvider();
    run.stdout.write(JSON.stringify(emptyInit) + '\n');
    run.close(0);
    await run.finish();
    expect(run.onViolation).not.toHaveBeenCalled();
    expect((await run.evidence()).records[0]).toMatchObject({
      initStatus: 'verified',
      exitCode: 0,
    });
  });
  it.each([
    ['missing fields', { type: 'system', subtype: 'init' }],
    ['malformed inventory', { ...emptyInit, plugins: {} }],
    ['nonempty inventory', { ...emptyInit, tools: ['unexpected'] }],
  ])('refuses %s immediately, before the Claude child exits', async (_label, init) => {
    const run = await observeProvider();
    run.stdout.write(JSON.stringify(init) + '\n');
    expect(run.onViolation).toHaveBeenCalledTimes(1);
    expect(() => run.driver.binary('claude')).toThrow('configuration was not accepted');
    run.close(0);
    await expect(run.finish()).rejects.toThrow();
    expect((await run.evidence()).records[0].initStatus).toBe('invalid');
    expect(run.onViolation).toHaveBeenCalledTimes(1);
  });
  it('refuses successful completion without observed init rather than calling it verified', async () => {
    const run = await observeProvider();
    run.close(0);
    expect(run.onViolation).toHaveBeenCalledTimes(1);
    await expect(run.finish()).rejects.toThrow('initialization');
    expect((await run.evidence()).records[0].initStatus).toBe('unverified');
  });
  it('records interrupted-before-init children as unverified, not as a clean init', async () => {
    const run = await observeProvider();
    run.close(null, 'SIGTERM');
    await run.finish();
    expect(run.onViolation).not.toHaveBeenCalled();
    expect((await run.evidence()).records[0]).toMatchObject({
      initStatus: 'unverified',
      signal: 'SIGTERM',
    });
  });
  it('aborts on oversized initialization and removes its buffer listener immediately', async () => {
    const run = await observeProvider();
    run.stdout.write(Buffer.alloc(1_048_577, 32));
    expect(run.onViolation).toHaveBeenCalledTimes(1);
    expect(run.stdout.listenerCount('data')).toBe(0);
    run.stdout.write(JSON.stringify(emptyInit) + '\n');
    run.close(0);
    await expect(run.finish()).rejects.toThrow('bound');
    expect((await run.evidence()).records[0].initStatus).toBe('invalid');
    expect(run.onViolation).toHaveBeenCalledTimes(1);
  });
  it('forwards the real native spawn and records its exact PID/exit without wrapping stdout', async () => {
    const { driver, cwd, env } = await setup();
    const spawned = spawnBackend({
      binary: driver.binary('codex'),
      args: codexArgs,
      cwd,
      env,
      parentEnv: {},
      timeoutMs: 1000,
    });
    const result = await spawned.result;
    expect(result.exitCode).toBe(0);
    const child = spawned.child;
    const [record] = driver.launches('fixture-session');
    expect(record).toMatchObject({
      pid: child.pid,
      sessionId: 'fixture-session',
      cwd,
      leakedServerCredential: false,
    });
    expect(record!.endedAt).toBeGreaterThanOrEqual(Number(record!.startedAt));
    expect(JSON.stringify(record)).not.toContain(env.INK_ACCESS_TOKEN);
    driver.clear('fixture-session');
    expect(driver.launches('fixture-session')).toEqual([]);
  });
  it('refuses an inherited server credential before starting the harmless native program', async () => {
    const { driver, cwd, env } = await setup();
    expect(() =>
      childProcess.spawn(driver.binary('codex'), [], {
        cwd,
        env: { ...env, JWT_SECRET: 'synthetic-forbidden' },
      })
    ).toThrow('Unexpected live provider authority');
    expect(driver.launches('fixture-session')).toEqual([]);
  });
  it('does not accept table clearing as a substitute for explicit configuration switches', async () => {
    const { root, plan } = await setup();
    const invalid = parallelLiveDriver({ ...plan, codexConfig: ['hooks={}'] }, true);
    await expect(
      invalid.install({ root, serverUrl: 'http://127.0.0.1:49001', onViolation: vi.fn() })
    ).rejects.toThrow('Unexpected acceptance configuration override');
  });
  it('refuses a config-only probe that returns no readable MCP inventory', async () => {
    const { driver, cwd, plan } = await setup();
    const error = await new Promise<Error | null>((resolve) => {
      childProcess.execFile(
        driver.binary('codex'),
        ['mcp', 'list', '--json'],
        {
          cwd,
          env: { HOME: plan.providerHome },
          encoding: 'utf8',
          timeout: 1000,
        },
        (error) => resolve(error)
      );
    });
    expect(error?.message).toBe('Live acceptance refused effective MCP configuration');
    expect(() => driver.binary('codex')).toThrow('configuration was not accepted');
  });
});
