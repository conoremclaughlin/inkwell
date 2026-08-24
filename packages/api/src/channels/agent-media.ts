/**
 * Agent-to-agent trigger media (spec:provider-media-injection).
 *
 * `send_to_inbox` metadata.media lets one SB attach files for another. Two
 * boundaries, both fail-closed:
 *
 * 1. TRUST: media enters a dispatch ONLY via `storedTriggerMedia`, which
 *    reads the STORED message row (agent_inbox / inbox_thread_messages,
 *    written server-side at send time). The trigger payload's own metadata
 *    is deliberately not an input — a caller-composed payload cannot smuggle
 *    attachments.
 * 2. CONTENT: each referenced file must realpath into the shared media root
 *    (~/.ink/files) — otherwise a sender could point the recipient's spawn
 *    at any server-readable file (~/.ssh, .env.local, …) and have it
 *    injected into that agent's context (CLAUDE.md media-isolation TODO).
 *    The delivered path is a SNAPSHOT copied from a single opened descriptor
 *    (O_NOFOLLOW | O_NONBLOCK, fstat-verified regular file with nlink 1 and
 *    a size cap): validating a path now and consuming it at spawn time later
 *    would leave a replace-after-check window, and hard links would make the
 *    root a namespace rather than provenance boundary (Lumen, PR #465
 *    review 4900499698). Snapshots are content-addressed (sha256) under a
 *    canonically-verified <root>/.trigger-snapshots — inside the
 *    recipient's existing --add-dir grant — so repeated references reuse
 *    one copy, and LRU retention caps total disk (review 4900565751).
 */

import { homedir } from 'os';
import { createHash } from 'crypto';
import { basename, join, sep } from 'path';
import { constants as fsConstants } from 'fs';
import type { FileHandle } from 'fs/promises';
import { mkdir, open, readdir, realpath, stat, unlink, utimes, writeFile } from 'fs/promises';
import type { MediaAttachment } from '../services/sessions/types.js';
import { logger } from '../utils/logger';

/** Defensive cap on attachments per message. */
export const MAX_TRIGGER_MEDIA = 8;

/** Per-file byte cap for snapshotted attachments. */
export const MAX_TRIGGER_MEDIA_FILE_BYTES = 25 * 1024 * 1024;

/** Snapshot directory name under the shared media root. */
export const TRIGGER_SNAPSHOT_DIR = '.trigger-snapshots';

/** Retention cap: oldest snapshots beyond this are pruned (LRU by mtime). */
export const MAX_TRIGGER_SNAPSHOTS = 64;

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'voice']);

export function defaultMediaRoot(): string {
  return join(homedir(), '.ink', 'files');
}

export interface ResolveTriggerMediaOptions {
  mediaRoot?: string;
  /** Test hook — production always uses MAX_TRIGGER_MEDIA_FILE_BYTES. */
  maxFileBytes?: number;
  /** Test hook — production always uses MAX_TRIGGER_SNAPSHOTS. */
  maxSnapshots?: number;
}

/**
 * Read at most maxBytes from the handle; null when the underlying inode
 * holds MORE than maxBytes. The fstat size check is only a fast reject — a
 * file appended to between fstat and read would otherwise make readFile()
 * an unbounded read (Lumen, review 4900565751). This loop is the boundary:
 * it never requests more than maxBytes + 1 total, regardless of file size.
 */
export async function readBoundedFromHandle(
  handle: FileHandle,
  maxBytes: number
): Promise<Buffer | null> {
  const buf = Buffer.allocUnsafe(maxBytes + 1);
  let total = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buf, total, maxBytes + 1 - total, total);
    if (bytesRead === 0) return buf.subarray(0, total);
    total += bytesRead;
    if (total > maxBytes) return null;
  }
}

export type ContainedFileRejection =
  | 'outside-root'
  | 'not-a-file'
  | 'hard-linked'
  | 'too-large'
  | 'unresolvable';

export type ContainedFileResult =
  | { ok: true; bytes: Buffer; realPath: string }
  | { ok: false; reason: ContainedFileRejection };

/** Human-readable explanation for a rejection, for surfacing to a caller. */
export function describeContainedFileRejection(
  reason: ContainedFileRejection,
  mediaRoot: string
): string {
  switch (reason) {
    case 'outside-root':
      return `path resolves outside the shared media directory (${mediaRoot})`;
    case 'not-a-file':
      return 'path is not a regular file';
    case 'hard-linked':
      return 'file has multiple hard links, so its contents may alias data outside the media directory';
    case 'too-large':
      return 'file exceeds the size limit';
    case 'unresolvable':
      return 'path could not be resolved or read';
  }
}

