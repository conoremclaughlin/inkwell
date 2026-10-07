/**
 * One uploads maintenance pass, over FakePostgrest and a real temporary
 * uploads root. The gate's foreign key (a sweep cannot close a claimed
 * upload's gate) is PostgreSQL behaviour, proved against a disposable cluster
 * separately; here the claim is seen before the close is tried.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  chmodSync,
  readdirSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FakePostgrest, type Row } from '../../test/fake-postgrest';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  maintainUploads,
  MAINTENANCE_BATCH,
  newMaintenanceCursors,
  uploadsMaintenanceEnabled,
  type MaintenanceDeps,
} from './maintenance';
import { writeUploadFile, type RemoveUploadResult } from './files';
import { prepareUploadsRoot, uploadDirPath, type UploadLocation } from './layout';
import { claimRowsFor } from './claims';

const ADA = '0a0a0a0a-0000-4000-8000-0000000000aa';
const WS = '1c1c1c1c-0000-4000-8000-0000000000cc';
const THREAD = '2e2e2e2e-0000-4000-8000-0000000000ee';
const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

let db: FakePostgrest;
let base: string;
let root: string;
let n = 0;

beforeEach(async () => {
  db = new FakePostgrest();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'uploads-maintenance-')));
  const prepared = await prepareUploadsRoot(join(base, 'uploads'), base, []);
  if (!prepared.ok) throw new Error(prepared.detail);
  root = prepared.rootReal;
  // The server's cwd: a temporary directory that is no git checkout, so the
  // worktree auto-disable is off until a test puts a worktree's .git there.
  vi.spyOn(process, 'cwd').mockReturnValue(base);
});

afterEach(() => {
  vi.restoreAllMocks();
  const open = (dir: string) => {
    if (!existsSync(dir)) return;
    chmodSync(dir, 0o700);
    for (const e of readdirSync(dir, { withFileTypes: true }))
      if (e.isDirectory()) open(join(dir, e.name));
  };
  open(base);
  rmSync(base, { recursive: true, force: true });
});

const deps = (over: Partial<MaintenanceDeps> = {}): MaintenanceDeps => ({
  db: db as never,
  root,
  now: () => NOW,
  env: {},
  ...over,
});

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
    pending_slot: n,
    account_slot: n,
    global_slot: n,
    created_at: new Date(NOW - 2 * HOUR).toISOString(),
    ...over,
  });
  if (write) await writeUploadFile(root, loc(row), JPEG);
  return row;
}
const loc = (row: Row): UploadLocation => ({
  userId: ADA,
  workspaceId: WS,
  uploadId: String(row.id),
  ext: 'jpg',
});
const bytesExist = (row: Row) => existsSync(uploadDirPath(root, loc(row))!);

function claim(row: Row, over: Row = {}): Row {
  const [c] = claimRowsFor({
    threadId: THREAD,
    clientMessageId: '6b6b6b6b-0000-4000-8000-000000000001',
    userId: ADA,
    content: 'Here',
    uploadIds: [String(row.id)],
    createdAt: new Date(NOW - HOUR).toISOString(),
  });
  const { claim_gate: _g, ...fields } = c;
  return db.seed('thread_upload_claims', {
    ...fields,
    message_id: null,
    held_reason: null,
    ...over,
  });
}

describe('when maintenance runs', () => {
  it('runs exactly where reminder processing runs', () => {
    expect(uploadsMaintenanceEnabled({})).toBe(true);
    for (const env of [
      { ENABLE_HEARTBEATS: 'false' },
      { ENABLE_REMINDERS: '0' },
      { ENABLE_HEARTBEAT_SERVICE: 'off' },
    ]) {
      expect(uploadsMaintenanceEnabled(env)).toBe(false);
    }
  });

  it('touches nothing on an isolated server, a worktree, or with uploads off', async () => {
    await upload({ claim_gate: 'open' });
    for (const env of [{ ENABLE_HEARTBEATS: 'false' }, { ENABLE_REMINDERS: 'no' }]) {
      db.log.length = 0;
      expect(await maintainUploads(deps({ env }))).toMatchObject({ skipped: 'heartbeats-off' });
      expect(db.log).toEqual([]);
    }
    // A worktree server: auto-disabled unless explicitly enabled.
    writeFileSync(join(base, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
    db.log.length = 0;
    expect(await maintainUploads(deps())).toMatchObject({ skipped: 'heartbeats-off' });
    expect(db.log).toEqual([]);
    expect(
      (await maintainUploads(deps({ env: { ENABLE_HEARTBEATS: 'true' } }))).skipped
    ).toBeUndefined();
    rmSync(join(base, '.git'));
    expect(await maintainUploads(deps({ root: null }))).toMatchObject({ skipped: 'uploads-off' });
  });
});

describe('the sweep', () => {
  it('removes an unclaimed upload an hour after it was written, freeing its slots', async () => {
    const old = await upload();
    const young = await upload({ created_at: new Date(NOW - HOUR + 1000).toISOString() });
    const report = await maintainUploads(deps());
    expect(report.orphansRemoved).toBe(1);
    expect(old).toMatchObject({ claim_gate: 'closed', state: 'removed', end_reason: 'orphan' });
    expect(bytesExist(old)).toBe(false);
    expect(young).toMatchObject({ claim_gate: 'open', state: 'live' });
    expect(bytesExist(young)).toBe(true);
  });

  it('never touches a receiving upload on age: its writer may still publish', async () => {
    const receiving = await upload({
      claim_gate: 'receiving',
      created_at: new Date(NOW - 48 * HOUR).toISOString(),
    });
    const report = await maintainUploads(deps());
    expect(report.receivingHeld).toBe(1);
    expect(receiving).toMatchObject({
      claim_gate: 'receiving',
      state: 'live',
      pending_slot: receiving.pending_slot,
    });
    expect(bytesExist(receiving)).toBe(true);
  });

  it('never removes a claimed upload, and releases the pending slot its send left', async () => {
    const claimed = await upload();
    claim(claimed);
    const report = await maintainUploads(deps());
    expect(report).toMatchObject({ orphansRemoved: 0, pendingReleased: 1 });
    expect(claimed).toMatchObject({ state: 'live', claim_gate: 'open', pending_slot: null });
    expect(bytesExist(claimed)).toBe(true);
  });

  it('keeps a row removing, holding its slots, until its bytes are confirmed gone', async () => {
    const row = await upload({
      state: 'removing',
      end_reason: 'orphan',
      ended_at: new Date(NOW).toISOString(),
    });
    const stuck = async (): Promise<RemoveUploadResult> => ({ gone: false, reason: 'failed' });
    expect(await maintainUploads(deps({ remove: stuck }))).toMatchObject({
      removalsStuck: 1,
      removalsFinished: 0,
    });
    expect(row.state).toBe('removing');
    expect(await maintainUploads(deps())).toMatchObject({ removalsFinished: 1 });
    expect(row).toMatchObject({ state: 'removed', removed_at: new Date(NOW).toISOString() });
    expect(bytesExist(row)).toBe(false);
  });
});

describe('the reconciler', () => {
  function storeMessage(over: Row = {}): Row {
    return db.seed('inbox_thread_messages', {
      thread_id: THREAD,
      sender_kind: 'user',
      sender_user_id: ADA,
      content: 'Here',
      metadata: { clientMessageId: '6b6b6b6b-0000-4000-8000-000000000001', media: [] },
      ...over,
    });
  }

  it('confirms a claim whose committed message matches it', async () => {
    const row = await upload({ pending_slot: null });
    const c = claim(row);
    const message = storeMessage({
      metadata: { clientMessageId: c.client_message_id, media: [{ upload: row.id }] },
    });
    expect(await maintainUploads(deps())).toMatchObject({ confirmed: 1 });
    expect(c.message_id).toBe(message.id);
  });

  it('holds, never deletes, a claim with no message or a mismatched one, and records it once', async () => {
    const missing = claim(await upload({ pending_slot: null }));
    expect(await maintainUploads(deps())).toMatchObject({ held: 1 });
    expect(missing).toMatchObject({
      held_reason: 'not_found',
      held_at: new Date(NOW).toISOString(),
    });
    expect(await maintainUploads(deps({ now: () => NOW + HOUR }))).toMatchObject({ held: 0 });
    expect(missing.held_at).toBe(new Date(NOW).toISOString());
    // The message names other words: a mismatch.
    storeMessage({
      content: 'Other words',
      metadata: { clientMessageId: missing.client_message_id, media: [] },
    });
    expect(await maintainUploads(deps())).toMatchObject({ held: 1 });
    expect(missing.held_reason).toBe('mismatch');
    expect(db.rows('thread_uploads').every((u) => u.state === 'live')).toBe(true);
  });

  it('changes nothing when the read fails or the claim is too young', async () => {
    const failing = claim(await upload({ pending_slot: null }));
    const young = claim(await upload({ pending_slot: null }), {
      client_message_id: '6b6b6b6b-0000-4000-8000-000000000002',
      created_at: new Date(NOW - 60_000).toISOString(),
    });
    const from = db.from.bind(db);
    const flaky = {
      from: (table: string) => {
        const query = from(table);
        if (table !== 'inbox_thread_messages') return query;
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'down' } }) }),
            }),
          }),
        };
      },
    };
    const report = await maintainUploads(deps({ db: flaky as never }));
    expect(report).toMatchObject({ readFailed: 1, held: 0, confirmed: 0 });
    expect(failing.held_reason).toBeNull();
    expect(young.held_reason).toBeNull();
  });
});

describe('fair progress past rows that stay put', () => {
  const id = (i: number) => `6c6c6c6c-0000-4000-8000-${String(i).padStart(12, '0')}`;

  it('reaches an orphan behind a full page of held receiving rows, and never touches them', async () => {
    for (let i = 0; i < MAINTENANCE_BATCH; i++) {
      await upload(
        {
          id: id(i),
          claim_gate: 'receiving',
          user_id: `0a0a0a0a-0000-4000-8000-${String(i).padStart(12, '0')}`,
        },
        false
      );
    }
    const orphan = await upload({ id: id(999) }, false);
    const cursors = newMaintenanceCursors();
    const report = await maintainUploads(deps({ cursors, remove: async () => ({ gone: true }) }));
    expect(orphan.state).toBe('removed');
    expect(report.receivingHeld).toBe(MAINTENANCE_BATCH);
    expect(
      db.rows('thread_uploads').filter((r) => r.claim_gate === 'receiving' && r.state === 'live')
    ).toHaveLength(MAINTENANCE_BATCH);
  });

  it('reaches an orphan behind a full page of open uploads too young to remove', async () => {
    for (let i = 0; i < MAINTENANCE_BATCH; i++) {
      await upload(
        {
          id: id(i),
          user_id: `0a0a0a0a-0000-4000-8000-${String(i).padStart(12, '0')}`,
          created_at: new Date(NOW - 60_000).toISOString(),
        },
        false
      );
    }
    const orphan = await upload({ id: id(999) }, false);
    const cursors = newMaintenanceCursors();
    const remove = async (): Promise<RemoveUploadResult> => ({ gone: true });
    await maintainUploads(deps({ cursors, remove }));
    await maintainUploads(deps({ cursors, remove }));
    expect(orphan.state).toBe('removed');
    expect(db.rows('thread_uploads').filter((r) => r.state === 'live')).toHaveLength(
      MAINTENANCE_BATCH
    );
  });

  it('reaches a removal behind a full page of stuck ones', async () => {
    const stuck = new Set<string>();
    for (let i = 0; i < MAINTENANCE_BATCH; i++) {
      const row = await upload(
        {
          id: id(i),
          state: 'removing',
          end_reason: 'orphan',
          ended_at: new Date(NOW).toISOString(),
        },
        false
      );
      stuck.add(String(row.id));
    }
    const last = await upload(
      {
        id: id(999),
        state: 'removing',
        end_reason: 'orphan',
        ended_at: new Date(NOW).toISOString(),
      },
      false
    );
    const remove = async (_root: string, l: UploadLocation): Promise<RemoveUploadResult> =>
      stuck.has(l.uploadId) ? { gone: false, reason: 'failed' } : { gone: true };
    const cursors = newMaintenanceCursors();
    await maintainUploads(deps({ cursors, remove }));
    expect(last.state).toBe('removing');
    await maintainUploads(deps({ cursors, remove }));
    expect(last.state).toBe('removed');
    expect(db.rows('thread_uploads').filter((r) => r.state === 'removing')).toHaveLength(
      MAINTENANCE_BATCH
    );
  });

  it('reaches a claim to confirm behind a full page of held ones', async () => {
    for (let i = 0; i < MAINTENANCE_BATCH; i++) {
      const row = await upload({ id: id(i), pending_slot: null }, false);
      claim(row, {
        client_message_id: `6b6b6b6b-0000-4000-8000-${String(i).padStart(12, '0')}`,
        held_reason: 'not_found',
        held_at: new Date(NOW).toISOString(),
      });
    }
    const row = await upload({ id: id(999), pending_slot: null }, false);
    const c = claim(row);
    db.seed('inbox_thread_messages', {
      thread_id: THREAD,
      sender_kind: 'user',
      sender_user_id: ADA,
      content: 'Here',
      metadata: { clientMessageId: c.client_message_id, media: [{ upload: row.id }] },
    });
    const cursors = newMaintenanceCursors();
    await maintainUploads(deps({ cursors }));
    await maintainUploads(deps({ cursors }));
    expect(c.message_id).toBeTruthy();
  });
});
