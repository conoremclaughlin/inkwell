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
 *
 * A best-effort backstop, not mutual exclusion: a process can start between
 * the check and the removal. Closing that window needs every spawn and lease
 * path to honour the teardown claim (task 7ec05d10).
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

/**
 * Characters lsof does not print as themselves in a name: control
 * characters (a newline becomes `\\n`, others `\\xNN` or `^X`) and the
 * backslash it escapes with. A worktree path holding one would never equal
 * its own listing, so no process inside it could be seen (Lumen, #766: a
 * live child under a directory with a newline in its name read as idle).
 * Paths beneath a clean root still match, because their escaped form keeps
 * the root's own characters as its prefix.
 */
const ESCAPED_BY_LSOF = /[\u0000-\u001f\u007f\\]/;

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
  deps: {
    exec?: Exec;
    resolve?: (path: string) => Promise<string>;
    /** This process, which always has a cwd and so must be in a complete listing. */
    selfPid?: number;
  } = {}
): Promise<WorktreeUse> {
  const exec = deps.exec ?? (execFileAsync as unknown as Exec);
  const resolve = deps.resolve ?? realpath;
  const selfPid = deps.selfPid ?? process.pid;

  let root: string;
  try {
    root = await resolve(worktreePath);
  } catch (error) {
    // A worktree that is not on disk has nothing running from it.
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { state: 'idle' };
    return { state: 'unknown', error: error instanceof Error ? error.message : String(error) };
  }
  if (ESCAPED_BY_LSOF.test(root)) {
    return { state: 'unknown', error: 'worktree path has characters lsof prints escaped' };
  }

  let stdout: string;
  try {
    ({ stdout } = await exec('lsof', ['-n', '-P', '-w', '-d', 'cwd', '-F', 'pcn'], {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15_000,
    }));
  } catch (error) {
    // Any failure is a check that did not prove the worktree idle: a
    // missing lsof, a timeout, or a non-zero exit. lsof also exits non-zero
    // when it could not read some processes, and the listing it still prints
    // cannot be shown complete for this user's own processes (a permission
    // or a process racing the read can drop one). Deferring a cleanup costs
    // nothing; deleting a live checkout cost a night's canonical tree
    // (Lumen, #766).
    return { state: 'unknown', error: error instanceof Error ? error.message : String(error) };
  }

  const listed = parseLsofCwd(stdout);
  // A listing that succeeded can still be empty or cut short. This process
  // always has a cwd, so a listing that lacks it is not the whole picture,
  // and "nothing found in it" proves nothing (Lumen, #766).
  if (!listed.some((p) => p.pid === selfPid)) {
    return { state: 'unknown', error: 'lsof listing does not include this process' };
  }
  const processes = listed.filter((p) => isInside(p.cwd, root));
  return processes.length > 0 ? { state: 'in-use', processes } : { state: 'idle' };
}
