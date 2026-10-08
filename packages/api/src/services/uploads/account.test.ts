/**
 * Removing an account's uploads, over FakePostgrest and a real temporary
 * uploads root. The claim's foreign key (a claimed upload's gate cannot be
 * closed) is PostgreSQL behaviour, proved against a disposable cluster
 * separately; this module removes a claimed upload either way.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FakePostgrest, type Row } from '../../test/fake-postgrest';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  eraseAccountUploadRecords,
  removeAccountUploads,
  type AccountRemovalDeps,
} from './account';
import { removeAccountFolder, writeUploadFile, type RemoveUploadResult } from './files';
import { prepareUploadsRoot, uploadDirPath, type UploadLocation } from './layout';
import { claimRowsFor } from './claims';

const ADA = '0a0a0a0a-0000-4000-8000-0000000000aa';
const BEA = '0b0b0b0b-0000-4000-8000-0000000000bb';
const WS = '1c1c1c1c-0000-4000-8000-0000000000cc';
const THREAD = '2e2e2e2e-0000-4000-8000-0000000000ee';
const NOW = Date.parse('2026-10-07T23:30:00.000Z');
const MINUTE = 60 * 1000;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

let db: FakePostgrest;
let base: string;
let root: string;
let n = 0;

beforeEach(async () => {
  db = new FakePostgrest();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'uploads-account-')));
  const prepared = await prepareUploadsRoot(join(base, 'uploads'), base, []);
  if (!prepared.ok) throw new Error(prepared.detail);
  root = prepared.rootReal;
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

const deps = (over: Partial<AccountRemovalDeps> = {}): AccountRemovalDeps => ({
  db: db as never,
  root,
  now: () => NOW,
  drained: () => true,
  ...over,
});

const loc = (row: Row): UploadLocation => ({
  userId: String(row.user_id),
  workspaceId: WS,
  uploadId: String(row.id),
  ext: 'jpg',
});
const bytesExist = (row: Row) => existsSync(uploadDirPath(root, loc(row))!);
const rowOf = (row: Row) => db.rows('thread_uploads').find((r) => r.id === row.id)!;

async function upload(over: Row = {}, write = true): Promise<Row> {
  const id = `5a5a5a5a-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const row = db.seed('thread_uploads', {
    id,
    user_id: ADA,
    workspace_id: WS,
    thread_id: THREAD,
    content_type: 'image/jpeg',
    state: 'live',
    claim_gate: 'open',
    end_reason: null,
    ended_at: null,
    removed_at: null,
    pending_slot: null,
    account_slot: n,
    global_slot: n,
    created_at: new Date(NOW - 60 * MINUTE).toISOString(),
    ...over,
  });
  if (write) await writeUploadFile(root, loc(row), JPEG);
  return row;
}

function claim(row: Row): Row {
  const [c] = claimRowsFor({
    threadId: THREAD,
    clientMessageId: `6b6b6b6b-0000-4000-8000-${String(n).padStart(12, '0')}`,
    userId: String(row.user_id),
    content: 'Here',
    uploadIds: [String(row.id)],
    createdAt: new Date(NOW - 50 * MINUTE).toISOString(),
  });
  const { claim_gate: _g, ...fields } = c;
  return db.seed('thread_upload_claims', {
    ...fields,
    message_id: null,
    held_reason: null,
    held_at: null,
  });
}

describe('removeAccountUploads', () => {
  it('removes every kind of row the account holds, then its folder', async () => {
    const pending = await upload();
    const claimed = await upload();
    claim(claimed);
    const removing = await upload({
      state: 'removing',
      end_reason: 'orphan',
      ended_at: new Date(NOW - MINUTE).toISOString(),
    });
    const oldClosed = await upload({ claim_gate: 'closed' });
    const done = await upload(
      {
        state: 'removed',
        end_reason: 'orphan',
        ended_at: new Date(NOW).toISOString(),
        removed_at: new Date(NOW).toISOString(),
      },
      false
    );

    const report = await removeAccountUploads(deps(), ADA);

    expect(report).toEqual({
      complete: true,
      removed: 4,
      stuck: 0,
      folder: { gone: true },
    });
    // The open, unclaimed one had its gate closed first, against a send claiming it.
    expect(rowOf(pending).claim_gate).toBe('closed');
    for (const row of [pending, claimed, oldClosed]) {
      expect(rowOf(row)).toMatchObject({
        state: 'removed',
        end_reason: 'account_deleted',
        removed_at: new Date(NOW).toISOString(),
      });
      expect(bytesExist(row)).toBe(false);
    }
    // One already removing keeps the reason it was given.
    expect(rowOf(removing)).toMatchObject({ state: 'removed', end_reason: 'orphan' });
    expect(rowOf(done)).toMatchObject({ state: 'removed', end_reason: 'orphan' });
    expect(existsSync(join(root, ADA))).toBe(false);
  });

  it("closes a receiving row's gate and removes it: once drained, nothing is still writing it", async () => {
    const abandoned = await upload({
      claim_gate: 'receiving',
      created_at: new Date(NOW - MINUTE).toISOString(),
    });

    const report = await removeAccountUploads(deps(), ADA);
    expect(report).toEqual({ complete: true, removed: 1, stuck: 0, folder: { gone: true } });
    expect(rowOf(abandoned)).toMatchObject({
      state: 'removed',
      claim_gate: 'closed',
      end_reason: 'account_deleted',
    });
    expect(bytesExist(abandoned)).toBe(false);
  });

  it('refuses while the account has not drained, touching nothing', async () => {
    const row = await upload({ claim_gate: 'receiving' });
    const asked: string[] = [];
    const report = await removeAccountUploads(
      deps({
        drained: (userId) => {
          asked.push(userId);
          return false;
        },
      }),
      ADA
    );
    expect(report).toEqual({
      complete: false,
      removed: 0,
      stuck: 0,
      refused: 'account-not-drained',
    });
    expect(asked).toEqual([ADA]);
    expect(rowOf(row)).toMatchObject({ state: 'live', claim_gate: 'receiving' });
    expect(bytesExist(row)).toBe(true);
    expect(existsSync(join(root, ADA))).toBe(true);
  });

  it("leaves another account's uploads and folder alone", async () => {
    const mine = await upload();
    const theirs = await upload({ user_id: BEA });
    claim(theirs);

    expect(await removeAccountUploads(deps(), ADA)).toMatchObject({ complete: true, removed: 1 });
    expect(rowOf(mine).state).toBe('removed');
    expect(rowOf(theirs)).toMatchObject({ state: 'live', claim_gate: 'open', end_reason: null });
    expect(bytesExist(theirs)).toBe(true);
    expect(existsSync(join(root, BEA))).toBe(true);
  });

  it('keeps a row removing, and the folder, while its bytes cannot be confirmed gone', async () => {
    const row = await upload();
    const failing = async (): Promise<RemoveUploadResult> => ({
      gone: false,
      reason: 'failed',
      detail: 'synthetic',
    });

    const first = await removeAccountUploads(deps({ remove: failing }), ADA);
    expect(first).toEqual({ complete: false, removed: 0, stuck: 1 });
    expect(rowOf(row)).toMatchObject({ state: 'removing', end_reason: 'account_deleted' });
    expect(existsSync(join(root, ADA))).toBe(true);

    expect(await removeAccountUploads(deps(), ADA)).toMatchObject({ complete: true, removed: 1 });
    expect(rowOf(row).state).toBe('removed');
  });

  it('is not complete while the folder will not go', async () => {
    await upload();
    const report = await removeAccountUploads(
      deps({ removeFolder: async () => ({ gone: false, reason: 'failed', detail: 'synthetic' }) }),
      ADA
    );
    expect(report).toEqual({
      complete: false,
      removed: 1,
      stuck: 0,
      folder: { gone: false, reason: 'failed', detail: 'synthetic' },
    });
  });

  it('does not remove the folder while a row written since the first read holds bytes', async () => {
    await upload();
    let reads = 0;
    const real = db.from.bind(db);
    const spy = vi.spyOn(db, 'from').mockImplementation((table: string) => {
      // The second read of the account's rows, just before the folder would go.
      if (table === 'thread_uploads' && ++reads === 2) {
        db.seed('thread_uploads', {
          id: '5a5a5a5a-0000-4000-8000-0000000000ff',
          user_id: ADA,
          workspace_id: WS,
          thread_id: THREAD,
          content_type: 'image/jpeg',
          state: 'live',
          claim_gate: 'receiving',
          account_slot: 49,
          global_slot: 999,
          created_at: new Date(NOW).toISOString(),
        });
      }
      return real(table);
    });
    const folder = vi.fn(removeAccountFolder);
    try {
      const report = await removeAccountUploads(deps({ removeFolder: folder }), ADA);
      expect(report).toMatchObject({ complete: false, removed: 1 });
      expect(report.folder).toBeUndefined();
      expect(folder).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses an id that is not canonical, and a server with uploads off, touching nothing', async () => {
    const row = await upload();
    expect(await removeAccountUploads(deps(), ADA.toUpperCase())).toEqual({
      complete: false,
      removed: 0,
      stuck: 0,
      refused: 'bad-account',
    });
    expect(await removeAccountUploads(deps({ root: null }), ADA)).toEqual({
      complete: false,
      removed: 0,
      stuck: 0,
      refused: 'uploads-off',
    });
    expect(rowOf(row).state).toBe('live');
    expect(bytesExist(row)).toBe(true);
  });

  it('completes an account with nothing to remove, and no folder', async () => {
    expect(await removeAccountUploads(deps(), ADA)).toEqual({
      complete: true,
      removed: 0,
      stuck: 0,
      folder: { gone: true },
    });
  });
});

describe('removeAccountFolder', () => {
  it('removes bytes no row names, and its emptied directories, with the account', async () => {
    const stray = join(root, ADA, WS, 'not-a-row');
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, 'left.jpg'), JPEG);
    chmodSync(stray, 0o500);
    expect(await removeAccountFolder(root, ADA)).toEqual({ gone: true });
    expect(existsSync(join(root, ADA))).toBe(false);
  });

  it('removes a link inside as a link, never what it points at', async () => {
    const outside = join(base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    mkdirSync(join(root, ADA, WS), { recursive: true });
    symlinkSync(outside, join(root, ADA, WS, 'link'));
    expect(await removeAccountFolder(root, ADA)).toEqual({ gone: true });
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  });

  it('refuses a folder that is itself a link, and leaves its target', async () => {
    const outside = join(base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    symlinkSync(outside, join(root, ADA));
    expect(await removeAccountFolder(root, ADA)).toEqual({ gone: false, reason: 'symlinked' });
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  });

  it('refuses an id that is not canonical', async () => {
    for (const id of ['..', '', 'ADA', `${ADA}/..`]) {
      expect(await removeAccountFolder(root, id), id).toEqual({
        gone: false,
        reason: 'bad-account',
      });
    }
  });

  it('is gone when there was nothing to remove', async () => {
    expect(await removeAccountFolder(root, ADA)).toEqual({ gone: true });
  });
});

describe('eraseAccountUploadRecords', () => {
  it('erases nothing while any row still holds bytes', async () => {
    const row = await upload();
    claim(row);
    expect(await eraseAccountUploadRecords(db as never, ADA)).toEqual({
      erased: false,
      claims: 0,
      uploads: 0,
    });
    expect(db.rows('thread_uploads')).toHaveLength(1);
    expect(db.rows('thread_upload_claims')).toHaveLength(1);
  });

  it("deletes the account's claims and removed rows once all are removed, and no one else's", async () => {
    const mine = await upload();
    claim(mine);
    const theirs = await upload({ user_id: BEA });
    claim(theirs);
    expect(await removeAccountUploads(deps(), ADA)).toMatchObject({ complete: true });

    expect(await eraseAccountUploadRecords(db as never, ADA)).toEqual({
      erased: true,
      claims: 1,
      uploads: 1,
    });
    expect(db.rows('thread_uploads').map((r) => r.user_id)).toEqual([BEA]);
    expect(db.rows('thread_upload_claims').map((r) => r.user_id)).toEqual([BEA]);
  });

  it('never deletes a row that holds bytes, even one written after its check', async () => {
    await upload();
    expect(await removeAccountUploads(deps(), ADA)).toMatchObject({ complete: true });
    let reads = 0;
    const real = db.from.bind(db);
    const spy = vi.spyOn(db, 'from').mockImplementation((table: string) => {
      // The second use of thread_uploads is the delete, after the check.
      if (table === 'thread_uploads' && ++reads === 2) {
        db.seed('thread_uploads', {
          id: '5a5a5a5a-0000-4000-8000-0000000000fe',
          user_id: ADA,
          workspace_id: WS,
          thread_id: THREAD,
          content_type: 'image/jpeg',
          state: 'live',
          claim_gate: 'receiving',
          account_slot: 48,
          global_slot: 998,
          created_at: new Date(NOW).toISOString(),
        });
      }
      return real(table);
    });
    try {
      expect(await eraseAccountUploadRecords(db as never, ADA)).toEqual({
        erased: true,
        claims: 0,
        uploads: 1,
      });
    } finally {
      spy.mockRestore();
    }
    expect(db.rows('thread_uploads').map((r) => [r.id, r.state])).toEqual([
      ['5a5a5a5a-0000-4000-8000-0000000000fe', 'live'],
    ]);
  });

  it('refuses an id that is not canonical', async () => {
    expect(await eraseAccountUploadRecords(db as never, 'nope')).toEqual({
      erased: false,
      claims: 0,
      uploads: 0,
    });
  });
});
