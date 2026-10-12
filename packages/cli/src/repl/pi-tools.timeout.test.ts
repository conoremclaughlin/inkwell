import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { createBashTool } from '@mariozechner/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASH_TIMEOUT_BOUNDS, boundedBashTimeout } from './bash-timeout.js';
import { boundBashTool } from './pi-tools.js';

/**
 * Real shells, real processes, short bounds. Every fixture is a `sleep` that
 * ends on its own within 20 s, so a broken guard leaves nothing behind for
 * long. The vitest timeout on each case is shorter than that sleep: a guard
 * that never fires fails the case rather than waiting the fixture out.
 */
const SHORT = { defaultSeconds: 1, maxSeconds: 2 };
const FIXTURE_SECONDS = 20;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function gone(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((settle) => setTimeout(settle, 50));
  }
  return !alive(pid);
}

async function readPid(file: string): Promise<number | null> {
  try {
    const pid = Number((await readFile(file, 'utf8')).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function failure(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the shell call to fail');
}

describe('boundedBashTimeout', () => {
  it('ships the approved limits', () => {
    expect(BASH_TIMEOUT_BOUNDS).toEqual({ defaultSeconds: 600, maxSeconds: 1800 });
  });

  it.each([
    [undefined, 600],
    [null, 600],
    [0, 600],
    [-1, 600],
    [Number.NaN, 600],
    [Number.POSITIVE_INFINITY, 600],
    ['', 600],
    ['  ', 600],
    ['ten', 600],
    [{}, 600],
    [0.5, 0.5],
    [120, 120],
    ['90', 90],
    [1800, 1800],
    [1801, 1800],
  ])('%j runs with %j seconds', (requested, expected) => {
    expect(boundedBashTimeout(requested)).toBe(expected);
  });
});

describe('a bounded pi bash call (real processes)', () => {
  let cwd: string;
  let leftovers: number[];

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'pi-bash-timeout-'));
    leftovers = [];
  });

  afterEach(async () => {
    for (const pid of leftovers) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    await rm(cwd, { recursive: true, force: true });
  });

  const bash = (bounds = SHORT) => boundBashTool(createBashTool(cwd) as never, bounds);

  it('kills a command sent without a timeout at the default, its process group with it', async () => {
    const pidFile = path.join(cwd, 'child.pid');
    const started = Date.now();
    const message = await failure(
      bash().execute('t1', {
        command: `sleep ${FIXTURE_SECONDS} & echo $! > child.pid; wait`,
      })
    );
    const elapsed = Date.now() - started;

    expect(message).toContain('Command timed out after 1 seconds');
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(5000);
    const child = await readPid(pidFile);
    expect(child).not.toBeNull();
    leftovers.push(child!);
    expect(await gone(child!, 3000)).toBe(true);
  }, 10_000);

  it('clamps a request above the ceiling', async () => {
    const started = Date.now();
    const message = await failure(
      bash().execute('t2', { command: `sleep ${FIXTURE_SECONDS}`, timeout: 50 })
    );
    const elapsed = Date.now() - started;

    expect(message).toContain('Command timed out after 2 seconds');
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(6000);
  }, 10_000);

  it('honours a request within the ceiling', async () => {
    const message = await failure(
      bash({ defaultSeconds: 8, maxSeconds: 9 }).execute('t3', {
        command: `sleep ${FIXTURE_SECONDS}`,
        timeout: 1,
      })
    );
    expect(message).toContain('Command timed out after 1 seconds');
  }, 10_000);

  it('treats timeout 0 as the default, never as "no timeout"', async () => {
    const message = await failure(
      bash().execute('t4', { command: `sleep ${FIXTURE_SECONDS}`, timeout: 0 })
    );
    expect(message).toContain('Command timed out after 1 seconds');
  }, 10_000);

  it('returns a command that finishes first, and sends no kill after it has finished', async () => {
    // Pi kills a timed-out command with process.kill(-pid, 'SIGKILL'). Watching
    // every kill sent while the call runs and through the 1 s bound after it
    // is what shows the timer was cleared; a late kill at an exited group can
    // otherwise fail silently and look like nothing happened. The spy never
    // signals: a late kill would target an exited group, then a PID that may
    // have been reused.
    const kills = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const result = await bash().execute('t5', { command: 'echo finished' });
      expect(result.content.map((part) => part.text).join('')).toContain('finished');
      await new Promise((settle) => setTimeout(settle, 1500));
      expect(kills).not.toHaveBeenCalled();
    } finally {
      kills.mockRestore();
    }
  }, 10_000);

  it('stops at once when the call is already aborted', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const pidFile = path.join(cwd, 'child.pid');
    const started = Date.now();
    const message = await failure(
      bash({ defaultSeconds: 8, maxSeconds: 9 }).execute(
        't6',
        { command: `sleep ${FIXTURE_SECONDS} & echo $! > child.pid; wait` },
        aborted.signal
      )
    );

    expect(message).toContain('aborted');
    expect(Date.now() - started).toBeLessThan(3000);
    const child = await readPid(pidFile);
    if (child !== null) {
      leftovers.push(child);
      expect(await gone(child, 3000)).toBe(true);
    }
  }, 10_000);

  it('returns when the command exits, and does not reach a background job it left running', async () => {
    // The limit is per call, on what is still in the call's process group when
    // it fires. A command that has already exited is done; its background job
    // carries on, as it would in any shell. Phase 2 of the spec owns
    // background work explicitly.
    const pidFile = path.join(cwd, 'child.pid');
    const started = Date.now();
    await bash({ defaultSeconds: 8, maxSeconds: 9 }).execute('t7', {
      command: `sleep ${FIXTURE_SECONDS} >/dev/null 2>&1 & echo $! > child.pid`,
    });
    expect(Date.now() - started).toBeLessThan(3000);

    const child = await readPid(pidFile);
    expect(child).not.toBeNull();
    leftovers.push(child!);
    expect(alive(child!)).toBe(true);
  }, 10_000);
});
