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
