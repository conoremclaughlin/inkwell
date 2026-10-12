/** Token-free checks of the live harness itself. No provider or login is used. */
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import childProcess from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnBackend } from '@inklabs/shared';
import { parallelLiveDriver } from './hosted-parallel-live';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
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
  await driver.install({ root, serverUrl: 'http://127.0.0.1:49001' });
  const token = { sub: 'fixture-owner', sessionId: 'fixture-session', sbSlug: 'fixture' };
  const env = {
    HOME: plan.providerHome,
    INK_ACCESS_TOKEN: `fixture.${Buffer.from(JSON.stringify(token)).toString('base64url')}.fixture`,
    INK_CONTEXT: Buffer.from(
      JSON.stringify({ sessionId: token.sessionId, sbSlug: 'fixture', studioId: 'fixture-studio' })
    ).toString('base64url'),
  };
  return { root, cwd, plan, driver, env };
}

describe('opt-in live acceptance observer (without real providers)', () => {
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
    await expect(invalid.install({ root, serverUrl: 'http://127.0.0.1:49001' })).rejects.toThrow(
      'Unexpected acceptance configuration override'
    );
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
