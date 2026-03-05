/**
 * Binary Path Resolution
 *
 * Resolves CLI binary paths (claude, codex) with fallback to zsh login shell.
 * Node's spawn() only searches the current process PATH, which may be a
 * stripped-down bash PATH missing user-installed tools (nvm, homebrew, etc.).
 *
 * Resolution order:
 *   1. Check current process PATH via `which`
 *   2. Fall back to `zsh -ilc 'which <binary>'` to pick up login shell paths
 *   3. Cache resolved paths for the process lifetime
 */

import { execFile } from 'child_process';
import { delimiter, dirname, isAbsolute } from 'path';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';

const execFileAsync = promisify(execFile);

const resolvedPaths = new Map<string, string | null>();

/**
 * Resolve a binary name to its full path, with zsh login shell fallback.
 * Returns the binary name unchanged if resolution fails (spawn will produce
 * a clear ENOENT error).
 */
export async function resolveBinaryPath(binary: string): Promise<string> {
  const cached = resolvedPaths.get(binary);
  if (cached !== undefined) {
    return cached ?? binary;
  }

  // 1. Try current process PATH
  try {
    const { stdout } = await execFileAsync('which', [binary], { timeout: 3000 });
    const path = stdout.trim();
    if (path) {
      resolvedPaths.set(binary, path);
      logger.debug(`Resolved ${binary} from PATH: ${path}`);
      return path;
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
    if (resolved) {
      resolvedPaths.set(binary, resolved);
      logger.info(`Resolved ${binary} via zsh login shell: ${resolved}`);
      return resolved;
    }
  } catch {
    // zsh fallback also failed
  }

  // 3. Not found anywhere — cache the miss and warn
  resolvedPaths.set(binary, null);
  logger.warn(
    `Could not resolve ${binary} in PATH or zsh login shell. Spawn will likely fail with ENOENT.`
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
