/**
 * stopProcess against real, harmless node processes that ignore SIGTERM.
 * Every pid a test learns is killed by that exact pid afterwards.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { stopProcess, stopProcessAndWait } from './stop-process';

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
  it('settles true once a process that ignores SIGTERM has exited at the SIGKILL, not before', async () => {
    const proc = start(READY_IGNORES_TERM);
    await firstLine(proc);
    const started = Date.now();
    expect(await stopProcessAndWait(proc, { graceMs: 300, giveUpMs: 2000 })).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    expect(alive(proc.pid as number)).toBe(false);
  });

  it('settles true as soon as a process exits on SIGTERM, without waiting out the grace', async () => {
    const proc = start(READY_EXITS_ON_TERM);
    await firstLine(proc);
    const started = Date.now();
    expect(await stopProcessAndWait(proc, { graceMs: 3000, giveUpMs: 2000 })).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(alive(proc.pid as number)).toBe(false);
  });

  it('settles true at once for a process that has already exited', async () => {
    const proc = start(READY_EXITS_ON_TERM);
    await firstLine(proc);
    const gone = exited(proc);
    proc.kill('SIGKILL');
    await gone;
    const started = Date.now();
    expect(await stopProcessAndWait(proc, { graceMs: 3000, giveUpMs: 2000 })).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('settles false at grace plus give-up when the process never exits, and leaves no listener behind', async () => {
    // No real process outlives SIGKILL, so this one is a stand-in that is
    // never signalled: no pid, and a kill that does nothing.
    const proc = Object.assign(new EventEmitter(), {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    }) as unknown as ChildProcess;
    const started = Date.now();
    expect(await stopProcessAndWait(proc, { graceMs: 100, giveUpMs: 150 })).toBe(false);
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
      expect(await settled).toBe(true);
      // Only the escalation is left (stopProcess unrefs it); the give-up is gone.
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
