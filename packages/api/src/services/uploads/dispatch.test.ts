import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import { FakePostgrest, type Row } from '../../test/fake-postgrest';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resolveUploadMedia } from './dispatch';
import { claimRowsFor, type StoredThreadMessage } from './claims';
import { writeUploadFile } from './files';
import { prepareUploadsRoot, uploadDirPath, uploadFilePath } from './layout';

const ADA = '0a0a0a0a-0000-4000-8000-0000000000aa';
const SAM = '0b0b0b0b-0000-4000-8000-0000000000bb';
const WS = '1c1c1c1c-0000-4000-8000-0000000000cc';
const THREAD = '2e2e2e2e-0000-4000-8000-0000000000ee';
const U1 = '5a5a5a5a-0000-4000-8000-000000000001';
const U2 = '5a5a5a5a-0000-4000-8000-000000000002';
const CMID = '6b6b6b6b-0000-4000-8000-000000000001';
const MESSAGE = '7c7c7c7c-0000-4000-8000-000000000001';
const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj');

let db: FakePostgrest;
let base: string;
let root: string;

beforeEach(async () => {
  db = new FakePostgrest();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'uploads-dispatch-')));
  const prepared = await prepareUploadsRoot(join(base, 'uploads'), base, []);
  if (!prepared.ok) throw new Error(prepared.detail);
  root = prepared.rootReal;
  await stored(U1, JPEG, 'image', 'image/jpeg', 'jpg');
  await stored(U2, PDF, 'document', 'application/pdf', 'pdf');
  for (const [i, c] of claimRowsFor({
    threadId: THREAD,
    clientMessageId: CMID,
    userId: ADA,
    content: 'Two files',
    uploadIds: [U1, U2],
    createdAt: new Date(NOW - 60_000).toISOString(),
  }).entries()) {
    const { claim_gate: _g, ...fields } = c;
    db.seed('thread_upload_claims', {
      ...fields,
      message_id: i === 0 ? MESSAGE : null,
      held_reason: null,
    });
  }
});

afterEach(() => {
  const open = (dir: string) => {
    if (!existsSync(dir)) return;
    chmodSync(dir, 0o700);
    for (const e of readdirSync(dir, { withFileTypes: true }))
      if (e.isDirectory()) open(join(dir, e.name));
  };
  open(base);
  rmSync(base, { recursive: true, force: true });
});

async function stored(
  id: string,
  bytes: Buffer,
  kind: string,
  contentType: string,
  ext: 'jpg' | 'pdf'
) {
  await writeUploadFile(root, { userId: ADA, workspaceId: WS, uploadId: id, ext }, bytes);
  db.seed('thread_uploads', {
    id,
    user_id: ADA,
    workspace_id: WS,
    thread_id: THREAD,
    kind,
    content_type: contentType,
    byte_size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    state: 'live',
    claim_gate: 'open',
    damaged_at: null,
    created_at: new Date(NOW - 120_000).toISOString(),
  });
}

const message = (over: Partial<StoredThreadMessage> = {}): StoredThreadMessage => ({
  id: MESSAGE,
  thread_id: THREAD,
  sender_kind: 'user',
  sender_user_id: ADA,
  content: 'Two files',
  metadata: { clientMessageId: CMID, media: [{ upload: U2 }, { upload: U1 }] },
  ...over,
});
const resolve = (m: StoredThreadMessage, over = {}) =>
  resolveUploadMedia(db as never, m, { root, now: () => NOW, ...over });
const loc = (id: string, ext: 'jpg' | 'pdf') => ({
  userId: ADA,
  workspaceId: WS,
  uploadId: id,
  ext,
});

describe('resolveUploadMedia', () => {
  it('hands on the original files of the committed message, typed from the row', async () => {
    expect(await resolve(message())).toEqual([
      {
        type: 'image',
        path: uploadFilePath(root, loc(U1, 'jpg')),
        mimeType: 'image/jpeg',
        filename: `${U1}.jpg`,
      },
      {
        type: 'document',
        path: uploadFilePath(root, loc(U2, 'pdf')),
        mimeType: 'application/pdf',
        filename: `${U2}.pdf`,
      },
    ]);
  });

  it('attaches nothing for a message that is not the claim’s: an SB, another person, other words or another id', async () => {
    for (const forged of [
      message({ sender_kind: 'sb', sender_user_id: null }),
      message({ sender_kind: 'sb' }),
      message({ sender_user_id: SAM }),
      message({ content: 'Edited' }),
      message({ metadata: { clientMessageId: MESSAGE, media: [{ upload: U1 }, { upload: U2 }] } }),
      message({ metadata: { clientMessageId: CMID, media: [{ upload: U1 }] } }),
    ]) {
      expect(await resolve(forged)).toEqual([]);
    }
  });

  it('drops a file whose bytes changed and marks it damaged, keeping the rest', async () => {
    const dir = uploadDirPath(root, loc(U1, 'jpg'))!;
    chmodSync(dir, 0o700);
    chmodSync(join(dir, `${U1}.jpg`), 0o600);
    writeFileSync(join(dir, `${U1}.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    const out = await resolve(message());
    expect(out.map((a) => a.filename)).toEqual([`${U2}.pdf`]);
    expect(db.rows('thread_uploads').find((r: Row) => r.id === U1)!.damaged_at).toBe(
      new Date(NOW).toISOString()
    );
  });

  it('attaches nothing when uploads are off or the media list is malformed', async () => {
    expect(await resolve(message(), { root: null })).toEqual([]);
    expect(
      await resolve(message({ metadata: { clientMessageId: CMID, media: [{ upload: '../x' }] } }))
    ).toEqual([]);
    expect(await resolve(message({ metadata: { clientMessageId: CMID } }))).toEqual([]);
  });

  it('drops an upload that has ended or whose lookup fails', async () => {
    db.rows('thread_uploads').find((r: Row) => r.id === U2)!.state = 'removing';
    expect((await resolve(message())).map((a) => a.filename)).toEqual([`${U1}.jpg`]);
    const failing = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'down' } }) }),
        }),
      }),
    };
    expect(await resolveUploadMedia(failing as never, message(), { root, now: () => NOW })).toEqual(
      []
    );
  });
});
