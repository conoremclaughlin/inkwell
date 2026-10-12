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
import { parallelLiveDriver } from './hosted-parallel-live';

const roots: string[] = [];
const originalSpawn = childProcess.spawn;
afterEach(async () => {
  vi.restoreAllMocks();
  childProcess.spawn = originalSpawn;
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

async function observeClaude() {
  // The native-executable forwarding test below is separate. These adversarial
  // protocol inputs never launch any process or touch a provider account.
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdout,
  }) as unknown as childProcess.ChildProcess;
  const fixture = await setup(child);
  childProcess.spawn(fixture.driver.binary('claude'), [], { cwd: fixture.cwd, env: fixture.env });
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
  it('verifies only complete empty Claude initialization inventories', async () => {
    const run = await observeClaude();
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
    const run = await observeClaude();
    run.stdout.write(JSON.stringify(init) + '\n');
    expect(run.onViolation).toHaveBeenCalledTimes(1);
    expect(() => run.driver.binary('claude')).toThrow('configuration was not accepted');
    run.close(0);
    await expect(run.finish()).rejects.toThrow();
    expect((await run.evidence()).records[0].initStatus).toBe('invalid');
    expect(run.onViolation).toHaveBeenCalledTimes(1);
  });
  it('refuses successful completion without observed init rather than calling it verified', async () => {
    const run = await observeClaude();
    run.close(0);
    expect(run.onViolation).toHaveBeenCalledTimes(1);
    await expect(run.finish()).rejects.toThrow('initialization');
    expect((await run.evidence()).records[0].initStatus).toBe('unverified');
  });
  it('records interrupted-before-init children as unverified, not as a clean init', async () => {
    const run = await observeClaude();
    run.close(null, 'SIGTERM');
    await run.finish();
    expect(run.onViolation).not.toHaveBeenCalled();
    expect((await run.evidence()).records[0]).toMatchObject({
      initStatus: 'unverified',
      signal: 'SIGTERM',
    });
  });
  it('aborts on oversized initialization and removes its buffer listener immediately', async () => {
    const run = await observeClaude();
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
      args: [],
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
