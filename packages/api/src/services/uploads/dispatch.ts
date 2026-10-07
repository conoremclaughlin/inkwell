/**
 * The uploads a stored message names, as attachments for the dispatch that
 * delivers it (upload design r4–r5).
 *
 * Called from storedTriggerMedia with the stored row itself, never a payload.
 * Each upload is authorized against exactly that message (its claim, the
 * same person, words and manifest), then its bytes are checked against the
 * row before the original file's path is handed on. A runner opens that path
 * later, so the check proves what was on disk at resolve time only; that
 * limit is stated, not hidden. Anything refused is dropped and logged; the
 * rest of the message still goes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../utils/logger';
import type { MediaAttachment } from '../sessions/types';
import { authorizeUpload } from './authorize';
import { MAX_UPLOADS_PER_MESSAGE, mediaUploadIds, type StoredThreadMessage } from './claims';
import { readUploadFile } from './files';
import { extForContentType } from './sniff';
import { loadClaim, loadUploadForDispatch, markDamaged } from './store';
import { uploadsRetentionMs, uploadsRoot } from './runtime';

export interface ResolveUploadDeps {
  root?: string | null;
  now?: () => number;
  read?: typeof readUploadFile;
}

export async function resolveUploadMedia(
  db: SupabaseClient,
  message: StoredThreadMessage,
  deps: ResolveUploadDeps = {}
): Promise<MediaAttachment[]> {
  const ids = mediaUploadIds(message.metadata);
  if (ids === null) {
    logger.warn('[Uploads] malformed upload media on a stored message — dropped', {
      messageId: message.id,
    });
    return [];
  }
  if (ids.length === 0) return [];
  const root = deps.root === undefined ? uploadsRoot() : deps.root;
  if (!root) {
    logger.warn('[Uploads] a message names uploads but uploads are off — dropped', {
      messageId: message.id,
      count: ids.length,
    });
    return [];
  }
  const now = deps.now ?? Date.now;
  const read = deps.read ?? readUploadFile;

  const out: MediaAttachment[] = [];
  for (const id of ids.slice(0, MAX_UPLOADS_PER_MESSAGE)) {
    try {
      const upload = await loadUploadForDispatch(db, id);
      const claim = upload ? await loadClaim(db, id) : null;
      const decision = upload
        ? authorizeUpload({
            upload,
            claim,
            message,
            access: { kind: 'resolve', messageId: message.id },
            now: now(),
            retentionMs: uploadsRetentionMs(),
          })
        : ({ ok: false, reason: 'gone' } as const);
      const ext = upload ? extForContentType(upload.content_type) : null;
      if (!upload || !decision.ok || !ext) {
        logger.warn('[Uploads] attachment refused — dropped', {
          messageId: message.id,
          uploadId: id,
          reason: decision.ok ? 'unknown-type' : decision.reason,
        });
        continue;
      }
      const checked = await read(
        root,
        { userId: upload.user_id, workspaceId: upload.workspace_id, uploadId: id, ext },
        { byteSize: upload.byte_size, sha256: upload.sha256 }
      );
      if (!checked.ok) {
        if (checked.reason === 'damaged') {
          await markDamaged(db, id, new Date(now()).toISOString());
        }
        logger.warn('[Uploads] attachment unreadable — dropped', {
          messageId: message.id,
          uploadId: id,
          reason: checked.reason,
        });
        continue;
      }
      out.push({
        type: upload.kind === 'image' ? 'image' : 'document',
        path: checked.path,
        mimeType: upload.content_type.split(';')[0],
        filename: `${id}.${ext}`,
      });
    } catch (error) {
      logger.warn('[Uploads] attachment lookup failed — dropped', {
        messageId: message.id,
        uploadId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}