/**
 * Read a file the caller referenced by path, enforcing the containment and
 * provenance boundary described at the top of this module.
 *
 * This is THE single implementation of that check — trigger media
 * snapshots and Gmail outbound attachments both route through it, so the
 * rules cannot drift apart between the two callers.
 *
 * `rootReal` must already be realpath-resolved (see `resolveMediaRoot`);
 * taking it as a parameter keeps per-file work off the root lookup.
 */
export async function readContainedFile(
  requestedPath: string,
  rootReal: string,
  maxFileBytes: number
): Promise<ContainedFileResult> {
  try {
    // Policy check on the reference: only inside the shared root. Realpath
    // first so symlinks are judged by their target.
    const real = await realpath(requestedPath);
    if (!real.startsWith(rootReal + sep)) return { ok: false, reason: 'outside-root' };

    // Provenance + content: one descriptor for verification AND the read.
    // O_NOFOLLOW kills a symlink swapped in after the realpath; O_NONBLOCK
    // keeps a swapped-in FIFO from hanging the handler; nlink === 1
    // rejects hard links that alias content from outside the root.
    const handle = await open(
      real,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
    );
    try {
      const st = await handle.stat();
      if (!st.isFile()) return { ok: false, reason: 'not-a-file' };
      if (st.nlink > 1) return { ok: false, reason: 'hard-linked' };
      if (st.size > maxFileBytes) return { ok: false, reason: 'too-large' };

      const bytes = await readBoundedFromHandle(handle, maxFileBytes);
      if (!bytes) return { ok: false, reason: 'too-large' };

      return { ok: true, bytes, realPath: real };
    } finally {
      await handle.close();
    }
  } catch {
    return { ok: false, reason: 'unresolvable' };
  }
}

/** Realpath the shared media root, or null when it is missing. */
export async function resolveMediaRoot(mediaRoot = defaultMediaRoot()): Promise<string | null> {
  try {
    return await realpath(mediaRoot);
  } catch {
    return null;
  }
}

/**
 * Verify the snapshot destination is REALLY <root>/.trigger-snapshots — a
 * pre-existing symlink at that name would otherwise route mkdir/writeFile
 * outside the root while the returned lexical path still looked contained.
 * Returns the canonical dir, or null (fail closed for the whole batch).
 */
