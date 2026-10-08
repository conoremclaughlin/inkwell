/**
 * The upload routes over the in-memory FakePostgrest and a real temporary
 * uploads root. FakePostgrest enforces the three slot indexes as unique
 * constraints; the claim gate's foreign key and the atomic claim set are
 * PostgreSQL behaviour, proved against a disposable cluster separately.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createHash, randomUUID } from 'crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FakePostgrest, type Row } from '../test/fake-postgrest';

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  getUpload,
  postUpload,
  threadUploadsRouter,
  type ThreadUploadsDeps,
} from './thread-uploads';
import { prepareUploadsRoot, uploadDirPath, uploadFilePath } from '../services/uploads/layout';
import { removeUploadBytes, writeUploadFile } from '../services/uploads/files';
import { claimRowsFor } from '../services/uploads/claims';
import { ACCOUNT_SLOTS, GLOBAL_SLOTS, PENDING_SLOTS } from '../services/uploads/slots';

const ADA = '0a0a0a0a-0000-4000-8000-0000000000aa';
const SAM = '0b0b0b0b-0000-4000-8000-0000000000bb';
const WS = '1c1c1c1c-0000-4000-8000-0000000000cc';
const OTHER_WS = '1d1d1d1d-0000-4000-8000-0000000000dd';
const THREAD = '2e2e2e2e-0000-4000-8000-0000000000ee';
const KEY = 'inkling:dm:fern';
const NOW = Date.parse('2026-10-07T10:00:00.000Z');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const HEIC = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const holding = (row: Row) => row.state === 'live' || row.state === 'removing';

let db: FakePostgrest;
let base: string;
let root: string;

beforeEach(async () => {
  db = new FakePostgrest();
  db.unique.thread_uploads = [
    {
      name: 'thread_uploads_account_slot_key',
      key: (r) => (holding(r) ? `${r.user_id}:${r.account_slot}` : null),
    },
    {
      name: 'thread_uploads_pending_slot_key',
      key: (r) => (holding(r) && r.pending_slot !== null ? `${r.user_id}:${r.pending_slot}` : null),
    },
    {
      name: 'thread_uploads_global_slot_key',
      key: (r) => (holding(r) ? String(r.global_slot) : null),
    },
  ];
  db.seed('inbox_threads', { id: THREAD, workspace_id: WS, thread_key: KEY });
  for (const user_id of [ADA, SAM]) {
    db.seed('inbox_thread_participants', {
      thread_id: THREAD,
      workspace_id: WS,
      user_id,
      sb_id: null,
    });
  }
  db.seed('inbox_thread_participants', {
    thread_id: THREAD,
    workspace_id: WS,
    user_id: null,
    sb_id: '3f3f3f3f-0000-4000-8000-0000000000ff',
  });
  base = realpathSync(mkdtempSync(join(tmpdir(), 'thread-uploads-')));
  const prepared = await prepareUploadsRoot(join(base, 'uploads'), base, []);
  if (!prepared.ok) throw new Error(prepared.detail);
  root = prepared.rootReal;
});

afterEach(() => {
  for (const dir of walkDirs(root)) chmodSync(dir, 0o700);
  rmSync(base, { recursive: true, force: true });
});

function walkDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out = [dir];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.isDirectory()) {
      chmodSync(join(dir, name.name), 0o700);
      out.push(...walkDirs(join(dir, name.name)));
    }
  }
  return out;
}

function deps(over: Partial<ThreadUploadsDeps> = {}): ThreadUploadsDeps {
  return {
    db: () => db as never,
    root: () => root,
    writeRoles: new Set(['owner', 'admin', 'member']),
    retentionMs: null,
    now: () => NOW,
    random: () => 0,
    ...over,
  };
}

interface Sent {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

function call(
  handler: typeof postUpload,
  d: ThreadUploadsDeps,
  input: {
    userId?: string;
    workspaceId?: string;
    role?: string;
    query?: Row;
    params?: Row;
    body?: unknown;
  }
): Promise<Sent> {
  const sent: Sent = { status: 0, body: undefined, headers: {} };
  const res = {
    headersSent: false,
    // A real response is an event emitter; the account lease listens for 'close'.
    once() {
      return this;
    },
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      this.headersSent = true;
      return this;
    },
    set(headers: Record<string, string>) {
      Object.assign(sent.headers, headers);
      return this;
    },
    send(body: unknown) {
      sent.body = body;
      this.headersSent = true;
      return this;
    },
  };
  const req = {
    inkUserId: input.userId ?? ADA,
    inkWorkspaceId: input.workspaceId ?? WS,
    inkWorkspaceRole: input.role ?? 'member',
    query: input.query ?? { key: KEY },
    params: input.params ?? {},
    body: input.body,
  };
  return handler(d, req as unknown as Request, res as unknown as Response).then(() => sent);
}

const upload = (body: unknown = JPEG, over: Partial<ThreadUploadsDeps> = {}, as: string = ADA) =>
  call(postUpload, deps(over), { body, userId: as });
const uploadRow = (id: string) => db.rows('thread_uploads').find((r) => r.id === id)!;
const idOf = (sent: Sent) => (sent.body as { upload: { id: string } }).upload.id;
const locOf = (id: string, userId = ADA) => ({
  userId,
  workspaceId: WS,
  uploadId: id,
  ext: 'jpg' as const,
});

describe('POST /threads/uploads', () => {
  it('stores the bytes under a server id and answers with no path', async () => {
    const sent = await upload();
    expect(sent.status).toBe(201);
    const id = idOf(sent);
    expect(sent.body).toEqual({
      upload: { id, kind: 'image', contentType: 'image/jpeg', byteSize: JPEG.length },
    });
    expect(JSON.stringify(sent.body)).not.toContain(root);
    expect(uploadRow(id)).toMatchObject({
      user_id: ADA,
      workspace_id: WS,
      thread_id: THREAD,
      claim_gate: 'open',
      sha256: sha(JPEG),
      byte_size: JPEG.length,
      account_slot: 0,
      pending_slot: 0,
      // The API's clock, not the database's.
      created_at: new Date(NOW).toISOString(),
    });
    expect(existsSync(uploadFilePath(root, locOf(id))!)).toBe(true);
  });

  it('refuses before touching anything when uploads are off, the role cannot send or the thread is not theirs', async () => {
    expect((await upload(JPEG, { root: () => null })).status).toBe(503);
    expect((await call(postUpload, deps(), { body: JPEG, role: 'viewer' })).status).toBe(403);
    expect((await call(postUpload, deps(), { body: JPEG, query: {} })).status).toBe(400);
    expect(
      (await call(postUpload, deps(), { body: JPEG, query: { key: 'inkling:dm:nobody' } })).status
    ).toBe(404);
    // A person who is not a participant, and the same person in another workspace.
    const outsider = '0c0c0c0c-0000-4000-8000-0000000000cc';
    expect((await upload(JPEG, {}, outsider)).status).toBe(404);
    expect((await call(postUpload, deps(), { body: JPEG, workspaceId: OTHER_WS })).status).toBe(
      404
    );
    expect(db.rows('thread_uploads')).toHaveLength(0);
  });

  it('decides the type from the bytes and stores nothing it refuses', async () => {
    expect((await upload(HEIC)).status).toBe(415);
    expect((await upload(Buffer.alloc(0))).status).toBe(400);
    expect((await upload({ not: 'bytes' })).status).toBe(400);
    expect(db.rows('thread_uploads')).toHaveLength(0);
    expect(readdirSync(root)).toEqual(['.staging']);
  });

  it('answers 429 when the account or its pending slots are full, and 507 when the server is', async () => {
    const fill = (n: number, row: (i: number) => Row) => {
      for (let i = 0; i < n; i++) db.seed('thread_uploads', { state: 'live', ...row(i) });
    };
    fill(ACCOUNT_SLOTS, (i) => ({
      user_id: ADA,
      account_slot: i,
      pending_slot: null,
      global_slot: i,
    }));
    expect((await upload()).status).toBe(429);
    db.tables.thread_uploads = [];
    fill(PENDING_SLOTS, (i) => ({
      user_id: ADA,
      account_slot: i,
      pending_slot: i,
      global_slot: i,
    }));
    expect(await upload()).toMatchObject({ status: 429, body: { code: 'upload_pending_limit' } });
    db.tables.thread_uploads = [];
    fill(GLOBAL_SLOTS, (i) => ({
      user_id: randomUUID(),
      account_slot: 0,
      pending_slot: null,
      global_slot: i,
    }));
    expect((await upload()).status).toBe(507);
  });

  it('counts a removing row as holding its slots until it is removed', async () => {
    for (let i = 0; i < ACCOUNT_SLOTS; i++) {
      db.seed('thread_uploads', {
        state: i === 0 ? 'removing' : 'live',
        user_id: ADA,
        account_slot: i,
        pending_slot: null,
        global_slot: i,
      });
    }
    expect((await upload()).status).toBe(429);
    db.rows('thread_uploads')[0].state = 'removed';
    expect((await upload()).status).toBe(201);
  });

  it('never reopens a gate closed while it wrote, and takes its own bytes back', async () => {
    const write: typeof writeUploadFile = async (r, loc, bytes) => {
      const written = await writeUploadFile(r, loc, bytes);
      // Someone closes the gate between the bytes landing and the open.
      uploadRow(loc.uploadId).claim_gate = 'closed';
      return written;
    };
    const sent = await upload(JPEG, { files: { write, read: vi.fn(), remove: removeUploadBytes } });
    expect(sent.status).toBe(410);
    const [row] = db.rows('thread_uploads');
    expect(row.claim_gate).toBe('closed');
    expect(existsSync(uploadDirPath(root, locOf(row.id as string))!)).toBe(false);
  });

  it('when its own write fails, closes, removes and frees the row only once the bytes are gone', async () => {
    const failing: typeof writeUploadFile = async () => ({ ok: false, reason: 'failed' });
    const sent = await upload(JPEG, {
      files: { write: failing, read: vi.fn(), remove: removeUploadBytes },
    });
    expect(sent.status).toBe(500);
    expect(db.rows('thread_uploads')[0]).toMatchObject({
      claim_gate: 'closed',
      state: 'removed',
      end_reason: 'orphan',
      ended_at: new Date(NOW).toISOString(),
      removed_at: new Date(NOW).toISOString(),
    });
  });

  it('keeps the row removing, still holding its slots, when the bytes cannot be confirmed gone', async () => {
    const failing: typeof writeUploadFile = async () => ({ ok: false, reason: 'failed' });
    const stuck: typeof removeUploadBytes = async () => ({ gone: false, reason: 'failed' });
    expect(
      (await upload(JPEG, { files: { write: failing, read: vi.fn(), remove: stuck } })).status
    ).toBe(500);
    const [row] = db.rows('thread_uploads');
    expect(row.state).toBe('removing');
    expect(row.removed_at).toBeUndefined();
  });
});

describe('GET /threads/uploads/:id', () => {
  const get = (
    id: string,
    as: string = ADA,
    over: Partial<ThreadUploadsDeps> = {},
    workspaceId = WS
  ) => call(getUpload, deps(over), { params: { id }, userId: as, workspaceId });

  function commit(id: string, content = 'Here it is') {
    const cmid = randomUUID();
    const [row] = claimRowsFor({
      threadId: THREAD,
      clientMessageId: cmid,
      userId: ADA,
      content,
      uploadIds: [id],
      createdAt: new Date(NOW).toISOString(),
    });
    const { claim_gate: _g, ...claim } = row;
    db.seed('thread_upload_claims', { ...claim, message_id: null, held_reason: null });
    db.seed('inbox_thread_messages', {
      thread_id: THREAD,
      sender_kind: 'user',
      sender_user_id: ADA,
      content,
      metadata: { clientMessageId: cmid, media: [{ upload: id }] },
    });
  }

  it('lets the uploader preview it before it is sent, and nobody else', async () => {
    const id = idOf(await upload());
    const own = await get(id);
    expect(own.status).toBe(200);
    expect((own.body as Buffer).equals(JPEG)).toBe(true);
    expect(own.headers).toMatchObject({
      'Content-Type': 'image/jpeg',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    expect((await get(id, SAM)).status).toBe(404);
  });

  it('lets a current person participant read it once its message has committed', async () => {
    const id = idOf(await upload());
    commit(id);
    expect((await get(id, SAM)).status).toBe(200);
    // Removed from the thread: refused at once.
    db.tables.inbox_thread_participants = db
      .rows('inbox_thread_participants')
      .filter((r) => r.user_id !== SAM);
    expect((await get(id, SAM)).status).toBe(404);
  });

  it('answers the same 404 for another workspace, a bad id, an ended row or uploads off', async () => {
    const id = idOf(await upload());
    commit(id);
    expect((await get(id, ADA, {}, OTHER_WS)).status).toBe(404);
    expect((await get(id.toUpperCase())).status).toBe(404);
    expect((await get(id, ADA, { root: () => null })).status).toBe(404);
    uploadRow(id).state = 'removing';
    expect((await get(id)).status).toBe(404);
  });

  it('marks changed bytes as damaged and never serves them', async () => {
    const id = idOf(await upload());
    const file = uploadFilePath(root, locOf(id))!;
    chmodSync(uploadDirPath(root, locOf(id))!, 0o700);
    chmodSync(file, 0o600);
    const { writeFileSync } = await import('fs');
    writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    expect((await get(id)).status).toBe(404);
    expect(uploadRow(id).damaged_at).toBe(new Date(NOW).toISOString());
    // Damaged stays damaged even if the file is put back.
    writeFileSync(file, JPEG);
    expect((await get(id)).status).toBe(404);
  });

  it('applies a retention only when one is chosen', async () => {
    const id = idOf(await upload());
    commit(id);
    const later = NOW + 365 * 24 * 60 * 60 * 1000;
    expect((await get(id, SAM, { now: () => later })).status).toBe(200);
    expect(
      (await get(id, SAM, { now: () => later, retentionMs: 30 * 24 * 60 * 60 * 1000 })).status
    ).toBe(404);
  });
});

describe('threadUploadsRouter', () => {
  it('mounts the two routes and answers an oversized body with 413', () => {
    const router = threadUploadsRouter(deps()) as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> }; handle: unknown }>;
    };
    const routes = router.stack
      .filter((l) => l.route)
      .map((l) => [l.route!.path, Object.keys(l.route!.methods)]);
    expect(routes).toEqual([
      ['/', ['post']],
      ['/:id', ['get']],
    ]);
    const onError = router.stack.at(-1)!.handle as (
      e: unknown,
      q: unknown,
      r: unknown,
      n: () => void
    ) => void;
    const sent: Sent = { status: 0, body: undefined, headers: {} };
    const res = {
      // A real response is an event emitter; the account lease listens for 'close'.
      once() {
        return this;
      },
      status(code: number) {
        sent.status = code;
        return this;
      },
      json(body: unknown) {
        sent.body = body;
        return this;
      },
    };
    const next = vi.fn();
    onError({ type: 'entity.too.large' }, {}, res, next);
    expect(sent).toMatchObject({ status: 413, body: { code: 'upload_too_large' } });
    onError({ type: 'other' }, {}, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
