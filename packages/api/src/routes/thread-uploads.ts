/**
 * Photos and documents a person sends into a thread (upload design r2–r5).
 *
 * Mounted by routes/admin.ts under /api/admin/threads/uploads, after admin
 * auth.
 *
 * POST /?key=<threadKey>, the file as the raw body. Answers 201
 * { upload: { id, kind, contentType, byteSize } }, never a path. The order is
 * what makes cleanup safe:
 *   1. the type is decided from the bytes, the size checked;
 *   2. a `receiving` row is inserted holding its quota slots, before any
 *      byte is written, so the bytes in flight are already counted;
 *   3. the bytes are written under the row's own directory;
 *   4. the gate opens, receiving → open, in one conditional update. If that
 *      fails, something closed the gate; it stays closed, this request
 *      removes the bytes it wrote, and the answer is 410.
 * Nothing removes a `receiving` row on age, so no cleanup can free a slot
 * while this request can still publish bytes.
 *
 * GET /:id streams one upload to a person allowed to read it
 * (services/uploads/authorize.ts): its uploader before the message commits,
 * or a current person participant once it has. Every refusal is the same
 * 404. The bytes are checked against the row before any is sent.
 */

import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger';
import { authorizeUpload } from '../services/uploads/authorize';
import {
  readUploadFile,
  removeUploadBytes,
  sha256Hex,
  writeUploadFile,
} from '../services/uploads/files';
import { uploadResponseHeaders } from '../services/uploads/headers';
import { isCanonicalId, type UploadLocation } from '../services/uploads/layout';
import { insertWithSlots } from '../services/uploads/slots';
import {
  accountGate,
  GateClosedError,
  spaceGate,
  type GateLease,
} from '../services/account-deletion/gate';
import { extForContentType, MAX_UPLOAD_BYTES, sniffUploadType } from '../services/uploads/sniff';
import {
  beginRemoval,
  closeGate,
  finishRemoval,
  insertUploadRow,
  isPersonParticipant,
  loadClaim,
  loadClaimedMessage,
  loadUpload,
  markDamaged,
  openGate,
  usedSlots,
} from '../services/uploads/store';

type SignedIn = Request & { inkUserId: string; inkWorkspaceId: string; inkWorkspaceRole: string };

export interface ThreadUploadsDeps {
  /** A service-role client for this request. */
  db: () => SupabaseClient;
  /** The checked uploads root (prepareUploadsRoot), or null when uploads are off. */
  root: () => string | null;
  /** Workspace roles that may send into a thread, the same set /threads/reply uses. */
  writeRoles: ReadonlySet<string>;
  /** Claimed-upload retention; null until one is chosen. */
  retentionMs: number | null;
  /** The API's clock. Tests pass a fixed one. */
  now?: () => number;
  random?: () => number;
  /** File operations; tests replace them to stage races. */
  files?: {
    write: typeof writeUploadFile;
    read: typeof readUploadFile;
    remove: typeof removeUploadBytes;
  };
}

const FILES = { write: writeUploadFile, read: readUploadFile, remove: removeUploadBytes };

async function findThread(
  db: SupabaseClient,
  workspaceId: string,
  key: string
): Promise<{ id: string } | null> {
  const { data, error } = await db
    .from('inbox_threads')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('thread_key', key)
    .maybeSingle();
  if (error) throw new Error(`Failed to read a thread: ${error.message}`);
  return (data as { id: string } | null) ?? null;
}

/**
 * The account's and the space's work gates, held by the upload itself from
 * before its first await until after its last filesystem step, in a
 * `finally` (ink://specs/account-deletion §3, §8). The request's own lease
 * ends when its response closes, which a disconnect can bring before the
 * bytes are written; this one does not end until the handler has.
 */