async function ensureSnapshotDir(rootReal: string): Promise<string | null> {
  const lexical = join(rootReal, TRIGGER_SNAPSHOT_DIR);
  try {
    await mkdir(lexical, { recursive: true });
    const real = await realpath(lexical);
    if (real !== lexical) {
      logger.warn('[Trigger] snapshot dir is not canonical (symlink?) — media delivery refused', {
        expected: lexical,
        actual: real,
      });
      return null;
    }
    return real;
  } catch (err) {
    logger.warn('[Trigger] snapshot dir unavailable — media delivery refused', {
      dir: lexical,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** LRU-prune the snapshot dir to the retention cap. Best-effort. */
async function pruneSnapshots(dirReal: string, maxSnapshots: number): Promise<void> {
  try {
    const names = await readdir(dirReal);
    if (names.length <= maxSnapshots) return;
    const entries = await Promise.all(
      names.map(async (name) => {
        const p = join(dirReal, name);
        try {
          const st = await stat(p);
          return st.isFile() ? { p, mtimeMs: st.mtimeMs } : null;
        } catch {
          return null;
        }
      })
    );
    const files = entries.filter((e): e is { p: string; mtimeMs: number } => e !== null);
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of files.slice(0, Math.max(0, files.length - maxSnapshots))) {
      await unlink(f.p).catch(() => undefined);
    }
  } catch {
    // Retention is best-effort; delivery already succeeded.
  }
}

/**
 * Validate media entries from a stored message's metadata and snapshot each
 * accepted file. Returns attachments whose `path` points at the snapshot —
 * never at the sender-referenced location. Everything rejected is logged.
 */
export async function resolveTriggerMedia(
  metadata: unknown,
  options: ResolveTriggerMediaOptions = {}
): Promise<MediaAttachment[]> {
  const mediaRoot = options.mediaRoot ?? defaultMediaRoot();
  const maxFileBytes = options.maxFileBytes ?? MAX_TRIGGER_MEDIA_FILE_BYTES;

  const raw = (metadata as { media?: unknown } | null | undefined)?.media;
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const rootReal = await resolveMediaRoot(mediaRoot);
  if (!rootReal) {
    logger.warn('[Trigger] media requested but shared media dir is missing', { mediaRoot });
    return [];
  }

  if (raw.length > MAX_TRIGGER_MEDIA) {
    logger.warn('[Trigger] media list truncated', {
      requested: raw.length,
      cap: MAX_TRIGGER_MEDIA,
    });
  }

  // One verified destination for the whole batch; a compromised snapshot
  // dir refuses ALL delivery rather than best-effort partial writes.
  const snapshotDir = await ensureSnapshotDir(rootReal);
  if (!snapshotDir) return [];

  const out: MediaAttachment[] = [];
  let malformed = 0;
  for (const entry of raw.slice(0, MAX_TRIGGER_MEDIA)) {
    const e = entry as {
      path?: unknown;
      type?: unknown;
      mimeType?: unknown;
      filename?: unknown;
    } | null;
    if (typeof e?.path !== 'string' || e.path.length === 0) {
      malformed += 1;
      continue;
    }
    const read = await readContainedFile(e.path, rootReal, maxFileBytes);
    if (!read.ok) {
      // Trigger delivery is best-effort: a bad entry is dropped and the rest
      // of the batch still goes. (Outbound email deliberately does NOT do
      // this — see resolveOutboundAttachments.)
      // Keep the specific reason in the MESSAGE, not just the metadata:
      // these warnings are grepped when an attachment silently fails to
      // arrive, and "rejected" alone does not tell an operator why.
      logger.warn(
        `[Trigger] media entry rejected — dropped: ${describeContainedFileRejection(
          read.reason,
          rootReal
        )}`,
        { path: e.path, reason: read.reason }
      );
      continue;
    }

    try {
      // Content-addressed snapshot: re-sending the same bytes reuses the
      // existing copy instead of growing the disk without bound. `wx` is
      // race-safe (O_CREAT|O_EXCL also refuses a symlink at the final
      // component); EEXIST means an identical snapshot is already there.
      const digest = createHash('sha256').update(read.bytes).digest('hex').slice(0, 32);
      const snapshotPath = join(snapshotDir, `${digest}-${basename(read.realPath)}`);
      try {
        await writeFile(snapshotPath, read.bytes, { flag: 'wx' });
      } catch (writeErr) {
        if ((writeErr as NodeJS.ErrnoException).code === 'EEXIST') {
          // Reuse — refresh mtime so LRU retention keeps live snapshots.
          const now = new Date();
          await utimes(snapshotPath, now, now).catch(() => undefined);
        } else {
          throw writeErr;
        }
      }

      out.push({
        type:
          typeof e.type === 'string' && MEDIA_TYPES.has(e.type)
            ? (e.type as MediaAttachment['type'])
            : 'document',
        path: snapshotPath,
        ...(typeof e.mimeType === 'string' ? { mimeType: e.mimeType } : {}),
        ...(typeof e.filename === 'string' ? { filename: e.filename } : {}),
      });
    } catch {
      logger.warn('[Trigger] media snapshot failed — dropped', { path: e.path });
    }
  }
  if (malformed > 0) {
    logger.warn('[Trigger] malformed media entries dropped', { count: malformed });
  }
  if (out.length > 0) {
    await pruneSnapshots(snapshotDir, options.maxSnapshots ?? MAX_TRIGGER_SNAPSHOTS);
  }
  return out;
}

/** Minimal supabase surface for the stored-row lookup (mockable in tests). */
interface StoredRowClient {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string
      ): { single(): Promise<{ data: { metadata?: unknown } | null; error: unknown }> };
    };
  };
}

/**
 * THE only path media may enter a trigger dispatch. Looks up the stored
 * message row the trigger references and resolves/snapshots its media.
 * Payload-composed metadata is not an input by design: a trigger without a
 * stored message reference delivers no attachments, whatever its payload
 * claims.
 */
export async function storedTriggerMedia(
  client: StoredRowClient,
  ref: { inboxMessageId?: string; threadMessageId?: string },
  options: ResolveTriggerMediaOptions = {}
): Promise<MediaAttachment[]> {
  let storedMetadata: unknown;
  if (ref.inboxMessageId) {
    const { data } = await client
      .from('agent_inbox')
      .select('metadata')
      .eq('id', ref.inboxMessageId)
      .single();
    storedMetadata = data?.metadata;
  } else if (ref.threadMessageId) {
    const { data } = await client
      .from('inbox_thread_messages')
      .select('metadata')
      .eq('id', ref.threadMessageId)
      .single();
    storedMetadata = data?.metadata;
  } else {
    return [];
  }
  return resolveTriggerMedia(storedMetadata, options);
}
