/**
 * What is running from a worktree (task 7ec05d10).
 *
 * The parser and the decision are pinned on synthetic lsof output. One case
 * runs the real lsof against a child process this test starts, so the
 * flags and the output format are checked against the tool itself.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { mkdtemp, realpath, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { isInside, parseLsofCwd, worktreeInUse } from './worktree-in-use';

const LSOF_OUTPUT = [
  'p101',
  'czsh',
  'fcwd',
  'n/Users/me/ws/inkling--canonical',
  'p202',
  'cnode',
  'fcwd',
  'n/Users/me/ws/inkling--canonical/packages/mobile',
  'p303',
  'cnode',
  'fcwd',
  'n/Users/me/ws/inkling--canonical-review',
  'p404',
  'claunchd',
  'fcwd',
  'n/',
  '',
].join('\n');

describe('parseLsofCwd', () => {
  it('reads one cwd per process', () => {
    expect(parseLsofCwd(LSOF_OUTPUT)).toEqual([
      { pid: 101, command: 'zsh', cwd: '/Users/me/ws/inkling--canonical' },
      { pid: 202, command: 'node', cwd: '/Users/me/ws/inkling--canonical/packages/mobile' },
      { pid: 303, command: 'node', cwd: '/Users/me/ws/inkling--canonical-review' },
      { pid: 404, command: 'launchd', cwd: '/' },
    ]);
  });
});

describe('isInside', () => {
  it('counts the root and everything beneath it, and nothing that merely shares a prefix', () => {
    expect(isInside('/ws/a', '/ws/a')).toBe(true);
    expect(isInside('/ws/a/b/c', '/ws/a')).toBe(true);
    expect(isInside('/ws/a-review', '/ws/a')).toBe(false);
    expect(isInside('/ws', '/ws/a')).toBe(false);
  });
});

describe('worktreeInUse', () => {
  const resolve = async (p: string) => p;
  /** The fixture's launchd line stands in for this process. */
  const SELF = 404;

  it('is unknown for a listing that succeeded but is empty, or lacks this process (Lumen, #766)', async () => {
    for (const stdout of ['', 'p101\nczsh\nfcwd\nn/elsewhere\n']) {
      const use = await worktreeInUse('/Users/me/ws/inkling--canonical', {
        exec: async () => ({ stdout }),
        resolve,
        selfPid: SELF,
      });
      expect(use.state).toBe('unknown');
    }
  });

  it('is unknown for a worktree path lsof would print escaped', async () => {
    for (const root of ['/ws/new\nline', '/ws/tab\there', '/ws/back\\slash', '/ws/del\u007f']) {
      const use = await worktreeInUse(root, {
        exec: async () => ({ stdout: LSOF_OUTPUT }),
        resolve,
        selfPid: SELF,
      });
      expect(use.state).toBe('unknown');
    }
  });

  it('still matches paths with spaces and non-ASCII letters', async () => {
    const listing = 'p404\nclaunchd\nfcwd\nn/\np7\ncnode\nfcwd\nn/ws/my canonical é/app\n';
    const use = await worktreeInUse('/ws/my canonical é', {
      exec: async () => ({ stdout: listing }),
      resolve,
      selfPid: SELF,
    });
    expect(use.state).toBe('in-use');
  });

  it('names the processes running from the worktree, and only those', async () => {
    const use = await worktreeInUse('/Users/me/ws/inkling--canonical', {
      exec: async () => ({ stdout: LSOF_OUTPUT }),
      resolve,
      selfPid: SELF,
    });
    expect(use).toEqual({
      state: 'in-use',
      processes: [
        { pid: 101, command: 'zsh', cwd: '/Users/me/ws/inkling--canonical' },
        { pid: 202, command: 'node', cwd: '/Users/me/ws/inkling--canonical/packages/mobile' },
      ],
    });
  });

  it('is idle when nothing runs from it', async () => {
    const use = await worktreeInUse('/Users/me/ws/elsewhere', {
      exec: async () => ({ stdout: LSOF_OUTPUT }),
      resolve,
      selfPid: SELF,
    });
    expect(use).toEqual({ state: 'idle' });
  });

  it('is idle for a worktree that is not on disk', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const use = await worktreeInUse('/nowhere', {
      exec: async () => {
        throw new Error('must not run');
      },
      resolve: async () => {
        throw missing;
      },
    });
    expect(use).toEqual({ state: 'idle' });
  });

  it('is unknown when lsof exits non-zero, even with a listing (Lumen, #766)', async () => {
    const partial = Object.assign(new Error('Command failed: lsof'), {
      code: 1,
      stdout: LSOF_OUTPUT,
    });
    const use = await worktreeInUse('/Users/me/ws/elsewhere', {
      exec: async () => {
        throw partial;
      },
      resolve,
      selfPid: SELF,
    });
    // Even for a path nothing in that listing uses: the listing is not
    // known to be complete.
    expect(use.state).toBe('unknown');
  });

  it('is unknown when lsof printed nothing, or was killed partway', async () => {
    for (const failure of [
      Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' }),
      Object.assign(new Error('Command failed'), { code: 1, stdout: '' }),
      Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM', stdout: 'p1\n' }),
    ]) {
      const use = await worktreeInUse('/Users/me/ws/inkling--canonical', {
        exec: async () => {
          throw failure;
        },
        resolve,
      });
      expect(use.state).toBe('unknown');
    }
  });

  it('is unknown when the worktree path cannot be resolved for another reason', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    const use = await worktreeInUse('/locked', {
      exec: async () => ({ stdout: LSOF_OUTPUT }),
      resolve: async () => {
        throw denied;
      },
    });
    expect(use.state).toBe('unknown');
  });
});

let hasLsof = true;
try {
  execFileSync('lsof', ['-v'], { stdio: 'ignore' });
} catch (error) {
  hasLsof = (error as NodeJS.ErrnoException).code !== 'ENOENT';
}

describe.skipIf(!hasLsof)('worktreeInUse against the real lsof', () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    // Only the exact process this test started.
    if (child?.pid && child.exitCode === null) child.kill('SIGKILL');
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('sees a process running from a subdirectory, and not once it has exited', async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), 'worktree-in-use-')));
    const nested = path.join(dir, 'packages', 'app');
    await mkdir(nested, { recursive: true });

    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); console.log("ready")'], {
      cwd: nested,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    await new Promise<void>((resolve) => child!.stdout!.once('data', () => resolve()));

    const running = await worktreeInUse(dir);
    expect(running.state).toBe('in-use');
    expect(running.state === 'in-use' && running.processes.map((p) => p.pid)).toContain(child.pid);

    const exited = new Promise((resolve) => child!.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    expect(await worktreeInUse(dir)).toEqual({ state: 'idle' });
  });

  it('never reads a live child under a directory with a newline in its name as idle', async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), 'worktree-in-use-nl-')));
    const odd = path.join(dir, 'new\nline');
    await mkdir(odd);
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); console.log("ready")'], {
      cwd: odd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    await new Promise<void>((resolve) => child!.stdout!.once('data', () => resolve()));

    expect((await worktreeInUse(odd)).state).not.toBe('idle');
  });
});
