/**
 * Writing, reading and removing an upload's bytes under the uploads root
 * (upload design r2 §3 and §5, r5).
 *
 * Reads go through readContainedFile, the one descriptor-pinned reader the
 * trigger media path already uses, with two checks of its own on top:
 * nothing on the way down from the root may be a symlink, and the bytes must
 * match the size and sha256 recorded when they were written. A mismatch is
 * reported as `damaged`, and the row is marked so it is never served or
 * attached again.
 *
 * What that proves, and what it does not. For a person's read the bytes
 * served are the bytes checked: one descriptor, read whole. A runner is
 * different: it is handed the file's path and opens it later, so a check at
 * resolve time says nothing about what it reads then. That is a conscious
 * limit of this local-host version, not a containment claim; the file and
 * directory modes (0400, 0500) do not stop the owning OS user, and any
 * process running as that user can reach this root (r2 §9).
 */

import { webcrypto } from 'crypto';
import { constants as fsConstants } from 'fs';
import { chmod, lstat, mkdir, open, rename, rmdir, unlink } from 'fs/promises';
import { isAbsolute, join, relative, sep } from 'path';
import { readContainedFile } from '../../channels/agent-media.js';
import { MAX_UPLOAD_BYTES } from './sniff.js';
import {
  isWithin,
  stagingFilePath,
  uploadDirPath,
  uploadFilePath,
  uploadSegments,
  type UploadLocation,
} from './layout.js';

/**
 * sha256 of up to 10 MiB, off the event loop: WebCrypto's digest runs on
 * libuv's thread pool, so a chat drawing many photos does not stall every
 * other request while each one is checked.
 */
export async function sha256Hex(bytes: Buffer): Promise<string> {
  return Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
}

export type WriteUploadResult =
  | { ok: true; path: string; byteSize: number; sha256: string }
  | { ok: false; reason: 'bad-location' | 'exists' | 'symlinked' | 'failed'; detail?: string };

/**
 * Write bytes as a new upload: staging file (O_EXCL | O_NOFOLLOW, 0600),
 * fsync, then rename into a directory of its own, which is then made
 * read-only (file 0400, directory 0500). Any failure removes what this call
 * created. An existing upload directory is refused, never reused: ids are
 * fresh, so one already there is a collision or tampering.
 */
export async function writeUploadFile(
  rootReal: string,
  loc: UploadLocation,
  bytes: Buffer
): Promise<WriteUploadResult> {
  const dir = uploadDirPath(rootReal, loc);
  const file = uploadFilePath(rootReal, loc);
  const staging = stagingFilePath(rootReal, loc.uploadId);
  if (!dir || !file || !staging) return { ok: false, reason: 'bad-location' };

  let createdStaging = false;
  let createdDir = false;
  let placed = false;
  let done = false;
  try {
    const handle = await open(
      staging,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600
    );
    createdStaging = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (!(await ensureRealDirs(rootReal, [loc.userId, loc.workspaceId]))) {
      return { ok: false, reason: 'symlinked' };
    }
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        return { ok: false, reason: 'exists' };
      throw error;
    }
    createdDir = true;
    await rename(staging, file);
    placed = true;
    await chmod(file, 0o400);
    await syncDirectory(dir);
    await chmod(dir, 0o500);
    done = true;
    return { ok: true, path: file, byteSize: bytes.length, sha256: await sha256Hex(bytes) };
  } catch (error) {
    return { ok: false, reason: 'failed', detail: (error as Error).message };
  } finally {
    if (!done) {
      if (placed) await unlink(file).catch(() => undefined);
      else if (createdStaging) await unlink(staging).catch(() => undefined);
      if (createdDir) await rmdir(dir).catch(() => undefined);
    }
  }
}

export type ReadUploadRefusal =
  | 'bad-location'
  | 'missing'
  | 'symlinked'
  | 'not-a-file'
  | 'hard-linked'
  | 'damaged'
  | 'unreadable';

export type ReadUploadResult =
  | { ok: true; bytes: Buffer; path: string }
  | { ok: false; reason: ReadUploadRefusal };

/**
 * Read an upload whole, from one descriptor, and check it against the row.
 * Callers answer every refusal the same way (a 404, or no attachment); the
 * reason is for counting, and `damaged` also marks the row.
 */