export async function postUpload(
  deps: ThreadUploadsDeps,
  req: Request,
  res: Response
): Promise<void> {
  const auth = req as SignedIn;
  const leases: GateLease[] = [];
  try {
    leases.push(accountGate.enter(auth.inkUserId));
    leases.push(spaceGate.enter(auth.inkWorkspaceId));
  } catch (error) {
    for (const lease of leases) lease.release();
    if (!(error instanceof GateClosedError)) throw error;
    res.status(409).json({ error: 'This account or space is being deleted' });
    return;
  }
  try {
    await receiveUpload(deps, req, res);
  } finally {
    for (const lease of leases) lease.release();
  }
}

async function receiveUpload(deps: ThreadUploadsDeps, req: Request, res: Response): Promise<void> {
  const root = deps.root();
  if (!root) {
    res.status(503).json({ error: 'Uploads are not available on this server' });
    return;
  }
  const auth = req as SignedIn;
  if (!deps.writeRoles.has(auth.inkWorkspaceRole)) {
    res.status(403).json({ error: 'Your role in this space cannot send messages' });
    return;
  }
  const key = typeof req.query.key === 'string' ? req.query.key.trim() : '';
  if (!key) {
    res.status(400).json({ error: 'key is required' });
    return;
  }
  const db = deps.db();
  const thread = await findThread(db, auth.inkWorkspaceId, key);
  const member =
    thread !== null &&
    (await isPersonParticipant(db, {
      threadId: thread.id,
      userId: auth.inkUserId,
      workspaceId: auth.inkWorkspaceId,
    }));
  if (!thread || !member) {
    res.status(404).json({ error: `No thread with key "${key}"` });
    return;
  }

  // The server's own copy, so everything below checks, stores and counts a
  // Buffer this code made rather than a value the request handed over.
  // isBuffer already rules out a string or an array; CodeQL's type-confusion
  // analysis does not treat it as a guard (alerts #105 to #111 on #772).
  const bytes = Buffer.isBuffer(req.body) ? Buffer.from(req.body) : null;
  if (!bytes) {
    res.status(400).json({ error: 'Send the file as the request body' });
    return;
  }
  const sniffed = sniffUploadType(bytes);
  if (!sniffed.ok) {
    const status = { empty: 400, 'too-large': 413, unsupported: 415 }[sniffed.reason];
    res.status(status).json({
      error:
        sniffed.reason === 'unsupported'
          ? 'Send a JPEG or PNG photo, a PDF, or a plain-text file'
          : sniffed.reason === 'empty'
            ? 'The file is empty'
            : 'The file is too large',
      code: `upload_${sniffed.reason.replace('-', '_')}`,
    });
    return;
  }

  const now = deps.now ?? Date.now;
  const files = deps.files ?? FILES;
  const id = randomUUID();
  const row = {
    id,
    user_id: auth.inkUserId,
    workspace_id: auth.inkWorkspaceId,
    thread_id: thread.id,
    kind: sniffed.kind,
    content_type: sniffed.contentType,
    byte_size: bytes.length,
    sha256: await sha256Hex(bytes),
    created_at: new Date(now()).toISOString(),
  };
  const reserved = await insertWithSlots(
    () => usedSlots(db, auth.inkUserId),
    async (slots) => {
      const inserted = await insertUploadRow(db, row, slots);
      return inserted.ok ? { ok: true as const, row: id } : inserted;
    },
    deps.random
  );
  if (!reserved.ok) {
    if (reserved.reason === 'contended') {
      res.status(503).json({ error: 'Too many uploads at once; try again', code: 'upload_busy' });
    } else if (reserved.full === 'global') {
      res.status(507).json({ error: 'This server has no room for uploads', code: 'upload_full' });
    } else {
      res.status(429).json({
        error:
          reserved.full === 'pending'
            ? 'Too many files are waiting to be sent; send or remove some first'
            : 'This account holds as many files as it can',
        code: `upload_${reserved.full}_limit`,
      });
    }
    return;
  }

  const loc: UploadLocation = {
    userId: auth.inkUserId,
    workspaceId: auth.inkWorkspaceId,
    uploadId: id,
    ext: sniffed.ext,
  };
  const written = await files.write(root, loc, bytes);
  if (!written.ok) {
    logger.warn('[Uploads] write failed', { id, reason: written.reason });
    await abandonOwnUpload(db, root, loc, now, files.remove);
    res.status(500).json({ error: 'The file could not be saved' });
    return;
  }
  if (!(await openGate(db, id))) {
    // Closed under us. The closer owns the row; these bytes are ours to take back.
    const removed = await files.remove(root, loc);
    logger.warn('[Uploads] gate closed before the upload finished', { id, gone: removed.gone });
    res.status(410).json({ error: 'This upload was cancelled; attach the file again' });
    return;
  }
  res.status(201).json({
    upload: { id, kind: sniffed.kind, contentType: sniffed.contentType, byteSize: bytes.length },
  });
}

