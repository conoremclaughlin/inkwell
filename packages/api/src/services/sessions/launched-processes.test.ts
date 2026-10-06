import { spawn, type ChildProcess } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureLaunchRecording,
  couldBeBackend,
  findTaggedProcesses,
  holdSurvivors,
  launchHoldFor,
  processStartIdentity,
  resetLaunchHolds,
  reserveLaunch,
  startLaunchTracking,
  stopSurvivingLaunches,
  type LaunchRow,
  type LaunchStore,
} from './launched-processes';
import { buildCleanEnv, resolveSpawnTarget } from '@inklabs/shared';
import { probeGroup } from './stop-process';

const BOOT = 'boot-fixture';
const INSTANCE = 'host-fixture:3001';
const children: ChildProcess[] = [];
const groups: number[] = [];

afterEach(() => {
  for (const c of children.splice(0)) if (c.pid && c.exitCode === null) c.kill('SIGKILL');
  for (const g of groups.splice(0)) {
    try {
      process.kill(-g, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  configureLaunchRecording(undefined);
});

function start(cmd: string, opts: { detached?: boolean } = {}): ChildProcess {
  const child = spawn('sh', ['-c', cmd], { stdio: 'ignore', detached: opts.detached === true });
  children.push(child);
  if (opts.detached && child.pid) groups.push(child.pid);
  return child;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => child.once('exit', resolve));
}

function fakeStore(rows: LaunchRow[]) {
  const exitedIds: string[] = [];
  const store: LaunchStore = {
    reserve: vi.fn(async () => 'row-new'),
    attach: vi.fn(async () => undefined),
    markExited: vi.fn(async (ids: string[]) => void exitedIds.push(...ids)),
    listOpen: vi.fn(async () => rows),
  };
  return { store, exitedIds };
}

/** A node child, whose environment its own user can read on macOS too (`sh` and `sleep` hide theirs). */
function startTagged(
  env: Record<string, string>,
  args: string[] = [],
  executable: string = process.execPath
): ChildProcess {
  // Through buildCleanEnv, as every runner's env is: a launch tag goes first.
  const child = spawn(executable, ['-e', 'setTimeout(() => {}, 30000)', ...args], {
    stdio: 'ignore',
    env: buildCleanEnv({ ...env, PATH: process.env.PATH ?? '' }) as NodeJS.ProcessEnv,
  });
  children.push(child);
  return child;
}

/** Node, started as `claude`: what a Claude Code launch looks like in the process table. */
const fakeBackendDirs: string[] = [];
function asClaude(): string {
  const dir = mkdtempSync(join(tmpdir(), 'launch-backend-'));
  fakeBackendDirs.push(dir);
  const link = join(dir, 'claude');
  symlinkSync(process.execPath, link);
  return link;
}
afterEach(() => {
  for (const dir of fakeBackendDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const emptyInventory = async () => ({ tagged: new Map(), unreadable: [] });

function row(over: Partial<LaunchRow> & { pid: number | null }): LaunchRow {
  return {
    id: `row-${over.pid}`,
    sessionId: 'session-fixture',
    backend: 'claude-code',
    pgid: null,
    startIdentity: null,
    bootId: BOOT,
    ...over,
  };
}

const sweep = (store: LaunchStore) =>
  stopSurvivingLaunches(store, { serverInstance: INSTANCE, bootId: BOOT, graceMs: 300 });

describe('stopSurvivingLaunches', () => {
  it('stops a survivor whose start time matches, and records it exited', async () => {
    const child = start('sleep 30');
    const identity = await processStartIdentity(child.pid!);
    expect(identity).not.toBeNull();
    const { store, exitedIds } = fakeStore([row({ pid: child.pid!, startIdentity: identity })]);
    const outcome = await sweep(store);
    expect(outcome.stopped.map((r) => r.pid)).toEqual([child.pid]);
    await exited(child);
    expect(alive(child.pid!)).toBe(false);
    expect(exitedIds).toEqual([`row-${child.pid}`]);
    expect(store.listOpen).toHaveBeenCalledWith(INSTANCE);
  });

  it('leaves a process alone when its pid now names another start time', async () => {
    const child = start('sleep 30');
    const { store, exitedIds } = fakeStore([
      row({ pid: child.pid!, startIdentity: 'Mon Jan  1 00:00:00 2001' }),
    ]);
    const outcome = await sweep(store);
    expect(outcome.gone.map((r) => r.pid)).toEqual([child.pid]);
    expect(alive(child.pid!)).toBe(true);
    expect(exitedIds).toEqual([`row-${child.pid}`]);
  });

  it('reports, and never signals, a live pid whose start time was not recorded', async () => {
    const child = start('sleep 30');
    const { store, exitedIds } = fakeStore([row({ pid: child.pid!, startIdentity: null })]);
    const outcome = await sweep(store);
    expect(outcome.uncertain.map((r) => r.pid)).toEqual([child.pid]);
    expect(alive(child.pid!)).toBe(true);
    // Left open, for the next start to look at again.
    expect(exitedIds).toEqual([]);
  });

  it('records a dead pid exited without signalling anything', async () => {
    const child = start('true');
    await exited(child);
    const { store, exitedIds } = fakeStore([row({ pid: child.pid!, startIdentity: 'whatever' })]);
    const outcome = await sweep(store);
    expect(outcome.gone.map((r) => r.pid)).toEqual([child.pid]);
    expect(exitedIds).toEqual([`row-${child.pid}`]);
  });

  it('treats a row from another boot as gone, even when its pid is alive now', async () => {
    const child = start('sleep 30');
    const identity = await processStartIdentity(child.pid!);
    const { store } = fakeStore([
      row({ pid: child.pid!, startIdentity: identity, bootId: 'boot-earlier' }),
    ]);
    const outcome = await sweep(store);
    expect(outcome.gone.map((r) => r.pid)).toEqual([child.pid]);
    expect(alive(child.pid!)).toBe(true);
  });

  it('stops a group as a whole, its tools included', async () => {
    const leader = start('sleep 30 & sleep 30; wait', { detached: true });
    const identity = await processStartIdentity(leader.pid!);
    const { store } = fakeStore([
      row({ pid: leader.pid!, pgid: leader.pid!, startIdentity: identity }),
    ]);
    const outcome = await sweep(store);
    expect(outcome.stopped).toHaveLength(1);
    expect(probeGroup(leader.pid!)).toBe('empty');
  });

  it('holds, and never signals, a group whose leader already exited: it cannot be verified', async () => {
    const leader = start('sleep 30 &', { detached: true });
    await exited(leader);
    expect(probeGroup(leader.pid!)).toBe('alive');
    const { store, exitedIds } = fakeStore([
      row({ pid: leader.pid!, pgid: leader.pid!, startIdentity: 'x' }),
    ]);
    const outcome = await sweep(store);
    expect(outcome.uncertain).toHaveLength(1);
    expect(probeGroup(leader.pid!)).toBe('alive');
    expect(exitedIds).toEqual([]);
  });

  it('holds a group it cannot probe, rather than calling it gone', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: number | string
    ) => {
      if (signal !== 0) throw Object.assign(new Error('unexpected signal'), { code: 'EINVAL' });
      // The leader is gone; the group answers EPERM, which says nothing either way.
      throw Object.assign(new Error(pid < 0 ? 'EPERM' : 'ESRCH'), {
        code: pid < 0 ? 'EPERM' : 'ESRCH',
      });
    }) as never);
    try {
      const { store, exitedIds } = fakeStore([
        row({ pid: 999_991, pgid: 999_991, startIdentity: 'x' }),
      ]);
      const outcome = await sweep(store);
      expect(outcome.uncertain).toHaveLength(1);
      expect(exitedIds).toEqual([]);
    } finally {
      kill.mockRestore();
    }
  });

  it('escalates to SIGKILL for a process that ignores SIGINT and SIGTERM', async () => {
    const child = start('trap "" INT TERM; while :; do sleep 1; done');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const identity = await processStartIdentity(child.pid!);
    const { store } = fakeStore([row({ pid: child.pid!, startIdentity: identity })]);
    const outcome = await sweep(store);
    expect(outcome.stopped.map((r) => r.pid)).toEqual([child.pid]);
    await exited(child);
    expect(child.signalCode).toBe('SIGKILL');
  });
});

describe('reserveLaunch', () => {
  it('does nothing until recording is configured', async () => {
    const launch = await reserveLaunch('session-fixture', 'codex-cli');
    expect(launch.refused).toBeUndefined();
    expect(launch.env).toEqual({});
    expect(() => {
      launch.spawned({ pid: process.pid });
      launch.exited();
    }).not.toThrow();
  });

  it('writes the launch before its process, tags the process, adds its pid, and stamps it once gone', async () => {
    const { store } = fakeStore([]);
    configureLaunchRecording({ store, serverInstance: INSTANCE, bootId: BOOT });
    const launch = await reserveLaunch('session-fixture', 'claude-code');
    expect(store.reserve).toHaveBeenCalledWith({
      sessionId: 'session-fixture',
      backend: 'claude-code',
      bootId: BOOT,
      serverInstance: INSTANCE,
    });
    expect(launch.env).toEqual({ INK_LAUNCH_ID: 'row-new' });
    const child = start('sleep 30');
    launch.spawned({ pid: child.pid! });
    await vi.waitFor(() =>
      expect(store.attach).toHaveBeenCalledWith('row-new', {
        pid: child.pid,
        pgid: null,
        startIdentity: expect.any(String),
      })
    );
    child.kill('SIGKILL');
    await exited(child);
    launch.exited();
    await vi.waitFor(() => expect(store.markExited).toHaveBeenCalledWith(['row-new']));
  });

  it('never stamps a launch whose process is still alive, whatever the runner said', async () => {
    const child = start('sleep 30');
    const { store } = fakeStore([]);
    configureLaunchRecording({ store, serverInstance: INSTANCE, bootId: BOOT });
    const launch = await reserveLaunch('session-fixture', 'codex-cli');
    launch.spawned({ pid: child.pid! });
    launch.exited();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.markExited).not.toHaveBeenCalled();
  });

  it('retries the write, and refuses the launch when it cannot be written', async () => {
    const { store } = fakeStore([]);
    vi.mocked(store.reserve).mockRejectedValue(new Error('db down'));
    configureLaunchRecording({
      store,
      serverInstance: INSTANCE,
      bootId: BOOT,
      reserveDelaysMs: [0, 1, 1],
    });
    const launch = await reserveLaunch('session-fixture', 'claude-code');
    expect(store.reserve).toHaveBeenCalledTimes(3);
    expect(launch.refused).toMatch(/could not be recorded before starting it/);
    expect(launch.env).toEqual({});
  });

  it('starts a launch whose write succeeded on a retry', async () => {
    const { store } = fakeStore([]);
    vi.mocked(store.reserve)
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce('row-2');
    configureLaunchRecording({
      store,
      serverInstance: INSTANCE,
      bootId: BOOT,
      reserveDelaysMs: [0, 1, 1],
    });
    const launch = await reserveLaunch('session-fixture', 'claude-code');
    expect(launch.refused).toBeUndefined();
    expect(launch.env).toEqual({ INK_LAUNCH_ID: 'row-2' });
  });

  it('never throws into the turn when the pid cannot be added: the row and the tag remain', async () => {
    const { store } = fakeStore([]);
    vi.mocked(store.attach).mockRejectedValue(new Error('db down'));
    configureLaunchRecording({ store, serverInstance: INSTANCE, bootId: BOOT });
    const launch = await reserveLaunch('session-fixture', 'claude-code');
    const child = start('sleep 30');
    launch.spawned({ pid: child.pid! });
    await vi.waitFor(() => expect(store.attach).toHaveBeenCalled());
    expect(launchHoldFor('session-fixture')).toBeUndefined();
    child.kill('SIGKILL');
    await exited(child);
    launch.exited();
    await vi.waitFor(() => expect(store.markExited).toHaveBeenCalledWith(['row-new']));
  });
});

