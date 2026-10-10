/**
 * Log-owned media, not a shared upload cache. The caller owns the log's sole
 * writer and must append/flush a returned descriptor before provider dispatch.
 * One instance per open log: the queue bounds writes, not cross-process owners.
 *
 * No collector: a settled turn does not prove its provider exited. Closing or
 * reopening this store never deletes bytes. See spec:live-agent-surfaces v99.
 */
import { createHash, randomUUID } from 'crypto';
import { constants } from 'fs';
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from 'fs/promises';
import { basename, dirname, isAbsolute, join } from 'path';
import type { ContextImage } from '../runtime/context-image.js';
import {
  estimateImageTokens,
  INLINE_IMAGE_MIME,
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_IMAGE_SIDE,
  readImageInfo,
} from './tool-images.js';

/** Only this path-free shape may be persisted in a log. */
export interface RetainedImageDescriptor {
  version: 1;
  sha256: string;
  byteLength: number;
  mimeType: string;
  width: number;
  height: number;
}

const FIELDS = ['version', 'sha256', 'byteLength', 'mimeType', 'width', 'height'];
export const SESSION_MEDIA_MAX_FILES = 64;
export const SESSION_MEDIA_MAX_BYTES = 64 * 1024 * 1024;
const IGNORE = '*\n';

export function parseRetainedImageDescriptor(value: unknown): RetainedImageDescriptor | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const bounded = (n: unknown, max: number): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= max;
  if (
    Object.keys(v).length !== FIELDS.length ||
    Object.keys(v).some((key) => !FIELDS.includes(key)) ||
    v.version !== 1 ||
    typeof v.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.sha256) ||
    !bounded(v.byteLength, MAX_INLINE_IMAGE_BYTES) ||
    typeof v.mimeType !== 'string' ||
    !INLINE_IMAGE_MIME.has(v.mimeType) ||
    !bounded(v.width, MAX_INLINE_IMAGE_SIDE) ||
    !bounded(v.height, MAX_INLINE_IMAGE_SIDE)
  )
    return undefined;
  return {
    version: 1,
    sha256: v.sha256,
    byteLength: v.byteLength,
    mimeType: v.mimeType,
    width: v.width,
    height: v.height,
  };
}

type Refusal = 'invalid_image' | 'invalid_descriptor' | 'quota' | 'unavailable' | 'closed';
export type RetainedImageResult =
  | { ok: true; descriptor: RetainedImageDescriptor; image: ContextImage }
  | { ok: false; reason: Refusal; placeholder: string };

function refused(reason: Refusal): RetainedImageResult {
  return {
    ok: false,
    reason,
    placeholder: `[image unavailable (${reason}): an image was present, but its bytes were not retained or could not be verified; you have not seen it in this context]`,
  };
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

/** Open without following the leaf, bound allocations, and never block on a FIFO. */
async function readBounded(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes || (stat.mode & 0o077) !== 0)
      throw new Error('Not a private bounded regular file');
    const bytes = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await file.read(bytes, count, bytes.length - count, count);
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    if (count > maxBytes) throw new Error('Media grew beyond its bound');
    return bytes.subarray(0, count);
  } finally {
    await file.close();
  }
}

export class SessionMediaStore {
  private readonly logPath: string;
  private readonly maxFiles: number;
  private readonly maxBytes: number;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private pendingFiles = 0;
  private pendingBytes = 0;

  constructor(input: { logPath: string; maxFiles?: number; maxBytes?: number }) {
    if (!isAbsolute(input.logPath))
      throw new Error('Media requires an absolute host-owned log path');
    this.logPath = input.logPath;
    this.maxFiles = input.maxFiles ?? SESSION_MEDIA_MAX_FILES;
    this.maxBytes = input.maxBytes ?? SESSION_MEDIA_MAX_BYTES;
    // Overrides can lower ceilings for a host or a test, never remove bounds.
    if (
      !Number.isSafeInteger(this.maxFiles) ||
      this.maxFiles < 1 ||
      this.maxFiles > SESSION_MEDIA_MAX_FILES ||
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1 ||
      this.maxBytes > SESSION_MEDIA_MAX_BYTES
    )
      throw new Error('Invalid session media limits');
  }

  private enqueue(work: () => Promise<RetainedImageResult>): Promise<RetainedImageResult> {
    if (this.closed) return Promise.resolve(refused('closed'));
    const result = this.queue.then(work).catch(() => refused('unavailable'));
    this.queue = result;
    return result;
  }

