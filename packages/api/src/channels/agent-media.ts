/**
 * Agent-to-agent trigger media (spec:provider-media-injection).
 *
 * `send_to_inbox` metadata.media lets one SB attach files for another. The
 * STORED message row is the trust source — media is read back from
 * agent_inbox / inbox_thread_messages (written server-side at send time),
 * never from the trigger payload itself. Paths are constrained to the shared
 * media directory (~/.ink/files): without containment, a sender could point
 * the recipient's spawn at any server-readable file (~/.ssh, .env.local, …)
 * and have it injected into that agent's context (CLAUDE.md media-isolation
 * TODO). Every rejection is fail-closed and logged.
 */

import { homedir } from 'os';
import { join, sep } from 'path';
import { realpath, stat } from 'fs/promises';
import type { MediaAttachment } from '../services/sessions/types.js';
import { logger } from '../utils/logger';

/** Defensive cap on attachments per message. */
export const MAX_TRIGGER_MEDIA = 8;

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'voice']);

export function defaultMediaRoot(): string {
  return join(homedir(), '.ink', 'files');
}

/**
 * Extract and validate media from a stored message's metadata. Returns only
 * entries whose realpath resolves to an existing REGULAR file inside the
 * shared media root; everything else is dropped with a warning. Async —
 * this runs inside the trigger handler on the main event loop.
 */
export async function resolveTriggerMedia(
  metadata: unknown,
  mediaRoot: string = defaultMediaRoot()
): Promise<MediaAttachment[]> {
  const raw = (metadata as { media?: unknown } | null | undefined)?.media;
  if (!Array.isArray(raw) || raw.length === 0) return [];

  let rootReal: string;
  try {
    rootReal = await realpath(mediaRoot);
  } catch {
    // No shared media directory — nothing can be delivered.
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
  for (const entry of raw.slice(0, MAX_TRIGGER_MEDIA)) {
    const e = entry as {
      path?: unknown;
      type?: unknown;
      mimeType?: unknown;
      filename?: unknown;
    } | null;
    if (typeof e?.path !== 'string' || e.path.length === 0) continue;
    try {
      // realpath first: symlinks inside the root pointing outside it resolve
      // to their target, so containment is checked on the REAL location.
      const real = await realpath(e.path);
      if (!real.startsWith(rootReal + sep)) {
        logger.warn('[Trigger] media path outside shared media dir — dropped', { path: e.path });
        continue;
      }
      const st = await stat(real);
      if (!st.isFile()) {
        logger.warn('[Trigger] media path is not a regular file — dropped', { path: e.path });
        continue;
      }
      out.push({
        type:
          typeof e.type === 'string' && MEDIA_TYPES.has(e.type)
            ? (e.type as MediaAttachment['type'])
            : 'document',
        path: real,
        ...(typeof e.mimeType === 'string' ? { mimeType: e.mimeType } : {}),
        ...(typeof e.filename === 'string' ? { filename: e.filename } : {}),
      });
    } catch {
      logger.warn('[Trigger] media path unresolvable — dropped', { path: e.path });
    }
  }
  return out;
}
