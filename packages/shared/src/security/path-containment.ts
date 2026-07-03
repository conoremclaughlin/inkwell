/**
 * Path Containment Validation
 *
 * Prevents file-based tools from accessing paths outside a designated
 * workspace root. Handles symlink resolution, non-existent path traversal,
 * and absolute path escapes.
 *
 * Used by both CLI (pi-tools.ts) and server (pi-coding-tools.ts) adapters.
 */

import { resolve, relative, dirname, basename, join } from 'path';
import { realpathSync, existsSync } from 'fs';
import { realpath, access } from 'fs/promises';

export class PathContainmentError extends Error {
  constructor(
    public readonly tool: string,
    public readonly requestedPath: string,
    public readonly resolvedPath: string,
    public readonly cwd: string
  ) {
    super(
      `Path containment violation: ${tool} attempted to access "${requestedPath}" ` +
        `(resolved to "${resolvedPath}") which is outside workspace "${cwd}"`
    );
    this.name = 'PathContainmentError';
  }
}

/**
 * For paths that don't exist yet, walk up to the deepest existing ancestor
 * and resolve its real path, then reattach the remaining segments.
 * This catches symlink escapes even when the final target doesn't exist.
 */
function resolveDeepestAncestor(targetPath: string): string {
  const parts: string[] = [];
  let current = targetPath;
  while (!existsSync(current) && current !== dirname(current)) {
    parts.unshift(basename(current));
    current = dirname(current);
  }
  try {
    const realAncestor = realpathSync(current);
    return join(realAncestor, ...parts);
  } catch {
    return targetPath;
  }
}

/**
 * Assert that a path resolves to within the workspace root.
 * Throws PathContainmentError if the path escapes.
 *
 * Handles: absolute paths, ../traversal, symlink escapes, non-existent targets.
 */
export function assertContainedPath(rawPath: string, cwd: string, tool: string): void {
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    realCwd = cwd;
  }

  const resolved = resolve(realCwd, rawPath);

  let realResolved: string;
  try {
    realResolved = realpathSync(resolved);
  } catch {
    realResolved = resolveDeepestAncestor(resolved);
  }

  const rel = relative(realCwd, realResolved);
  if (rel.startsWith('..') || resolve(realCwd, rel) !== realResolved) {
    throw new PathContainmentError(tool, rawPath, realResolved, realCwd);
  }
}

/**
 * Check whether a path is within the workspace (boolean version).
 * For use where throwing is inconvenient — returns false on escape.
 */
export function isPathWithinWorkspace(filePath: string, cwd: string): boolean {
  try {
    assertContainedPath(filePath, cwd, 'check');
    return true;
  } catch {
    return false;
  }
}

const PATH_TOOLS = new Set(['read', 'edit', 'write', 'ls', 'grep', 'find']);

/**
 * Validate all path-bearing arguments for a tool call.
 * Checks `path`, `file_path`, and `filePath` argument names.
 */
export function validatePathArgs(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string
): void {
  if (!PATH_TOOLS.has(toolName)) return;

  const pathArg = args.path ?? args.file_path ?? args.filePath;
  if (typeof pathArg === 'string' && pathArg) {
    assertContainedPath(pathArg, cwd, toolName);
  }
}

/* ---------- Async variants (server-side — never block the event loop) ---------- */

/**
 * Async version of resolveDeepestAncestor.
 * Walks up to the deepest existing ancestor using non-blocking fs calls,
 * resolves its real path, then reattaches the remaining segments.
 */
async function resolveDeepestAncestorAsync(targetPath: string): Promise<string> {
  const parts: string[] = [];
  let current = targetPath;

  // Walk up until we find an ancestor that exists
  while (current !== dirname(current)) {
    try {
      await access(current);
      break; // current exists
    } catch {
      parts.unshift(basename(current));
      current = dirname(current);
    }
  }

  try {
    const realAncestor = await realpath(current);
    return join(realAncestor, ...parts);
  } catch {
    return targetPath;
  }
}

/**
 * Async version of assertContainedPath.
 * Same containment logic but uses non-blocking fs calls.
 * Throws PathContainmentError if the path escapes the workspace root.
 */
export async function assertContainedPathAsync(
  rawPath: string,
  cwd: string,
  tool: string
): Promise<void> {
  let realCwd: string;
  try {
    realCwd = await realpath(cwd);
  } catch {
    realCwd = cwd;
  }

  const resolved = resolve(realCwd, rawPath);

  let realResolved: string;
  try {
    realResolved = await realpath(resolved);
  } catch {
    realResolved = await resolveDeepestAncestorAsync(resolved);
  }

  const rel = relative(realCwd, realResolved);
  if (rel.startsWith('..') || resolve(realCwd, rel) !== realResolved) {
    throw new PathContainmentError(tool, rawPath, realResolved, realCwd);
  }
}

/**
 * Async version of isPathWithinWorkspace.
 * Returns false if the path escapes the workspace.
 */
export async function isPathWithinWorkspaceAsync(filePath: string, cwd: string): Promise<boolean> {
  try {
    await assertContainedPathAsync(filePath, cwd, 'check');
    return true;
  } catch {
    return false;
  }
}

/**
 * Async version of validatePathArgs.
 * Validates all path-bearing arguments for a tool call without blocking.
 */
export async function validatePathArgsAsync(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string
): Promise<void> {
  if (!PATH_TOOLS.has(toolName)) return;

  const pathArg = args.path ?? args.file_path ?? args.filePath;
  if (typeof pathArg === 'string' && pathArg) {
    await assertContainedPathAsync(pathArg, cwd, toolName);
  }
}
