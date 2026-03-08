/**
 * Binary Path Resolution
 *
 * Resolves CLI binary paths (claude, codex, gemini) with fallback to zsh login shell.
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
import { delimiter, dirname, isAbsolute } from 'path';
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