/**
 * This request's own write failed after its row was inserted: close the
 * gate it holds, then remove. Any step that does not complete leaves the row
 * receiving or removing, still holding its slots, never freed by inference.
 */
async function abandonOwnUpload(
  db: SupabaseClient,
  root: string,
  loc: UploadLocation,
  now: () => number,
  remove: typeof removeUploadBytes
): Promise<void> {
  try {
    if (!(await closeGate(db, loc.uploadId, 'receiving'))) return;
    if (!(await beginRemoval(db, loc.uploadId, 'orphan', new Date(now()).toISOString()))) return;
    if ((await remove(root, loc)).gone) {
      await finishRemoval(db, loc.uploadId, new Date(now()).toISOString());
    }
  } catch (error) {
    logger.warn('[Uploads] could not clean up a failed upload; it stays held', {
      id: loc.uploadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getUpload(
  deps: ThreadUploadsDeps,
  req: Request,
  res: Response
): Promise<void> {
  const notFound = () => void res.status(404).json({ error: 'No such upload' });
  const root = deps.root();
  const id = req.params.id;
  if (!root || !isCanonicalId(id)) return notFound();
  const auth = req as SignedIn;
  const db = deps.db();
  const now = deps.now ?? Date.now;
  const files = deps.files ?? FILES;

  const upload = await loadUpload(db, id, auth.inkWorkspaceId);
  if (!upload) return notFound();
  const claim = await loadClaim(db, id);
  const message = claim ? await loadClaimedMessage(db, claim) : null;
  const participant = await isPersonParticipant(db, {
    threadId: upload.thread_id,
    userId: auth.inkUserId,
    workspaceId: auth.inkWorkspaceId,
  });
  const decision = authorizeUpload({
    upload,
    claim,
    message,
    access: {
      kind: 'read',
      userId: auth.inkUserId,
      workspaceId: auth.inkWorkspaceId,
      isPersonParticipant: participant,
    },
    now: now(),
    retentionMs: deps.retentionMs,
  });
  if (!decision.ok) return notFound();

  const ext = extForContentType(upload.content_type);
  const headers = uploadResponseHeaders(id, upload.content_type);
  if (!ext || !headers) return notFound();
  const read = await files.read(
    root,
    { userId: upload.user_id, workspaceId: upload.workspace_id, uploadId: id, ext },
    { byteSize: upload.byte_size, sha256: upload.sha256 }
  );
  if (!read.ok) {
    if (read.reason === 'damaged') await markDamaged(db, id, new Date(now()).toISOString());
    logger.warn('[Uploads] read refused', { id, reason: read.reason });
    return notFound();
  }
  res.status(200).set(headers).send(read.bytes);
}

/** The router admin.ts mounts at /threads/uploads. */
export function threadUploadsRouter(deps: ThreadUploadsDeps): Router {
  const router = Router();
  const wrap =
    (handler: (deps: ThreadUploadsDeps, req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response) => {
      handler(deps, req, res).catch((error: unknown) => {
        logger.error('[Uploads] request failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) res.status(500).json({ error: 'Upload request failed' });
      });
    };
  // The raw body on this route only, whatever its declared type: the type is
  // decided from the bytes.
  router.post('/', express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), wrap(postUpload));
  router.get('/:id', wrap(getUpload));
  router.use((error: { type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (error?.type === 'entity.too.large') {
      res.status(413).json({ error: 'The file is too large', code: 'upload_too_large' });
      return;
    }
    next(error);
  });
  return router;
}
