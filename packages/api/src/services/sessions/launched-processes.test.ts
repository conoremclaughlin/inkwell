import { spawn, type ChildProcess } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureLaunchRecording,
  processStartIdentity,
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

  it('stops a group whose leader already exited, since its id cannot be reused', async () => {
    const leader = start('sleep 30 &', { detached: true });
    await exited(leader);
    expect(probeGroup(leader.pid!)).toBe('alive');
    const { store } = fakeStore([row({ pid: leader.pid!, pgid: leader.pid!, startIdentity: 'x' })]);
    const outcome = await sweep(store);
    expect(outcome.stopped).toHaveLength(1);
    expect(probeGroup(leader.pid!)).toBe('empty');
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
    const launch = recordLaunch('session-fixture', 'claude-code', {
      pid: child.pid!,
      pgid: child.pid!,
    });
    launch.exited();
    await vi.waitFor(() => expect(store.markExited).toHaveBeenCalledWith(['row-new']));
    expect(store.record).toHaveBeenCalledWith({
      sessionId: 'session-fixture',
      backend: 'claude-code',
      pid: child.pid,
      pgid: child.pid,
      startIdentity: await processStartIdentity(child.pid!),
      bootId: BOOT,
      serverInstance: INSTANCE,
    });
  });

  it('never throws into the turn when the store fails', async () => {
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
