import { spawn, type ChildProcess } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureLaunchRecording,
  holdSurvivors,
  launchHoldFor,
  processStartIdentity,
  resetLaunchHolds,
  startLaunchTracking,
  recordLaunch,
  stopSurvivingLaunches,
  type LaunchRow,
  type LaunchStore,
} from './launched-processes';
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
    record: vi.fn(async () => 'row-new'),
    markExited: vi.fn(async (ids: string[]) => void exitedIds.push(...ids)),
    listOpen: vi.fn(async () => rows),
  };
  return { store, exitedIds };
}

function row(over: Partial<LaunchRow> & { pid: number }): LaunchRow {
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

describe('recordLaunch', () => {
  it('does nothing until recording is configured', () => {
    expect(() =>
      recordLaunch('session-fixture', 'codex-cli', { pid: process.pid }).exited()
    ).not.toThrow();
  });

  it('records the launch with its start time, and stamps it once the run settles', async () => {
    const child = start('sleep 30');
    const { store } = fakeStore([]);
    configureLaunchRecording({ store, serverInstance: INSTANCE, bootId: BOOT });
    const launch = recordLaunch('session-fixture', 'claude-code', { pid: child.pid! });
    await vi.waitFor(() => expect(store.record).toHaveBeenCalled());
    // Stamped only once the process is seen gone.
    child.kill('SIGKILL');
    await exited(child);
    launch.exited();
    await vi.waitFor(() => expect(store.markExited).toHaveBeenCalledWith(['row-new']));
    expect(store.record).toHaveBeenCalledWith({
      sessionId: 'session-fixture',
      backend: 'claude-code',
      pid: child.pid,
      pgid: null,
      startIdentity: expect.any(String),
      bootId: BOOT,
      serverInstance: INSTANCE,
    });
  });

  it('never stamps a launch whose process is still alive, whatever the runner said', async () => {
    const child = start('sleep 30');
    const { store } = fakeStore([]);
    configureLaunchRecording({ store, serverInstance: INSTANCE, bootId: BOOT });
    const launch = recordLaunch('session-fixture', 'codex-cli', { pid: child.pid! });
    await vi.waitFor(() => expect(store.record).toHaveBeenCalled());
    launch.exited();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.markExited).not.toHaveBeenCalled();
  });

  it('never throws into the turn when the store fails, and holds the session while that process lives', async () => {
    const store: LaunchStore = {
      record: vi.fn(async () => {
        throw new Error('db down');
      }),
      markExited: vi.fn(async () => undefined),
      listOpen: vi.fn(async () => []),
    };
    configureLaunchRecording({ store, serverInstance: INSTANCE, bootId: BOOT });
    const launch = recordLaunch('session-fixture', 'claude-code', { pid: process.pid });
    launch.exited();
    await vi.waitFor(() => expect(store.record).toHaveBeenCalled());
    expect(store.markExited).not.toHaveBeenCalled();
    // This test process is the "launch": alive, so its session is held.
    await vi.waitFor(() =>
      expect(launchHoldFor('session-fixture')).toMatch(/may still be running/)
    );
    resetLaunchHolds();
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