export async function readUploadFile(
  rootReal: string,
  loc: UploadLocation,
  expected: { byteSize: number; sha256: string }
): Promise<ReadUploadResult> {
  const segments = uploadSegments(loc);
  const file = uploadFilePath(rootReal, loc);
  if (!segments || !file) return { ok: false, reason: 'bad-location' };

  // Walk down from the root: every directory must be a real directory and
  // the file a real file, before the reader resolves anything.
  let current = rootReal;
  for (const [i, segment] of segments.entries()) {
    current = join(current, segment);
    let st;
    try {
      st = await lstat(current);
    } catch (error) {
      return {
        ok: false,
        reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable',
      };
    }
    if (st.isSymbolicLink()) return { ok: false, reason: 'symlinked' };
    const last = i === segments.length - 1;
    if (last ? !st.isFile() : !st.isDirectory()) return { ok: false, reason: 'not-a-file' };
  }

  const read = await readContainedFile(file, rootReal, MAX_UPLOAD_BYTES);
  if (!read.ok) {
    switch (read.reason) {
      case 'outside-root':
        return { ok: false, reason: 'symlinked' };
      case 'not-a-file':
      case 'hard-linked':
        return { ok: false, reason: read.reason };
      case 'too-large':
        return { ok: false, reason: 'damaged' };
      case 'unresolvable':
        return { ok: false, reason: 'unreadable' };
    }
  }
  // A swap between the walk and the open can only land inside the root;
  // the reader followed it, so its path differs from the one walked.
  if (read.realPath !== file) return { ok: false, reason: 'symlinked' };
  if (
    read.bytes.length !== expected.byteSize ||
    (await sha256Hex(read.bytes)) !== expected.sha256
  ) {
    return { ok: false, reason: 'damaged' };
  }
  return { ok: true, bytes: read.bytes, path: file };
}

export type RemoveUploadResult =
  | { gone: true }
  | { gone: false; reason: 'bad-location' | 'symlinked' | 'failed'; detail?: string };

/**
 * Remove an upload's bytes: its file and directory, and any staging file a
 * write left behind. Only revocation calls this (a pending orphan whose gate
 * is closed, account deletion, authorized manual removal, or a retention
 * policy once one is chosen), after the row has moved to `removing`, so new
 * reads already refuse.
 *
 * `gone` is evidence, not a hope: both paths are checked absent afterwards.
 * Only then may the row move to `removed` and free its slots; on anything
 * else it stays `removing` for the next pass to retry. Absent to begin with
 * is gone.
 */
export async function removeUploadBytes(
  rootReal: string,
  loc: UploadLocation
): Promise<RemoveUploadResult> {
  const dir = uploadDirPath(rootReal, loc);
  const file = uploadFilePath(rootReal, loc);
  const staging = stagingFilePath(rootReal, loc.uploadId);
  if (!dir || !file || !staging) return { gone: false, reason: 'bad-location' };
  try {
    await unlink(staging).catch(ignoreMissing);
    const dirStat = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (dirStat) {
      if (!dirStat.isDirectory() || !(await noSymlinksBelow(rootReal, dir))) {
        return { gone: false, reason: 'symlinked' };
      }
      await chmod(dir, 0o700);
      await unlink(file).catch(ignoreMissing);
      await rmdir(dir);
    }
    if ((await exists(staging)) || (await exists(dir))) {
      return { gone: false, reason: 'failed', detail: 'still present after removal' };
    }
    return { gone: true };
  } catch (error) {
    return { gone: false, reason: 'failed', detail: (error as Error).message };
  }
}

function ignoreMissing(error: NodeJS.ErrnoException): void {
  if (error.code !== 'ENOENT') throw error;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** True when every path component from the root down to `target` is a real directory. */
async function noSymlinksBelow(rootReal: string, target: string): Promise<boolean> {
  if (!isWithin(rootReal, target)) return false;
  let current = rootReal;
  for (const segment of relative(rootReal, target).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const st = await lstat(current);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
  }
  return true;
}

/**
 * Create each directory below the root one level at a time (0700), checking
 * every level before going into it, so an existing symlink is refused before
 * anything is created through it. False when any level is not a real
 * directory.
 */
async function ensureRealDirs(rootReal: string, segments: readonly string[]): Promise<boolean> {
  let current = rootReal;
  for (const segment of segments) {
    current = join(current, segment);
    // Every caller passes canonical ids, checked by uploadSegments; this keeps
    // the same promise where the path is used, in the form CodeQL reads as a
    // containment check (alerts #103 and #104 on #772).
    const below = relative(rootReal, current);
    if (below === '' || below.startsWith('..') || isAbsolute(below)) return false;
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const st = await lstat(current);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
  }
  return true;
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