// Real process-table scans: two `ps -E` passes and a re-look on macOS, each
// over every process of this user, which under a full parallel suite can
// outlast vitest's 5 s per-test default.
describe('launches found by their tag', { timeout: 30_000 }, () => {
  it('finds a launch by the id in its environment, and stops it, when its pid never reached the row', async () => {
    const child = startTagged({ INK_LAUNCH_ID: 'row-tagged' }, [], asClaude());
    await vi.waitFor(
      async () =>
        expect(
          (await findTaggedProcesses(new Set(['row-tagged']))).tagged
            .get('row-tagged')
            ?.map((p) => p.pid)
        ).toEqual([child.pid]),
      // A real process-table scan: two `ps -E` passes on macOS, slow under load.
      { timeout: 10_000 }
    );
    const { store, exitedIds } = fakeStore([row({ id: 'row-tagged', pid: null })]);
    const outcome = await sweep(store);
    expect(outcome.stopped.map((r) => r.pid)).toEqual([child.pid]);
    await exited(child);
    expect(exitedIds).toEqual(['row-tagged']);
  });

  it('finds a later attempt by its tag while the row still names an earlier one that has exited', async () => {
    const earlier = start('true');
    await exited(earlier);
    const later = startTagged({ INK_LAUNCH_ID: 'row-retried' }, [], asClaude());
    await vi.waitFor(
      async () =>
        expect(
          (await findTaggedProcesses(new Set(['row-retried']))).tagged.get('row-retried')
        ).toHaveLength(1),
      // A real process-table scan: two `ps -E` passes on macOS, slow under load.
      { timeout: 10_000 }
    );
    const { store, exitedIds } = fakeStore([row({ id: 'row-retried', pid: earlier.pid! })]);
    const outcome = await sweep(store);
    expect(outcome.stopped.map((r) => r.pid)).toEqual([later.pid]);
    await exited(later);
    expect(exitedIds).toEqual(['row-retried']);
  });

  it('keeps the tag first through the wrapper path a runner takes: resolveSpawnTarget, then a /usr/bin/env node script', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'launch-wrapper-'));
    fakeBackendDirs.push(dir);
    const script = join(dir, 'codex');
    writeFileSync(script, '#!/usr/bin/env node\nsetTimeout(() => {}, 30000);\n');
    chmodSync(script, 0o755);
    const target = resolveSpawnTarget({
      binary: script,
      args: ['exec'],
      // The real node first: a PATH shim would put a shell in between (next test).
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: '/h',
        INK_LAUNCH_ID: 'row-wrapped',
      },
    });
    const child = spawn(target.binary, target.args, {
      stdio: 'ignore',
      env: target.env as NodeJS.ProcessEnv,
    });
    children.push(child);
    await vi.waitFor(
      async () =>
        expect(
          (await findTaggedProcesses(new Set(['row-wrapped']))).tagged.get('row-wrapped')
        ).toEqual([{ pid: child.pid, pgid: null, command: expect.stringContaining('codex exec') }]),
      // A real process-table scan: two `ps -E` passes on macOS, slow under load.
      { timeout: 10_000 }
    );
  });

  it('stops or holds, never drops, a launch whose shell shim rebuilt its environment', async () => {
    // As Yarn's PATH shims are: `#!/bin/sh` then exec node with the script. The
    // shell rebuilds the environment in its own order, so on macOS the tag need
    // not stay first; on Linux /proc reads it exactly either way.
    const dir = mkdtempSync(join(tmpdir(), 'launch-shim-'));
    fakeBackendDirs.push(dir);
    writeFileSync(join(dir, 'codex.js'), 'setTimeout(() => {}, 30000);\n');
    const shim = join(dir, 'codex');
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'codex.js')}" "$@"\n`);
    chmodSync(shim, 0o755);
    const target = resolveSpawnTarget({
      binary: shim,
      args: ['exec'],
      env: { PATH: '/usr/bin:/bin', HOME: '/h', INK_LAUNCH_ID: 'row-shimmed' },
    });
    const child = spawn(target.binary, target.args, {
      stdio: 'ignore',
      env: target.env as NodeJS.ProcessEnv,
    });
    children.push(child);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { store, exitedIds } = fakeStore([
      row({ id: 'row-shimmed', backend: 'codex-cli', pid: null }),
    ]);
    const outcome = await sweep(store);
    expect([...outcome.stopped, ...outcome.uncertain].map((r) => r.pid)).toContain(child.pid);
    expect(outcome.gone.map((r) => r.id)).not.toContain('row-shimmed');
    // Held, its row stays open.
    if (outcome.uncertain.some((r) => r.pid === child.pid)) {
      expect(exitedIds).not.toContain('row-shimmed');
    }
  });

  it('never matches the tag’s text inside another variable, even in a process named as the backend', async () => {
    const bystander = spawn(asClaude(), ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore',
      env: { ...process.env, FIXTURE_NOTE: 'prefix INK_LAUNCH_ID=row-named suffix' },
    });
    children.push(bystander);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(
      (await findTaggedProcesses(new Set(['row-named']))).tagged.get('row-named')
    ).toBeUndefined();
    const { store } = fakeStore([row({ id: 'row-named', pid: null })]);
    await sweep(store);
    expect(alive(bystander.pid!)).toBe(true);
  });

  it('holds a launch whose found attempt is stopped while another that could be it cannot be read', async () => {
    const found = start('sleep 30');
    const sibling = start('sleep 30');
    const { store, exitedIds } = fakeStore([row({ id: 'row-two', pid: null })]);
    const outcome = await stopSurvivingLaunches(store, {
      serverInstance: INSTANCE,
      bootId: BOOT,
      graceMs: 300,
      findTagged: async () => ({
        tagged: new Map([['row-two', [{ pid: found.pid!, pgid: null, command: '/x/claude -p' }]]]),
        unreadable: [{ pid: sibling.pid!, pgid: null, command: '/x/claude -p' }],
      }),
    });
    expect(outcome.stopped.map((r) => r.pid)).toEqual([found.pid]);
    expect(outcome.uncertain.map((r) => r.pid)).toEqual([sibling.pid]);
    expect(exitedIds).toEqual([]);
  });

  it('never signals a process that is not the backend, whatever its environment says', async () => {
    // Another variable's value holding the tag's text: space-joined `ps -E`
    // cannot tell it from the tag, so the process's own name decides.
    const bystander = startTagged({ FIXTURE_NOTE: 'prefix INK_LAUNCH_ID=row-bystander suffix' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const { store } = fakeStore([row({ id: 'row-bystander', pid: null })]);
    const outcome = await sweep(store);
    expect(outcome.stopped).toEqual([]);
    expect(alive(bystander.pid!)).toBe(true);
  });

  it('records a launch no process carries as gone, without signalling anything', async () => {
    const kill = vi.spyOn(process, 'kill');
    try {
      const { store, exitedIds } = fakeStore([row({ id: 'row-untagged', pid: null })]);
      const outcome = await stopSurvivingLaunches(store, {
        serverInstance: INSTANCE,
        bootId: BOOT,
        findTagged: emptyInventory,
      });
      expect(outcome.gone.map((r) => r.id)).toEqual(['row-untagged']);
      expect(exitedIds).toEqual(['row-untagged']);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it('holds a launch, and its session, while a process that could be its backend cannot be read', async () => {
    const suspect = start('sleep 30');
    const { store, exitedIds } = fakeStore([row({ id: 'row-unread', pid: null })]);
    const outcome = await stopSurvivingLaunches(store, {
      serverInstance: INSTANCE,
      bootId: BOOT,
      findTagged: async () => ({
        tagged: new Map(),
        unreadable: [{ pid: suspect.pid!, pgid: null, command: '/opt/bin/claude --print' }],
      }),
    });
    expect(outcome.uncertain.map((r) => [r.id, r.pid])).toEqual([['row-unread', suspect.pid]]);
    expect(exitedIds).toEqual([]);
    holdSurvivors(outcome);
    try {
      expect(launchHoldFor('session-fixture')).toMatch(/may still be running/);
      suspect.kill('SIGKILL');
      await exited(suspect);
      expect(launchHoldFor('session-fixture')).toBeUndefined();
    } finally {
      resetLaunchHolds();
    }
  });

  it('does not hold a launch for an unreadable process that cannot be its backend', async () => {
    const { store, exitedIds } = fakeStore([row({ id: 'row-other', pid: null })]);
    const outcome = await stopSurvivingLaunches(store, {
      serverInstance: INSTANCE,
      bootId: BOOT,
      findTagged: async () => ({
        tagged: new Map(),
        unreadable: [{ pid: process.pid, pgid: null, command: '/bin/sleep 30' }],
      }),
    });
    expect(outcome.gone.map((r) => r.id)).toEqual(['row-other']);
    expect(exitedIds).toEqual(['row-other']);
  });

  it('fails the sweep, holding every turn, when the process table cannot be read', async () => {
    const { store } = fakeStore([row({ id: 'row-unread', pid: null })]);
    await expect(
      stopSurvivingLaunches(store, {
        serverInstance: INSTANCE,
        bootId: BOOT,
        findTagged: async () => {
          throw new Error('ps failed');
        },
      })
    ).rejects.toThrow('ps failed');
    expect(store.markExited).not.toHaveBeenCalled();
  });

  it('never reads an argument that mentions a launch id as its tag', async () => {
    const child = startTagged({}, ['INK_LAUNCH_ID=row-arg'], asClaude());
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(alive(child.pid!)).toBe(true);
    expect((await findTaggedProcesses(new Set(['row-arg']))).tagged.get('row-arg')).toBeUndefined();
  });

  it.skipIf(process.platform !== 'darwin')(
    'reports a process whose environment macOS hides as unreadable',
    async () => {
      const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
      children.push(child);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const { unreadable } = await findTaggedProcesses(new Set(['row-none']));
      expect(unreadable.find((p) => p.pid === child.pid)?.command).toMatch(/sleep 30/);
    }
  );

  it('knows each backend by its executable or the script its interpreter runs', () => {
    expect(couldBeBackend('claude-code', '/Users/x/.local/bin/claude --print')).toBe(true);
    expect(couldBeBackend('codex-cli', 'node /opt/homebrew/bin/codex exec')).toBe(true);
    expect(couldBeBackend('codex-cli', '/x/codex resume abc')).toBe(true);
    expect(couldBeBackend('gemini', 'node /x/lib/gemini.js -p')).toBe(true);
    expect(couldBeBackend('ink', 'node /x/packages/cli/dist/cli.js chat')).toBe(true);
    expect(couldBeBackend('antigravity', '/x/agy chat')).toBe(true);
    expect(couldBeBackend('claude-code', 'node -e setTimeout()')).toBe(false);
    expect(couldBeBackend('claude-code', '/bin/zsh -c claude')).toBe(false);
    expect(couldBeBackend('some-new-backend', 'anything')).toBe(true);
    // A command line that could not be read could be any backend.
    expect(couldBeBackend('claude-code', null)).toBe(true);
  });
});

describe('every runner reports its launches', () => {
  // A census of the spawn seams: each physical spawn in a runner is followed
  // by its onSpawned report, before anything else can happen to the process.
  // claude-runner.stop.test.ts checks the report itself on a real launch.
  it.each([
    'claude-runner.ts',
    'ink-runner.ts',
    'codex-runner.ts',
    'gemini-runner.ts',
    'antigravity-runner.ts',
  ])('%s', (file) => {
    const lines = readFileSync(join(__dirname, file), 'utf-8').split('\n');
    const spawns = lines
      .map((line, i) => ({ line, i }))
      .filter(
        ({ line }) =>
          /\bspawn\((?!\))/.test(line) &&
          !line.trim().startsWith('//') &&
          !line.trim().startsWith('*')
      );
    expect(spawns.length, file).toBeGreaterThan(0);
    for (const { i } of spawns) {
      const after = lines.slice(i, i + 12).join('\n');
      expect(after, `${file}:${i + 1}`).toMatch(/onSpawned\?\.\(\{ pid: (proc|child)\.pid/);
    }
  });
});

describe('launchHoldFor', () => {
  afterEach(() => resetLaunchHolds());

  it('holds a session while its unresolved survivor lives, and lets it go once it has gone', async () => {
    const child = start('sleep 30');
    const { store } = fakeStore([]);
    configureLaunchRecording({ store, serverInstance: INSTANCE, bootId: BOOT });
    const held = row({ pid: child.pid!, sessionId: 'held-session' });
    holdSurvivors({ stopped: [], gone: [], unstoppable: [], uncertain: [held] });
    expect(launchHoldFor('held-session')).toMatch(/may still be running this session/);
    expect(launchHoldFor('another-session')).toBeUndefined();
    child.kill('SIGKILL');
    await exited(child);
    expect(launchHoldFor('held-session')).toBeUndefined();
    await vi.waitFor(() => expect(store.markExited).toHaveBeenCalledWith([held.id]));
  });

  it('holds every session while the boot cannot be read, and lets go once a retry reads it', async () => {
    const listing = { is: async () => ({ data: [], error: null }) };
    const client = { from: () => ({ select: () => ({ eq: () => listing }) }) };
    let reads = 0;
    const readBoot = async () => {
      reads += 1;
      if (reads === 1) throw new Error('sysctl failed');
      return BOOT;
    };
    expect(await startLaunchTracking(client as never, 3001, 50, readBoot)).toBeUndefined();
    expect(launchHoldFor('any-session')).toMatch(/startup check/);
    await vi.waitFor(() => expect(launchHoldFor('any-session')).toBeUndefined());
    expect(reads).toBe(2);
  });

  it('never starts a second attempt while one is still in flight', async () => {
    // The second attempt reads the boot, then stalls on the inventory: a third
    // started meanwhile could sweep a launch admitted after the second ends.
    let releaseInventory: (value: { data: never[]; error: null }) => void = () => undefined;
    const inventory = new Promise<{ data: never[]; error: null }>((resolve) => {
      releaseInventory = resolve;
    });
    const client = { from: () => ({ select: () => ({ eq: () => ({ is: () => inventory }) }) }) };
    let reads = 0;
    const readBoot = async () => {
      reads += 1;
      if (reads === 1) throw new Error('sysctl failed');
      return BOOT;
    };
    await startLaunchTracking(client as never, 3001, 10, readBoot);
    await vi.waitFor(() => expect(reads).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reads).toBe(2);
    expect(launchHoldFor('any-session')).toMatch(/startup check/);
    releaseInventory({ data: [], error: null });
    await vi.waitFor(() => expect(launchHoldFor('any-session')).toBeUndefined());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads).toBe(2);
  });

  it('holds every session when the startup sweep could not run', async () => {
    const failing = {
      from: () => ({
        select: () => ({
          eq: () => ({ is: async () => ({ data: null, error: { message: 'db down' } }) }),
        }),
      }),
    };
    expect(await startLaunchTracking(failing as never, 3001)).toBeUndefined();
    expect(launchHoldFor('any-session')).toMatch(/startup check/);
  });
});
