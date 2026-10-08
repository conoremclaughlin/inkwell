/**
 * The files an account owns outside the database, found once its work has
 * drained, validated, and removed (ink://specs/account-deletion v6 §4).
 *
 * v1 deletes consumer accounts, whose identities are all inklings. An
 * inkling's files sit at fixed places named by its identity id:
 *   - its folder, ~/.ink/inklings/<sbId>/, where every one of its turns runs,
 *     with ink's own session logs inside (.ink/runtime/repl/);
 *   - its tool policy, ~/.ink/inklings/.tool-policy/<sbId>.json;
 *   - Claude Code's transcripts of its turns: the one projects directory
 *     Claude names after that folder's path;
 *   - Codex's rollout files, one per thread id its sessions recorded.
 *
 * A target is removed only when it is what it should be: a real directory or
 * file, not a link, inside its root. Anything else is held, and the deletion
 * waits for an operator; nothing outside these paths is ever touched, and
 * nothing is removed recursively from a shared root.
 */

import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { inklingFolder, inklingToolPolicyPath } from '../inklings/inkling-folder';

export type TargetKind = 'inkling-folder' | 'tool-policy' | 'claude-projects' | 'codex-rollout';

export interface FileTarget {
  kind: TargetKind;
  path: string;
  /** The root it must sit inside. */
  root: string;
  /** A directory (removed with its contents) or a single file. */
  shape: 'directory' | 'file';
}

export interface InventoryRoots {
  inklings: string;
  claudeProjects: string;
  codexSessions: string;
}

export interface InventorySession {
  id: string;
  backend: string | null;
  backendSessionId: string | null;
}

/** Claude Code's name for a working directory's projects folder. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-');
}

export async function inventoryFor(
  roots: InventoryRoots,
  sbIds: string[],
  sessions: InventorySession[]
): Promise<FileTarget[]> {
  const targets: FileTarget[] = [];
  for (const sbId of sbIds) {
    const folder = inklingFolder(sbId, roots.inklings);
    targets.push({
      kind: 'inkling-folder',
      path: folder,
      root: roots.inklings,
      shape: 'directory',
    });
    targets.push({
      kind: 'tool-policy',
      path: inklingToolPolicyPath(sbId, roots.inklings),
      root: roots.inklings,
      shape: 'file',
    });
    targets.push({
      kind: 'claude-projects',
      path: join(roots.claudeProjects, claudeProjectDirName(folder)),
      root: roots.claudeProjects,
      shape: 'directory',
    });
  }
  const threadIds = new Set(
    sessions
      .filter((s) => s.backendSessionId && /^[0-9a-f-]{36}$/i.test(s.backendSessionId))
      .map((s) => s.backendSessionId!.toLowerCase())
  );
  if (threadIds.size > 0) {
    for (const path of await findCodexRollouts(roots.codexSessions, threadIds)) {
      targets.push({ kind: 'codex-rollout', path, root: roots.codexSessions, shape: 'file' });
    }
  }
  return targets;
}

/** Codex keeps rollouts as sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl. */
async function findCodexRollouts(root: string, threadIds: Set<string>): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (depth < 3) {
        if (entry.isDirectory()) await walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const match = /-([0-9a-f-]{36})\.jsonl$/i.exec(entry.name);
      if (match && threadIds.has(match[1].toLowerCase())) found.push(path);
    }
  };
  await walk(root, 0);
  return found.sort();
}

export type TargetOutcome =
  | { kind: TargetKind; path: string; result: 'removed' | 'absent' }
  | { kind: TargetKind; path: string; result: 'held'; reason: string };

/** Remove one target if it is exactly what it should be; hold it otherwise. */
export async function removeTarget(target: FileTarget): Promise<TargetOutcome> {
  const { kind, path } = target;
  const held = (reason: string): TargetOutcome => ({ kind, path, result: 'held', reason });
  if (!isAbsolute(path) || !isAbsolute(target.root)) return held('not an absolute path');
  const below = relative(target.root, path);
  if (below === '' || below.startsWith('..') || isAbsolute(below)) return held('outside its root');

  let st;
  try {
    st = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind, path, result: 'absent' };
    return held(`unreadable: ${(error as Error).message}`);
  }
  if (st.isSymbolicLink()) return held('a link');
  if (target.shape === 'directory' ? !st.isDirectory() : !st.isFile()) {
    return held(`not a ${target.shape}`);
  }
  // Its real location must still be inside its root: a link anywhere above
  // it would take the removal somewhere else.
  try {
    const [realRoot, realPath] = await Promise.all([realpath(target.root), realpath(path)]);
    if (relative(realRoot, realPath) !== below) return held('resolves through a link');
  } catch (error) {
    return held(`unresolvable: ${(error as Error).message}`);
  }

  try {
    await rm(path, { recursive: target.shape === 'directory', force: false });
  } catch (error) {
    return held(`removal failed: ${(error as Error).message}`);
  }
  try {
    await lstat(path);
    return held('still present after removal');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { kind, path, result: 'removed' };
    return held(`unverifiable: ${(error as Error).message}`);
  }
}

/** Whether every target is gone now (the complete step's check). */
export async function allAbsent(targets: FileTarget[]): Promise<boolean> {
  for (const target of targets) {
    try {
      await lstat(target.path);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
  }
  return true;
}
