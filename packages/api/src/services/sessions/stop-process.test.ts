/**
 * stopProcess against real, harmless node processes that ignore SIGTERM.
 * Every pid a test learns is killed by that exact pid afterwards.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { stopProcess } from './stop-process';

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
