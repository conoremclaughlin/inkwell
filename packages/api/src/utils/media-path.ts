/**
 * Media path resolution and verified opening for the evidence viewer's
 * file endpoint.
 *
 * Evidence items reference files by the paths agents actually use — a
 * shared-media path (~/.ink/files/...), an absolute path, or a
 * repo-relative screenshot path (docs/screenshots/pr-N/...). The endpoint
 * serves ONLY files that resolve inside an allowlisted root and whose
 * CANONICAL target is a recognized media type; everything else is a 404
 * with no explanation (the response must not confirm what exists outside
 * the roots).
 *
 * Serving consumes the one descriptor `openVerifiedMedia` validated —
 * never a path re-open. Validate-then-reopen (realpath/stat + sendFile)
 * left three holes (Lumen, PR #551 r1): a swap between validation and
 * open served unvalidated content; a hard link inside a root to outside
 * content passed containment while sharing the outside inode; and
 * `preview.png -> payload.html` passed the requested extension, then the
 * reopened canonical target was served as HTML into the dashboard origin.
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

export interface VerifiedMedia {
  /** The one validated descriptor — stream THIS, never re-open the path. */
  handle: FileHandle;
  mediaType: MediaType;
  contentType: string;
  size: number;
}

/** Test-only seam: runs between path resolution and the open, where the
 *  ancestor-swap race lives. Production callers never pass it. */
export interface OpenVerifiedMediaTestHooks {
  beforeOpen?: () => void | Promise<void>;
}

/**
 * Post-open containment proof, bound to the OPENED object rather than any
 * pre-open pathname (Lumen, PR #551 r2: between realpath and open, an
 * ancestor directory can be renamed and replaced with a symlink to an
 * outside directory — the opened handle then reads outside content while
 * every pre-open check and fstat still passes).
 *
 * Strictly AFTER the open, walk the canonical path from the trusted root
 * with lstat: every ancestor must be a real directory (never a symlink),
 * and the final entry must be a non-symlink regular file whose (dev, ino)
 * is exactly the held descriptor's, with nlink === 1 at both fstat and
 * walk time. Why this binds to the object: nlink === 1 means the object
 * has exactly one name anywhere, and a symlink-free chain from the root
 * proves that one name lives beneath the root — so the object we already
 * hold IS root content. An attacker can only satisfy this by physically
 * moving their file's sole link inside the root, at which point it is
 * root content by definition and serving it discloses nothing beyond
 * what root-write access already grants.
 *
 * Under non-attack conditions the walk is trivially clean: realpath
 * output contains no symlinks at resolution time.
 */
async function openedObjectIsBeneathRoot(
  handleDev: number,
  handleIno: number,
  canonicalPath: string,
  containingRoot: string
): Promise<boolean> {
  try {
    const rootInfo = await fsPromises.lstat(containingRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return false;

    const relativePath = canonicalPath.slice(containingRoot.length + sep.length);
    const segments = relativePath.split(sep);
    let walkPath = containingRoot;
    for (let index = 0; index < segments.length - 1; index += 1) {
      walkPath = `${walkPath}${sep}${segments[index]}`;
      const ancestorInfo = await fsPromises.lstat(walkPath);
      if (ancestorInfo.isSymbolicLink() || !ancestorInfo.isDirectory()) return false;
    }

    const finalInfo = await fsPromises.lstat(`${walkPath}${sep}${segments[segments.length - 1]}`);
    return (
      !finalInfo.isSymbolicLink() &&
      finalInfo.isFile() &&
      finalInfo.nlink === 1 &&
      finalInfo.dev === handleDev &&
      finalInfo.ino === handleIno
    );
  } catch {
    return false;
  }
}

/**
 * Resolve, canonicalize, and open a media file as one verified descriptor.
 * Returns null (serve nothing, reveal nothing) unless every check passes:
 *
 * 1. Lexical containment of the requested path (resolveAllowedMediaPath).
 * 2. Realpath containment inside a realpathed root — roots resolved
 *    independently, so one missing root never disables the others.
 * 3. Media type and Content-Type from the CANONICAL target's extension —
 *    a `preview.png -> payload.html` symlink is refused here, and can
 *    never be served as HTML.
 * 4. Open with O_NOFOLLOW (a final-component symlink swapped in after
 *    realpath is refused) and O_NONBLOCK (a FIFO cannot hang the open).
 * 5. fstat on the DESCRIPTOR: regular file only, and nlink === 1 — a hard
 *    link inside a root shares its inode with outside content while
 *    passing every path-based check, so multi-link files are refused
 *    outright.
 *
 * The caller streams from the returned handle and closes it. Everything
 * validated and everything served is the same open file description.
 */
export async function openVerifiedMedia(
  requestedPath: string,
  allowedRoots: string[],
  homeDirectory: string,
  repoRoot: string,
  testHooks?: OpenVerifiedMediaTestHooks
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
  const containingRoot = realRoots.find(
    (root) => canonicalPath === root || canonicalPath.startsWith(root + sep)
  );
  if (!containingRoot || canonicalPath === containingRoot) return null;

  const mediaType = mediaTypeForPath(canonicalPath);
  const contentType = contentTypeForCanonicalPath(canonicalPath);
  if (!mediaType || !contentType) return null;

  if (testHooks?.beforeOpen) await testHooks.beforeOpen();

  let handle: FileHandle;
  try {
    handle = await fsPromises.open(
      canonicalPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
    );
  } catch {
    return null;
  }

  try {
    const fileInfo = await handle.stat();
    if (!fileInfo.isFile() || fileInfo.nlink !== 1) {
      await handle.close();
      return null;
    }
    // Containment bound to the opened object: prove the held descriptor's
    // (dev, ino) is reachable from the trusted root through a symlink-free
    // chain AFTER the open. An ancestor swapped for a symlink between
    // realpath and open fails this walk, whatever the fd's own stats say.
    const beneathRoot = await openedObjectIsBeneathRoot(
      fileInfo.dev,
      fileInfo.ino,
      canonicalPath,
      containingRoot
    );
    if (!beneathRoot) {
      await handle.close();
      return null;
    }
    return { handle, mediaType, contentType, size: fileInfo.size };
  } catch {
    await handle.close();
    return null;
  }
}
