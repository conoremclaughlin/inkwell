/**
 * Where uploaded files live (upload design r2 §1, r4 §1).
 *
 * The root is private application data, and where it may be is narrow on
 * purpose. It must lie inside the Inkwell data directory (`~/.ink`), never be
 * that directory, and be clear, by realpath and in both directions, of the
 * directories the server lists (placement.ts): what `/api/admin/media`
 * serves, ClaudeRunner's standing grants, the inklings' own folders, and the
 * server's checkout, where a turn runs when it has no studio. A root inside
 * or around one of those would put a person's photos where a path that never
 * asks who is reading could reach them. Otherwise uploads stay off.
 *
 * That is a placement check at startup, not runner isolation. A runner whose
 * working directory holds the root is not caught here when that directory is
 * a studio's (a studio can be registered at any path, `~` included). And
 * every runner runs as the same OS user, so what a backend reads beyond the
 * directories it is granted is up to the backend (files.ts, r2 §9).
 *
 * Layout: `<root>/<userId>/<workspaceId>/<uploadId>/<uploadId>.<ext>`. Every
 * segment is a server-minted id and the extension comes from the sniffed
 * type; nothing the client sent is ever part of a path. Each upload has a
 * directory of its own so a runner can be granted exactly one file's
 * directory for one spawn. Bytes are written under `<root>/.staging` first
 * and renamed into place.
 */

import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { lstat, mkdir, realpath } from 'fs/promises';
import type { SniffedType } from './sniff.js';

export const STAGING_DIR = '.staging';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A lowercase, hyphenated UUID: the only shape a path segment may take. */
export function isCanonicalId(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UUID.test(value);
}

export interface UploadLocation {
  userId: string;
  workspaceId: string;
  uploadId: string;
  ext: SniffedType['ext'];
}

const EXTENSIONS: ReadonlySet<string> = new Set(['jpg', 'png', 'pdf', 'txt']);

/**
 * The segments under the root, or null when any part is not a canonical id or
 * a known extension. Callers treat null as "no such upload", so a malformed
 * row can never name a path.
 */
export function uploadSegments(loc: UploadLocation): [string, string, string, string] | null {
  if (!isCanonicalId(loc.userId) || !isCanonicalId(loc.workspaceId)) return null;
  if (!isCanonicalId(loc.uploadId) || !EXTENSIONS.has(loc.ext)) return null;
  return [loc.userId, loc.workspaceId, loc.uploadId, `${loc.uploadId}.${loc.ext}`];
}

/** The directory a runner is granted for this upload. */
export function uploadDirPath(rootReal: string, loc: UploadLocation): string | null {
  const segments = uploadSegments(loc);
  return segments ? join(rootReal, ...segments.slice(0, 3)) : null;
}

export function uploadFilePath(rootReal: string, loc: UploadLocation): string | null {
  const segments = uploadSegments(loc);
  return segments ? join(rootReal, ...segments) : null;
}

export function stagingFilePath(rootReal: string, uploadId: string): string | null {
  return isCanonicalId(uploadId) ? join(rootReal, STAGING_DIR, `${uploadId}.part`) : null;
}

/** The Inkwell data directory, which the uploads root must lie inside. */
export function inkDataDir(): string {
  return join(homedir(), '.ink');
}

export function defaultUploadsRoot(): string {
  return join(inkDataDir(), 'uploads');
}

/** True when `child` is `parent` or lies beneath it. Both must be canonical. */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function pathsOverlap(a: string, b: string): boolean {
  return isWithin(a, b) || isWithin(b, a);
}

/**
 * The canonical form of a path that may not exist yet: the realpath of its
 * nearest existing ancestor with the rest appended. A neighbour that does not
 * exist today is still compared where it would be created, so `/var/x` and
 * `/private/var/x` on macOS are the same place.
 */
export async function canonicalPath(target: string): Promise<string> {
  const rest: string[] = [];
  let current = resolve(target);
  for (;;) {
    try {
      return join(await realpath(current), ...rest.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      rest.push(basename(current));
      current = parent;
    }
  }
}

export type UploadsRootRefusal =
  | 'not-absolute'
  | 'outside-data-dir'
  | 'unavailable'
  | 'not-private'
  | 'overlaps'
  | 'staging-not-canonical';

export type UploadsRoot =
  | { ok: true; rootReal: string; stagingReal: string }
  | { ok: false; reason: UploadsRootRefusal; detail: string };

/**
 * Create (0700) and check the uploads root at startup. Fails closed: any
 * refusal means the upload routes stay off.
 *
 * `dataDir` is the Inkwell data directory (inkDataDir()). The root must lie
 * strictly inside it, checked before anything is created, so a refused root
 * is never made, and again on the created directory's realpath.
 * `neighbours` are the directories the root must be clear of
 * (uploadsRootNeighbours()); nothing else is compared.
 */
export async function prepareUploadsRoot(
  configured: string,
  dataDir: string,
  neighbours: readonly string[]
): Promise<UploadsRoot> {
  if (!isAbsolute(configured)) {
    return { ok: false, reason: 'not-absolute', detail: configured };
  }
  let dataReal: string;
  let planned: string;
  try {
    dataReal = await canonicalPath(dataDir);
    planned = await canonicalPath(configured);
  } catch (error) {
    return { ok: false, reason: 'unavailable', detail: (error as Error).message };
  }
  const inside = (path: string): boolean => path !== dataReal && isWithin(dataReal, path);
  const outside = (path: string): UploadsRoot => ({
    ok: false,
    reason: 'outside-data-dir',
    detail: `${path} must be inside ${dataReal}`,
  });
  if (!inside(planned)) return outside(planned);

  let rootReal: string;
  try {
    await mkdir(configured, { recursive: true, mode: 0o700 });
    rootReal = await realpath(configured);
  } catch (error) {
    return { ok: false, reason: 'unavailable', detail: (error as Error).message };
  }
  // Only a link swapped in since the check above could move it.
  if (!inside(rootReal)) return outside(rootReal);

  const st = await lstat(rootReal);
  const uid = typeof process.getuid === 'function' ? process.getuid() : st.uid;
  if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) {
    return {
      ok: false,
      reason: 'not-private',
      detail: `${rootReal} must be a directory owned by this user with no group or other access`,
    };
  }

  for (const neighbour of neighbours) {
    let other: string;
    try {
      other = await canonicalPath(neighbour);
    } catch (error) {
      // A neighbour that cannot be resolved cannot be shown clear of the root.
      return { ok: false, reason: 'unavailable', detail: (error as Error).message };
    }
    if (pathsOverlap(rootReal, other)) {
      return { ok: false, reason: 'overlaps', detail: `${rootReal} overlaps ${other}` };
    }
  }

  const staging = join(rootReal, STAGING_DIR);
  try {
    await mkdir(staging, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    // rootReal is canonical, so only the last component can be a link, and
    // lstat reports a link as not a directory.
    if (!(await lstat(staging)).isDirectory()) {
      return { ok: false, reason: 'staging-not-canonical', detail: staging };
    }
    return { ok: true, rootReal, stagingReal: staging };
  } catch (error) {
    return { ok: false, reason: 'unavailable', detail: (error as Error).message };
  }
}
