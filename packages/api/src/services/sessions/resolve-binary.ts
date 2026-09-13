/**
 * Binary Path Resolution
 *
 * Resolves CLI binary paths (claude, codex, gemini, agy) with fallback to zsh login shell.
 * Node's spawn() only searches the current process PATH, which may be a
 * stripped-down bash PATH missing user-installed tools (nvm, homebrew, etc.).
 *
 * Resolution order:
 *   1. Check current process PATH via `which`
 *   2. Fall back to `zsh -ilc 'which <binary>'` to pick up login shell paths
 *   3. Verify the resolved path actually exists before caching
 *
 * Cache policy:
 *   - Successful resolutions are cached for the process lifetime
 *   - Failed resolutions are cached for FAILURE_CACHE_TTL_MS then retried
 *     (handles cases where a binary is installed after server startup)
 */

import { execFile } from 'child_process';
import { access } from 'fs/promises';
import { delimiter, dirname, isAbsolute, join, parse } from 'path';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';

const execFileAsync = promisify(execFile);

interface CacheEntry {
  path: string | null;
  timestamp: number;
}

const resolvedPaths = new Map<string, CacheEntry>();

/** How long to cache a failed resolution before retrying (5 minutes). */
const FAILURE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Binaries this repository ships itself.
 *
 * For a third-party CLI (`claude`, `codex`, `gemini`) the ambient PATH is the
 * right answer — there is one install and the user owns it. For a binary we
 * BUILD, it is the wrong answer twice over: it depends on whatever PATH the
 * server happened to inherit, and the result is cached process-wide, so one
 * bad answer is reused by every subsequent spawn.
 *
 * How long it is reused for is NOT "until restart" — an earlier version of this
 * comment said so, and it was wrong. The cache revalidates (see
 * `resolveBinaryPath`), so an entry survives only while its path still exists.
 * That is weaker than it sounds, because a stale build is a real file that
 * passes the check — it is wrong, not missing. The reuse window is bounded by
 * nothing we control, which is the reason not to depend on PATH here at all.
 *
 * WHAT THIS DOES NOT FIX, because two earlier versions of this comment claimed
 * otherwise and the claim is load-bearing for anyone reading it later. Myra's
 * heartbeats died on 2026-09-11 with `unknown option '--require-bootstrap'`,
 * spawned against an `ink` dated 2026-04-09 in personal-context-protocol--wren.
 * That was NOT `which` reaching into a sibling worktree. There were two API
 * servers on the same database, and the second one was RUNNING FROM that
 * worktree — so it spawned from its own directory, correctly, and its own
 * directory held a five-month-old build. Resolving against the server's own
 * checkout, which is what this file now does, would have picked exactly the
 * same stale binary: `workspaceBinCandidates` walks up from `__dirname`, and
 * for that server `__dirname` was inside the worktree too. The fix for the
 * outage is stopping a worktree server from claiming reminders at all (#609).
 *
 * This change stands on its own terms regardless: a binary we build should not
 * resolve through ambient PATH, where the answer depends on whatever shell
 * environment the server inherited. Eleven worktrees on that machine each carry
 * a node_modules/.bin/ink and eight were stale — any of them reachable by a
 * PATH lookup, on some future day with a different cause. The server's own
 * checkout is the defensible answer because it is the build that ships with the
 * code doing the spawning, so their flags agree by construction.
 */
const FIRST_PARTY_BINARIES = new Set(['ink']);

/**
 * Every `<ancestor>/node_modules/.bin/<binary>` from this module outward.
 *
 * Walking up from __dirname rather than process.cwd() is the point — cwd is
 * ambient state and can be any studio, while __dirname is where the running
 * server's code actually lives. Nearest ancestor wins.
 */
function workspaceBinCandidates(binary: string): string[] {
  const candidates: string[] = [];
  const { root } = parse(__dirname);
  let dir = __dirname;
  while (true) {
    candidates.push(join(dir, 'node_modules', '.bin', binary));
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates;
}

/**
 * Verify that a resolved path actually exists on disk.
 * Guards against stale symlinks, nvm version switches, etc.
 */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a binary name to its full path, with zsh login shell fallback.
 * Returns the binary name unchanged if resolution fails (spawn will produce
 * a clear ENOENT error).
 */
export async function resolveBinaryPath(binary: string): Promise<string> {
  const cached = resolvedPaths.get(binary);
  if (cached) {
    if (cached.path) {
      // Successful resolution — verify it still exists (nvm version switch, etc.)
      if (await pathExists(cached.path)) {
        return cached.path;
      }
      // Stale cache — path no longer exists, re-resolve
      logger.warn(`Cached path for ${binary} no longer exists: ${cached.path}. Re-resolving.`);
      resolvedPaths.delete(binary);
    } else {
      // Failed resolution — check if TTL has expired
      if (Date.now() - cached.timestamp < FAILURE_CACHE_TTL_MS) {
        return binary;
      }
      // TTL expired — retry resolution
      logger.info(`Retrying resolution for ${binary} (failure cache expired)`);
      resolvedPaths.delete(binary);
    }
  }

  // 0. First-party binaries resolve against the server's own checkout, never
  //    the ambient PATH. Deterministic, and immune to sibling worktrees.
  if (FIRST_PARTY_BINARIES.has(binary)) {
    for (const candidate of workspaceBinCandidates(binary)) {
      if (await pathExists(candidate)) {
        resolvedPaths.set(binary, { path: candidate, timestamp: Date.now() });
        logger.info(`Resolved ${binary} from the server's own workspace: ${candidate}`);
        return candidate;
      }
    }
    // Falling through to PATH means this checkout has no build of its own
    // binary. That is recoverable but it is also how a stale sibling gets
    // picked, so say so rather than resolving quietly.
    logger.warn(
      `${binary} is first-party but absent from this server's workspace — ` +
        `falling back to PATH, which may resolve a stale build from another worktree.`
    );
  }

  // 1. Try current process PATH
  try {
    const { stdout } = await execFileAsync('which', [binary], { timeout: 3000 });
    const resolved = stdout.trim();
    if (resolved && (await pathExists(resolved))) {
      resolvedPaths.set(binary, { path: resolved, timestamp: Date.now() });
      logger.info(`Resolved ${binary} from PATH: ${resolved}`);
      return resolved;
    }
  } catch {
    // Not found in current PATH
  }

  // 2. Fall back to zsh login shell (picks up nvm, homebrew, etc.)
  try {
    const { stdout } = await execFileAsync('zsh', ['-ilc', `which ${binary}`], { timeout: 5000 });
    // zsh -il may print extra lines (nvm "Now using..." etc.) — take the last absolute path
    const lines = stdout.split('\n').filter((l) => l.trim() && l.startsWith('/'));
    const resolved = lines[lines.length - 1];
    if (resolved && (await pathExists(resolved))) {
      resolvedPaths.set(binary, { path: resolved, timestamp: Date.now() });
      logger.info(`Resolved ${binary} via zsh login shell: ${resolved}`);
      return resolved;
    }
  } catch {
    // zsh fallback also failed
  }

  // 3. Not found anywhere — cache with TTL so we retry later
  resolvedPaths.set(binary, { path: null, timestamp: Date.now() });
  logger.error(
    `Could not resolve ${binary} in PATH or zsh login shell. ` +
      `Will retry in ${FAILURE_CACHE_TTL_MS / 1000}s. ` +
      `Server PATH: ${(process.env.PATH || '').split(delimiter).slice(0, 5).join(delimiter)}...`
  );
  return binary;
}

/**
 * Build a PATH string for child process env that includes the resolved
 * binary's directory. This ensures shebang scripts (`#!/usr/bin/env node`)
 * can find the interpreter even when the server's own PATH doesn't include it.
 */
export function buildSpawnPath(resolvedBinaryPath: string): string {
  const currentPath = process.env.PATH || '';

  // If resolution failed and we got a bare name (e.g. "codex"), dirname
  // returns "." which would inject CWD into the child PATH — skip it.
  if (!isAbsolute(resolvedBinaryPath)) {
    return currentPath;
  }

  const binDir = dirname(resolvedBinaryPath);
  const parts = currentPath.split(delimiter).filter(Boolean);

  if (parts.includes(binDir)) {
    return currentPath;
  }

  return parts.length ? `${binDir}${delimiter}${currentPath}` : binDir;
}