  private async directory(create: boolean): Promise<string> {
    // Resolve the host's parent, never a path supplied in a descriptor. A
    // symlink at the media directory itself is refused, not adopted.
    const parent = await realpath(dirname(this.logPath));
    const dir = join(parent, `${basename(this.logPath)}.media`);
    if (create)
      await mkdir(dir, { mode: 0o700 }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
    const stat = await lstat(dir);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (await realpath(dir)) !== dir
    )
      throw new Error('Unsafe media directory');
    return dir;
  }

  private async ensureIgnored(dir: string): Promise<void> {
    const path = join(dir, '.gitignore');
    try {
      if ((await readBounded(path, IGNORE.length)).toString() !== IGNORE)
        throw new Error('Media ignore rule differs');
    } catch (error) {
      if (!missing(error)) throw error;
      await this.publish(dir, '.gitignore', Buffer.from(IGNORE));
    }
  }

  private async publish(dir: string, name: string, bytes: Buffer): Promise<void> {
    const staged = join(dir, `.pending-${randomUUID()}`);
    const file = await open(staged, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.close();
      // No fsync claim. Restore must still verify the complete bytes after
      // power loss, independently of whether the log append survived.
      await rename(staged, join(dir, name));
    } finally {
      await file.close();
      await unlink(staged).catch((error) => {
        if (!missing(error)) throw error;
      });
    }
  }

  private async fits(dir: string, extraBytes: number): Promise<boolean> {
    let count = 0,
      bytes = 0;
    for await (const item of await opendir(dir)) {
      if (item.name === '.gitignore') continue;
      // Orphans, pending writes and unknown names count. No recursive scan or
      // cleanup, and an oversized directory stops the scan at the ceiling.
      if (++count >= this.maxFiles) return false;
      const stat = await lstat(join(dir, item.name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unexpected media entry');
      bytes += stat.size;
      if (bytes + extraBytes > this.maxBytes) return false;
    }
    return bytes + extraBytes <= this.maxBytes;
  }

  private async validated(
    dir: string,
    descriptor: RetainedImageDescriptor
  ): Promise<RetainedImageResult> {
    const path = join(dir, descriptor.sha256);
    const bytes = await readBounded(path, descriptor.byteLength);
    const info = readImageInfo(bytes);
    if (
      bytes.length !== descriptor.byteLength ||
      hash(bytes) !== descriptor.sha256 ||
      !info ||
      info.mimeType !== descriptor.mimeType ||
      info.width !== descriptor.width ||
      info.height !== descriptor.height
    )
      return refused('unavailable');
    return {
      ok: true,
      descriptor,
      image: {
        ref: `img:${descriptor.sha256}`,
        path,
        mimeType: info.mimeType,
        width: info.width,
        height: info.height,
        approxTokens: estimateImageTokens(info.width, info.height),
      },
    };
  }

  /** Bytes must already have passed the tool's policy/containment checks. */
  put(input: Buffer): Promise<RetainedImageResult> {
    if (this.closed) return Promise.resolve(refused('closed'));
    if (input.length > MAX_INLINE_IMAGE_BYTES) return Promise.resolve(refused('invalid_image'));
    // Serialized disk writes do not by themselves bound queued Buffer copies.
    if (this.pendingFiles >= this.maxFiles || this.pendingBytes + input.length > this.maxBytes)
      return Promise.resolve(refused('quota'));
    this.pendingFiles += 1;
    this.pendingBytes += input.length;
    const bytes = Buffer.from(input); // Freeze before enqueue; callers may reuse their buffers.
    return this.enqueue(async () => {
      const info = readImageInfo(bytes);
      const descriptor =
        info &&
        parseRetainedImageDescriptor({
          version: 1,
          sha256: hash(bytes),
          byteLength: bytes.length,
          ...info,
        });
      if (!descriptor) return refused('invalid_image');
      const dir = await this.directory(true);
      await this.ensureIgnored(dir); // Works even in a new repo without Ink ignore rules.
      try {
        return await this.validated(dir, descriptor); // EEXIST alone is never dedupe evidence.
      } catch (error) {
        if (!missing(error)) throw error;
      }
      if (!(await this.fits(dir, bytes.length))) return refused('quota');
      await this.publish(dir, descriptor.sha256, bytes);
      return this.validated(dir, descriptor);
    }).finally(() => {
      this.pendingFiles -= 1;
      this.pendingBytes -= bytes.length;
    });
  }

  /** A bad/missing image is an explicit context placeholder, never an original-file reread. */
  restore(value: unknown): Promise<RetainedImageResult> {
    const descriptor = parseRetainedImageDescriptor(value);
    if (!descriptor) return Promise.resolve(refused('invalid_descriptor'));
    return this.enqueue(async () => this.validated(await this.directory(false), descriptor));
  }

  /** Drain accepted operations; never delete retained or orphaned files here. */
  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
  }
}
