/**
 * The stop fence against real, harmless processes, each in a disposable
 * group this test starts itself (Lumen eeb45589): only the group probing
 * ESRCH releases it, so a process forked after the stop still holds it.
 * Every pid a test learns is killed by that exact pid afterwards.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { clearInklingFences, fenceInkling, inklingFenceHolds } from './inkling-stop-fence';

const dir = mkdtempSync(join(tmpdir(), 'inkling-fence-'));
const pids: number[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  clearInklingFences();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A group leader of our own, once its handlers are in place. */
async function startLeader(code: string): Promise<ChildProcess> {
  const leader = spawn(process.execPath, ['-e', code], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  pids.push(leader.pid as number);
  await new Promise((resolve) => leader.stdout!.once('data', resolve));
  return leader;
}

describe('the inkling stop fence, with real processes', () => {
  it('a member that forks a replacement after the snapshot and exits leaves the fence held until the replacement is gone', async () => {
    const replacementFile = join(dir, 'replacement.pid');
    const replacement = `require('fs').writeFileSync(${JSON.stringify(replacementFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    // On SIGUSR2 the leader starts a replacement in its own group, then exits.
    const leader = await startLeader(
      `process.on('SIGUSR2', () => { require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(replacement)}], { stdio: 'ignore' }); setTimeout(() => process.exit(0), 200); }); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`
    );
    const pgid = leader.pid as number;
    // At this point the leader is the group's only member.
    fenceInkling('sb-forks', { leaderExited: false, pgid, group: 'alive' });

    const leaderGone = new Promise((resolve) => leader.once('exit', resolve));
    process.kill(pgid, 'SIGUSR2');
    await waitFor(
      () => existsSync(replacementFile) && Number(readFileSync(replacementFile, 'utf-8')) > 0
    );
    const replacementPid = Number(readFileSync(replacementFile, 'utf-8'));
    pids.push(replacementPid);
    await leaderGone;

    // Every process the group held when it was fenced is gone; the group is not.
    expect(inklingFenceHolds('sb-forks')).toBe(true);
    process.kill(replacementPid, 'SIGKILL');
    await waitFor(() => !inklingFenceHolds('sb-forks'));
  }, 20_000);

  it('a group that cannot be observed (EPERM) keeps the fence held; only ESRCH releases it', async () => {
    const leader = await startLeader(
      "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"
    );
    const pgid = leader.pid as number;
    const original = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number
    ) => {
      if (pid < 0 && signal === 0) {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      }
      return original(pid, signal);
    }) as typeof process.kill);
    fenceInkling('sb-unknown', { leaderExited: true, pgid, group: 'unknown' });
    expect(inklingFenceHolds('sb-unknown')).toBe(true);

    vi.restoreAllMocks();
    // Observable now, and alive: still held.
    expect(inklingFenceHolds('sb-unknown')).toBe(true);
    const gone = new Promise((resolve) => leader.once('exit', resolve));
    process.kill(pgid, 'SIGKILL');
    await gone;
    await waitFor(() => !inklingFenceHolds('sb-unknown'));
  }, 20_000);
});
