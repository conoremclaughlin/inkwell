/**
 * Media path resolution for the evidence viewer's file endpoint.
 *
 * Evidence items reference files by the paths agents actually use — a
 * shared-media path (~/.ink/files/...), an absolute path, or a
 * repo-relative screenshot path (docs/screenshots/pr-N/...). The endpoint
 * serves ONLY files that resolve inside an allowlisted root and carry a
 * recognized media extension; everything else is a 404 with no explanation
 * (the response must not confirm what exists outside the roots).
 *
 * Callers must ALSO realpath the resolved path and re-check containment
 * with isWithinRoots against realpathed roots — resolution here is lexical
 * and cannot see symlink escapes.
 */

import { resolve, sep } from 'path';
import { mediaTypeForPath, type MediaType } from '../services/thread-key/graph-evidence';

/** Expand a leading `~/` against the given home directory. */
export function expandHomePath(requestedPath: string, homeDirectory: string): string {
  if (requestedPath === '~') return homeDirectory;
  if (requestedPath.startsWith('~/')) {
    return resolve(homeDirectory, requestedPath.slice(2));
  }
  return requestedPath;
}

/** True when absolutePath is one of the roots or strictly inside one. */
export function isWithinRoots(absolutePath: string, allowedRoots: string[]): boolean {
  return allowedRoots.some((root) => absolutePath === root || absolutePath.startsWith(root + sep));
}

export interface ResolvedMediaPath {
  absolutePath: string;
  mediaType: MediaType;
}

/**
 * Lexically resolve a requested evidence path against the allowlist.
 * Returns null (serve nothing) unless the path lands inside an allowed
 * root AND names a recognized media type. Relative paths resolve against
 * the FIRST root that contains the result — in practice the repo-relative
 * screenshot convention — never against the process cwd at large.
 */
export function resolveAllowedMediaPath(
  requestedPath: string,
  allowedRoots: string[],
  homeDirectory: string,
  repoRoot: string
): ResolvedMediaPath | null {
  if (!requestedPath || requestedPath.includes('\0')) return null;

  const expanded = expandHomePath(requestedPath, homeDirectory);
  const absolutePath = expanded.startsWith('/') ? resolve(expanded) : resolve(repoRoot, expanded);

  if (
    !isWithinRoots(
      absolutePath,
      allowedRoots.map((root) => resolve(root))
    )
  ) {
    return null;
  }

  const mediaType = mediaTypeForPath(absolutePath);
  if (!mediaType) return null;

  return { absolutePath, mediaType };
}
