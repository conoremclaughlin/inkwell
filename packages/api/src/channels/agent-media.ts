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
 *    review 4900499698). Snapshots land under <root>/.trigger-snapshots so
 *    they stay inside the recipient's existing --add-dir grant; cleanup is
 *    the shared file-lifecycle TODO.
 */

import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { basename, join, sep } from 'path';
import { constants as fsConstants } from 'fs';
import { mkdir, open, realpath, writeFile } from 'fs/promises';
import type { MediaAttachment } from '../services/sessions/types.js';
import { logger } from '../utils/logger';

/** Defensive cap on attachments per message. */
export const MAX_TRIGGER_MEDIA = 8;

/** Per-file byte cap for snapshotted attachments. */
export const MAX_TRIGGER_MEDIA_FILE_BYTES = 25 * 1024 * 1024;

/** Snapshot directory name under the shared media root. */
export const TRIGGER_SNAPSHOT_DIR = '.trigger-snapshots';

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'voice']);

export function defaultMediaRoot(): string {
  return join(homedir(), '.ink', 'files');
}

export interface ResolveTriggerMediaOptions {
  mediaRoot?: string;
  /** Test hook — production always uses MAX_TRIGGER_MEDIA_FILE_BYTES. */
  maxFileBytes?: number;
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

  let rootReal: string;
  try {
    rootReal = await realpath(mediaRoot);
  } catch {
    logger.warn('[Trigger] media requested but shared media dir is missing', { mediaRoot });
    return [];
  }

  if (raw.length > MAX_TRIGGER_MEDIA) {
    logger.warn('[Trigger] media list truncated', {
      requested: raw.length,
      cap: MAX_TRIGGER_MEDIA,
    });
  }

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
    try {
      // Policy check on the reference: the sender may only point inside the
      // shared root. Realpath first so symlinks are judged by target.
      const real = await realpath(e.path);
      if (!real.startsWith(rootReal + sep)) {
        logger.warn('[Trigger] media path outside shared media dir — dropped', { path: e.path });
        continue;
      }

      // Provenance + content: one descriptor for verification AND the copy.
      // O_NOFOLLOW kills a symlink swapped in after the realpath; O_NONBLOCK
      // keeps a swapped-in FIFO from hanging the handler; nlink === 1
      // rejects hard links that alias content from outside the root.
      const handle = await open(
        real,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
      );
      try {
        const st = await handle.stat();
        if (!st.isFile()) {
          logger.warn('[Trigger] media path is not a regular file — dropped', { path: e.path });
          continue;
        }
        if (st.nlink > 1) {
          logger.warn('[Trigger] media file has multiple hard links — dropped', { path: e.path });
          continue;
        }
        if (st.size > maxFileBytes) {
          logger.warn('[Trigger] media file over size cap — dropped', {
            path: e.path,
            size: st.size,
            cap: maxFileBytes,
          });
          continue;
        }

        const bytes = await handle.readFile();
        const snapshotDir = join(rootReal, TRIGGER_SNAPSHOT_DIR);
        await mkdir(snapshotDir, { recursive: true });
        const snapshotPath = join(snapshotDir, `${randomUUID()}-${basename(real)}`);
        await writeFile(snapshotPath, bytes, { flag: 'wx' });

        out.push({
          type:
            typeof e.type === 'string' && MEDIA_TYPES.has(e.type)
              ? (e.type as MediaAttachment['type'])
              : 'document',
          path: snapshotPath,
          ...(typeof e.mimeType === 'string' ? { mimeType: e.mimeType } : {}),
          ...(typeof e.filename === 'string' ? { filename: e.filename } : {}),
        });
      } finally {
        await handle.close();
      }
    } catch {
      logger.warn('[Trigger] media path unresolvable — dropped', { path: e.path });
    }
  }
  if (malformed > 0) {
    logger.warn('[Trigger] malformed media entries dropped', { count: malformed });
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
