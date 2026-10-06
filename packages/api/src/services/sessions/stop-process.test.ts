/**
 * stopProcess against real, harmless node processes that ignore SIGTERM.
 * Every pid a test learns is killed by that exact pid afterwards.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { isGroupId, probeGroup, stopProcess, stopProcessAndWait } from './stop-process';

const IGNORES_TERM = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
/** Starts a grandchild that also ignores SIGTERM, prints its pid, then idles. */
const WITH_GRANDCHILD = `
  const { spawn } = require('node:child_process');
  const g = spawn(process.execPath, ['-e', ${JSON.stringify(IGNORES_TERM)}], { stdio: 'ignore' });
  process.stdout.write(g.pid + '\\n'); // not console.log: FORCE_COLOR would colour the number
  ${IGNORES_TERM}
`;

const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
});

function start(script: string, detached = false): ChildProcess {
  const proc = spawn(process.execPath, ['-e', script], {
    detached,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  pids.push(proc.pid as number);
  return proc;
}

const exited = (proc: ChildProcess) =>
  new Promise<NodeJS.Signals | null>((resolve) =>
    proc.once('exit', (_c, signal) => resolve(signal))
  );

const firstLine = (proc: ChildProcess) =>
  new Promise<number>((resolve) =>
    proc.stdout!.once('data', (d) => resolve(Number(String(d).trim())))
  );

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('stopProcess', () => {
  it('a process that ignores SIGTERM is SIGKILLed after the grace period', async () => {
    const proc = start(IGNORES_TERM);
    await settle(200);
    const gone = exited(proc);
    stopProcess(proc, { graceMs: 100 });
    expect(await gone).toBe('SIGKILL');
  });

  it('with group, the tools it started go too', async () => {
    const proc = start(WITH_GRANDCHILD, true);
    const grandchild = await firstLine(proc);
    pids.push(grandchild);
    expect(alive(grandchild)).toBe(true);
    stopProcess(proc, { group: true, graceMs: 100 });
    await exited(proc);
    await settle(300);
    expect(alive(grandchild)).toBe(false);
  });

  it('without group, a grandchild outlives its parent (why inkling runs use the group)', async () => {
    const proc = start(WITH_GRANDCHILD, true);
    const grandchild = await firstLine(proc);
    pids.push(grandchild);
    stopProcess(proc, { graceMs: 100 });
    await exited(proc);
    await settle(300);
    expect(alive(grandchild)).toBe(true);
  });
});

/** Prints its pid once its SIGTERM handler is in place, so a stop never lands before it. */
const READY_IGNORES_TERM = `
  process.on('SIGTERM', () => {});
  process.stdout.write(process.pid + '\\n');
  setInterval(() => {}, 1000);
`;
const READY_EXITS_ON_TERM = `
  process.stdout.write(process.pid + '\\n');
  setInterval(() => {}, 1000);
`;

describe('stopProcessAndWait', () => {
  it('settles as exited once a process that ignores SIGTERM has exited at the SIGKILL, not before', async () => {
    const proc = start(READY_IGNORES_TERM);
    await firstLine(proc);
    const started = Date.now();
    expect(await stopProcessAndWait(proc, { graceMs: 300, giveUpMs: 2000 })).toEqual({
      exited: true,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    expect(alive(proc.pid as number)).toBe(false);
  });

  it('settles as exited as soon as a process exits on SIGTERM, without waiting out the grace', async () => {
    const proc = start(READY_EXITS_ON_TERM);
    await firstLine(proc);
    const started = Date.now();
    expect(await stopProcessAndWait(proc, { graceMs: 3000, giveUpMs: 2000 })).toEqual({
      exited: true,
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(alive(proc.pid as number)).toBe(false);
  });

  it('settles as exited at once for a process that has already exited', async () => {
    const proc = start(READY_EXITS_ON_TERM);
    await firstLine(proc);
    const gone = exited(proc);
    proc.kill('SIGKILL');
    await gone;
    const started = Date.now();
    expect(await stopProcessAndWait(proc, { graceMs: 3000, giveUpMs: 2000 })).toEqual({
      exited: true,
    });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('settles as not exited at grace plus give-up when the process never exits, and leaves no listener behind', async () => {
    // No real process outlives SIGKILL, so this one is a stand-in that is
    // never signalled: no pid, and a kill that does nothing.
    const proc = Object.assign(new EventEmitter(), {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    }) as unknown as ChildProcess;
    const started = Date.now();
    expect(await stopProcessAndWait(proc, { graceMs: 100, giveUpMs: 150 })).toEqual({
      exited: false,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
    expect(proc.listenerCount('exit')).toBe(0);
  });

  it('clears its give-up timer once the process exits, so nothing is left holding the event loop', async () => {
    const proc = Object.assign(new EventEmitter(), {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    }) as unknown as ChildProcess;
    vi.useFakeTimers();
    try {
      const settled = stopProcessAndWait(proc, { graceMs: 100, giveUpMs: 150 });
      // stopProcess's own SIGKILL escalation, and this helper's give-up.
      expect(vi.getTimerCount()).toBe(2);
      proc.emit('exit', 0, null);
      expect(await settled).toEqual({ exited: true });
      // Only the escalation is left (stopProcess unrefs it); the give-up is gone.
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Its tool reports its own pid once its handler is set; the leader passes it on. */
const toolScript = (ignoresTerm: boolean) =>
  (ignoresTerm ? "process.on('SIGTERM', () => {}); " : '') +
  "process.stdout.write(process.pid + '\\n'); setInterval(() => {}, 1000);";
/** A leader that exits at once on SIGTERM, having started one tool. */
const leaderWithTool = (toolIgnoresTerm: boolean) => `
  const { spawn } = require('node:child_process');
  process.on('SIGTERM', () => process.exit(0));
  const tool = spawn(process.execPath, ['-e', ${JSON.stringify(toolScript(toolIgnoresTerm))}], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  tool.stdout.once('data', (d) => process.stdout.write(String(d)));
  setInterval(() => {}, 1000);
`;

/** A group leader and its tool's pid, both tracked for cleanup. */
async function startGroup(toolIgnoresTerm: boolean): Promise<{ proc: ChildProcess; tool: number }> {
  const proc = start(leaderWithTool(toolIgnoresTerm), true);
  const tool = await firstLine(proc);
  pids.push(tool);
  return { proc, tool };
}

/** process.kill, recording every call, with group probes answering EPERM when asked. */
function spyOnKill(opts: { probesDenied?: boolean } = {}) {
  const original = process.kill.bind(process);
  const calls: Array<[number, NodeJS.Signals | number | undefined]> = [];
  const spy = vi.spyOn(process, 'kill').mockImplementation(((
    pid: number,
    signal?: NodeJS.Signals | number
  ) => {
    calls.push([pid, signal]);
    if (opts.probesDenied && pid < 0 && signal === 0) {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    }
    return original(pid, signal);
  }) as typeof process.kill);
  return { calls, restore: () => spy.mockRestore() };
}

describe('process groups: a stop is over when the whole group is gone', () => {
  it('probeGroup: alive while a member lives, empty only on ESRCH, unknown on any other error', async () => {
    const { proc, tool } = await startGroup(false);
    const pgid = proc.pid as number;
    expect(probeGroup(pgid)).toBe('alive');
    const kill = spyOnKill({ probesDenied: true });
    try {
      expect(probeGroup(pgid)).toBe('unknown');
    } finally {
      kill.restore();
    }
    process.kill(tool, 'SIGKILL');
    const gone = exited(proc);
    process.kill(pgid, 'SIGKILL');
    await gone;
    await settle(200);
    expect(probeGroup(pgid)).toBe('empty');
  });

  it('a group stop settles only once a TERM-ignoring tool has gone, though its leader exits at once', async () => {
    const { proc, tool } = await startGroup(true);
    const started = Date.now();
    const outcome = await stopProcessAndWait(proc, { group: true, graceMs: 400, giveUpMs: 2000 });
    expect(outcome).toEqual({ exited: true, group: 'empty' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(380);
    expect(alive(tool)).toBe(false);
  });

  it('once the group is seen empty, its SIGKILL is called off: a reused group number is never signalled', async () => {
    const { proc } = await startGroup(false);
    const pgid = proc.pid as number;
    const kill = spyOnKill();
    try {
      const outcome = await stopProcessAndWait(proc, { group: true, graceMs: 300, giveUpMs: 2000 });
      expect(outcome).toEqual({ exited: true, group: 'empty' });
      await settle(450);
      expect(kill.calls.filter(([pid, signal]) => pid === -pgid && signal === 'SIGKILL')).toEqual(
        []
      );
    } finally {
      kill.restore();
    }
  });

  it('a group that cannot be observed settles at the bound as unknown, never as empty', async () => {
    const { proc } = await startGroup(true);
    const kill = spyOnKill({ probesDenied: true });
    try {
      const started = Date.now();
      const outcome = await stopProcessAndWait(proc, { group: true, graceMs: 200, giveUpMs: 300 });
      expect(outcome).toEqual({ exited: true, group: 'unknown' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(480);
    } finally {
      kill.restore();
    }
  });

  it('only a positive group id above 1 is ever probed: 0 would be our own group, 1 every process', () => {
    expect([0, 1, -5, 1.5, Number.NaN].map(isGroupId)).toEqual([false, false, false, false, false]);
    expect(isGroupId(4242)).toBe(true);
    const kill = spyOnKill();
    try {
      for (const pgid of [0, 1, -5, 1.5, Number.NaN]) expect(probeGroup(pgid)).toBe('unknown');
      expect(kill.calls).toEqual([]);
    } finally {
      kill.restore();
    }
  });

  // Lumen's review of #747: asking for a group stop and being able to address
  // the group are two things. Fully mocked, so nothing reaches the host
  // whatever the code under test sends.
  it.each([undefined, 0, 1, -7, 1.5, Number.NaN])(
    'a group stop asked for without a valid group id (%s) settles with the group unknown, and signals no group',
    async (pid) => {
      const kill = vi
        .spyOn(process, 'kill')
        .mockImplementation((() => true) as typeof process.kill);
      const proc = Object.assign(new EventEmitter(), {
        pid,
        exitCode: null as number | null,
        signalCode: null,
        kill: vi.fn(() => true),
      });
      vi.useFakeTimers();
      try {
        const settled = stopProcessAndWait(proc as unknown as ChildProcess, {
          group: true,
          graceMs: 50,
          giveUpMs: 50,
        });
        let done = false;
        void settled.then(() => (done = true));
        proc.exitCode = 0;
        proc.emit('exit', 0, null);
        // There is no group to look at, so it settles at the exit.
        await vi.advanceTimersByTimeAsync(0);
        expect(done).toBe(true);
        expect(await settled).toEqual({ exited: true, group: 'unknown' });
        expect(kill).not.toHaveBeenCalled();
        // Only the process itself was signalled.
        expect(proc.kill.mock.calls).toEqual([['SIGTERM']]);
      } finally {
        vi.useRealTimers();
        kill.mockRestore();
      }
    }
  );
});
