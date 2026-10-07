/**
 * Is anything running from this worktree right now?
 *
 * The studio sweep decided liveness from the studio lease alone, and a turn
 * routed into a studio does not necessarily take that studio's lease. On
 * 2026-10-07 at 1:55 AM it removed an expired ephemeral checkout 17 seconds
 * after a Codex turn was spawned into it, with a Metro dev server and
 * several shells also running from it (task 7ec05d10). A process whose
 * working directory is inside a worktree is direct evidence that the
 * worktree is in use, whatever the lease says.
 *
 * One `lsof` over every process's cwd, about a quarter of a second on a
 * busy Mac, run only when a teardown is about to happen.
 */

import { execFile } from 'child_process';
import { realpath } from 'fs/promises';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface WorktreeProcess {
  pid: number;
  command: string;
  cwd: string;
}

export type WorktreeUse =
  | { state: 'idle' }
  | { state: 'in-use'; processes: WorktreeProcess[] }
  /** The check itself failed. Callers treat this as in use: never remove on a guess. */
  | { state: 'unknown'; error: string };

/**
 * Parse `lsof -F pcn` output: one `p<pid>` line per process, then its
 * `c<command>`, then an `f`/`n` pair per file set, here only its cwd.
 */
export function parseLsofCwd(output: string): WorktreeProcess[] {
  const processes: WorktreeProcess[] = [];
  let pid: number | null = null;
  let command = '';
  for (const line of output.split('\n')) {
    const field = line.charAt(0);
    const value = line.slice(1);
    if (field === 'p') {
      pid = Number.parseInt(value, 10);
      command = '';
    } else if (field === 'c') {
      command = value;
    } else if (field === 'n' && pid !== null && Number.isFinite(pid)) {
      processes.push({ pid, command, cwd: value });
    }
  }
  return processes;
}

/** True when `cwd` is the root itself or anywhere beneath it. */
export function isInside(cwd: string, root: string): boolean {
  return cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`);
}

type Exec = (
  file: string,
  args: string[],
  options: { maxBuffer: number; timeout: number }
) => Promise<{ stdout: string }>;

export async function worktreeInUse(
  worktreePath: string,
  deps: { exec?: Exec; resolve?: (path: string) => Promise<string> } = {}
): Promise<WorktreeUse> {
  const exec = deps.exec ?? (execFileAsync as unknown as Exec);
  const resolve = deps.resolve ?? realpath;

  let root: string;
  try {
    root = await resolve(worktreePath);
  } catch (error) {
    // A worktree that is not on disk has nothing running from it.
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { state: 'idle' };
    return { state: 'unknown', error: error instanceof Error ? error.message : String(error) };
  }

  let stdout: string;
  try {
    ({ stdout } = await exec('lsof', ['-n', '-P', '-w', '-d', 'cwd', '-F', 'pcn'], {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15_000,
    }));
  } catch (error) {
    // lsof exits non-zero when it could not read some processes, and still
    // prints every process it could. The ones it cannot read belong to other
    // OS users, and every turn, dev server and shell that uses a studio runs
    // as this one, so that listing is the one that matters. No listing at
    // all (lsof missing, a timeout) is a check that did not run.
    // A run killed by the timeout printed only part of the list, so it
    // stays unknown even when it has output.
    const failed = error as { stdout?: unknown; killed?: boolean; signal?: unknown };
    const partial = failed?.stdout;
    if (failed?.killed || failed?.signal || typeof partial !== 'string' || partial.length === 0) {
      return { state: 'unknown', error: error instanceof Error ? error.message : String(error) };
    }
    stdout = partial;
  }

  const processes = parseLsofCwd(stdout).filter((p) => isInside(p.cwd, root));
  return processes.length > 0 ? { state: 'in-use', processes } : { state: 'idle' };
}
