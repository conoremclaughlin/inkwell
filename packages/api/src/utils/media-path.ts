/**
 * Media resolution for the evidence viewer's file endpoint.
 *
 * ## Scope (read before adding checks here)
 *
 * The endpoint is behind admin auth, so the caller is the account owner.
 * The value worth validating is the PATH, because SBs write it into
 * evidence JSONB autonomously and it is then fetched by the owner's
 * dashboard. A mistaken or careless reference should not resolve to
 * something outside the media directories, and should not be handed back
 * with a content type that doesn't match what the file actually is.
 *
 * Isolating co-located processes from each other is explicitly NOT in
 * scope (Conor, 2026-08-31). Anything able to rearrange these directories
 * already has the same read access this endpoint would grant, so guarding
 * that boundary adds complexity without changing what is reachable. An
 * earlier revision carried extra post-open verification and a link-count
 * rule for exactly that case; it was removed in dd3a6394, and the
 * link-count rule was also rejecting ordinary hard-linked files.
 *
 * The durable simplification is upstream of this file: media should be
 * referenced by a NAME inside a space the producing agent owns
 * (~/.ink/files/<agentId>/…) rather than by filesystem path, turning this
 * into a namespace lookup. Tracked separately; until evidence is authored
 * that way, this module accepts the paths agents already write.
 *
 * What remains, and why each part earns its place:
 *
 * - Root containment (lexical, then canonical): a reference must resolve
 *   inside one of the media directories.
 * - Canonical-target extension allowlist fixing an exact Content-Type,
 *   served with `nosniff`: a name ending `.png` whose real target is an
 *   HTML document must not come back labelled as HTML. This is correct
 *   content handling and would matter even with no bad input at all.
 * - Regular-file check, with a non-blocking open so the check is
 *   reachable: the endpoint must not hang on a non-file.
 */

import { promises as fsPromises, constants as fsConstants } from 'fs';
import type { FileHandle } from 'fs/promises';
import { resolve, sep } from 'path';
import { mediaTypeForPath, type MediaType } from '../services/thread-key/graph-evidence';

/** Exact Content-Type by canonical extension — the serve header source. */
const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  pdf: 'application/pdf',
};

function contentTypeForCanonicalPath(canonicalPath: string): string | null {
  const extensionMatch = /\.([a-z0-9]+)$/i.exec(canonicalPath);
  if (!extensionMatch) return null;
  return CONTENT_TYPES[extensionMatch[1].toLowerCase()] ?? null;
}

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
 * the repo root — in practice the committed-screenshot convention — never
 * against the process cwd at large.
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

export interface VerifiedMedia {
  /** Open handle for the response to stream; the caller closes it. */
  handle: FileHandle;
  mediaType: MediaType;
  contentType: string;
  size: number;
}

/**
 * Resolve a requested evidence path and open it for streaming, or return
 * null (serve nothing, reveal nothing) when any requirement fails:
 *
 * 1. The requested path resolves inside an allowed root.
 * 2. Its canonical target — symlinks followed — is still inside a root.
 *    Roots resolve independently, so one missing root never disables the
 *    others.
 * 3. The CANONICAL target's extension names a known media type, which also
 *    fixes the Content-Type. A name that says `.png` but resolves to HTML
 *    is refused here rather than served as HTML.
 * 4. The opened file is a regular file. The open is non-blocking so this
 *    check is reachable for things like FIFOs rather than hanging first.
 */
export async function openVerifiedMedia(
  requestedPath: string,
  allowedRoots: string[],
  homeDirectory: string,
  repoRoot: string
): Promise<VerifiedMedia | null> {
  const lexical = resolveAllowedMediaPath(requestedPath, allowedRoots, homeDirectory, repoRoot);
  if (!lexical) return null;

  const rootResolutions = await Promise.allSettled(
    allowedRoots.map((root) => fsPromises.realpath(resolve(root)))
  );
  const realRoots = rootResolutions
    .filter((settled): settled is PromiseFulfilledResult<string> => settled.status === 'fulfilled')
    .map((settled) => settled.value);
  if (realRoots.length === 0) return null;

  let canonicalPath: string;
  try {
    canonicalPath = await fsPromises.realpath(lexical.absolutePath);
  } catch {
    return null;
  }
  if (!isWithinRoots(canonicalPath, realRoots)) return null;

  const mediaType = mediaTypeForPath(canonicalPath);
  const contentType = contentTypeForCanonicalPath(canonicalPath);
  if (!mediaType || !contentType) return null;

  let handle: FileHandle;
  try {
    handle = await fsPromises.open(canonicalPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch {
    return null;
  }

  try {
    const fileInfo = await handle.stat();
    if (!fileInfo.isFile()) {
      await handle.close();
      return null;
    }
    return { handle, mediaType, contentType, size: fileInfo.size };
  } catch {
    await handle.close();
    return null;
  }
}
