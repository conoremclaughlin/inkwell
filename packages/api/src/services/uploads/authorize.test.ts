import { describe, expect, it } from 'vitest';
import {
  authorizeUpload,
  PENDING_TTL_MS,
  type UploadAccess,
  type UploadAuthInput,
  type UploadRow,
} from './authorize.js';
import { claimRowsFor, type StoredClaim, type StoredThreadMessage } from './claims.js';

const UP = '0a0a0a0a-0000-4000-8000-00000000000a';
const OTHER_UP = '0b0b0b0b-0000-4000-8000-00000000000b';
const THREAD = '1a1a1a1a-0000-4000-8000-000000000001';
const OTHER_THREAD = '1b1b1b1b-0000-4000-8000-000000000002';
const SEND = '2b2b2b2b-0000-4000-8000-000000000002';
const WS = '6f6f6f6f-0000-4000-8000-000000000006';
const OTHER_WS = '6e6e6e6e-0000-4000-8000-000000000007';
const ADA = '3c3c3c3c-0000-4000-8000-000000000003';
const SAM = '4d4d4d4d-0000-4000-8000-000000000004';
const MESSAGE = '5e5e5e5e-0000-4000-8000-000000000005';
const CREATED = Date.parse('2026-10-07T09:00:00.000Z');

const upload: UploadRow = {
  id: UP,
  user_id: ADA,
  workspace_id: WS,
  thread_id: THREAD,
  state: 'live',
  claim_gate: 'open',
  damaged_at: null,
  created_at: new Date(CREATED).toISOString(),
};

const [claimRow] = claimRowsFor({
  threadId: THREAD,
  clientMessageId: SEND,
  userId: ADA,
  content: 'The lease',
  uploadIds: [UP],
  createdAt: new Date(CREATED + 60_000).toISOString(),
});
const { claim_gate: _gate, ...claimFields } = claimRow;
const claim: StoredClaim = {
  ...claimFields,
  message_id: null,
  held_reason: null,
  created_at: new Date(CREATED + 60_000).toISOString(),
};

const committed: StoredThreadMessage = {
  id: MESSAGE,
  thread_id: THREAD,
  sender_kind: 'user',
  sender_user_id: ADA,
  content: 'The lease',
  metadata: { clientMessageId: SEND, media: [{ upload: UP }] },
};

const read = (over: Partial<Extract<UploadAccess, { kind: 'read' }>> = {}): UploadAccess => ({
  kind: 'read',
  userId: SAM,
  workspaceId: WS,
  isPersonParticipant: true,
  ...over,
});

const now = CREATED + 2 * 60_000;
// No retention policy has been chosen, so the default here is none.
const decide = (over: Partial<UploadAuthInput>) =>
  authorizeUpload({
    upload,
    claim,
    message: committed,
    access: read(),
    now,
    retentionMs: null,
    ...over,
  });

describe('authorizeUpload: reads', () => {
  it('lets a current person participant read an upload on a committed message', () => {
    expect(decide({})).toEqual({ ok: true });
    expect(decide({ access: read({ userId: ADA }) })).toEqual({ ok: true });
  });

  it('refuses someone no longer in the thread, the uploader included', () => {
    expect(decide({ access: read({ isPersonParticipant: false }) })).toEqual({
      ok: false,
      reason: 'not-yours',
    });
    expect(decide({ access: read({ userId: ADA, isPersonParticipant: false }) })).toEqual({
      ok: false,
      reason: 'not-yours',
    });
  });

  it('refuses a reader from another workspace', () => {
    expect(decide({ access: read({ workspaceId: OTHER_WS }) })).toEqual({
      ok: false,
      reason: 'not-yours',
    });
  });

  it('before a message commits, lets only the uploader read it', () => {
    for (const state of [
      { claim: null, message: null },
      { claim, message: null },
      { claim: { ...claim, held_reason: 'not_found' as const }, message: null },
    ]) {
      expect(decide({ ...state, access: read({ userId: ADA }) })).toEqual({ ok: true });
      expect(decide({ ...state })).toEqual({ ok: false, reason: 'not-committed' });
    }
  });

  it('takes nothing from a message someone else wrote naming the upload', () => {
    for (const forged of [
      { ...committed, sender_kind: 'sb', sender_user_id: null },
      // An SB's row is never the person's send, even one carrying their user id.
      { ...committed, sender_kind: 'sb' },
      { ...committed, sender_user_id: SAM },
      { ...committed, metadata: { clientMessageId: MESSAGE, media: [{ upload: UP }] } },
      { ...committed, content: 'Other words' },
      {
        ...committed,
        metadata: { clientMessageId: SEND, media: [{ upload: UP }, { upload: OTHER_UP }] },
      },
    ]) {
      expect(decide({ message: forged })).toEqual({ ok: false, reason: 'not-committed' });
    }
  });

  it('takes nothing from a claim and message that are both someone else’s', () => {
    const [samRow] = claimRowsFor({
      threadId: THREAD,
      clientMessageId: SEND,
      userId: SAM,
      content: 'The lease',
      uploadIds: [UP],
      createdAt: new Date(CREATED + 60_000).toISOString(),
    });
    const { claim_gate: _g, ...samFields } = samRow;
    const samClaim: StoredClaim = { ...claim, ...samFields };
    const samMessage = { ...committed, sender_user_id: SAM };
    expect(decide({ claim: samClaim, message: samMessage })).toEqual({
      ok: false,
      reason: 'not-committed',
    });
    expect(
      decide({
        claim: samClaim,
        message: samMessage,
        access: { kind: 'resolve', messageId: MESSAGE },
      })
    ).toEqual({ ok: false, reason: 'not-committed' });
  });

  it('refuses a claim or message from another thread than the upload’s', () => {
    expect(decide({ claim: { ...claim, thread_id: OTHER_THREAD } })).toEqual({
      ok: false,
      reason: 'not-yours',
    });
    expect(decide({ claim: { ...claim, upload_id: OTHER_UP } })).toEqual({
      ok: false,
      reason: 'not-yours',
    });
    expect(decide({ message: { ...committed, thread_id: OTHER_THREAD } })).toEqual({
      ok: false,
      reason: 'not-committed',
    });
  });

  it('does not depend on the confirm state', () => {
    expect(decide({ claim: { ...claim, message_id: MESSAGE } })).toEqual({ ok: true });
    expect(decide({ claim: { ...claim, message_id: null } })).toEqual({ ok: true });
  });
});

describe('authorizeUpload: state and time', () => {
  it('refuses gone, damaged and still-receiving uploads', () => {
    expect(decide({ upload: { ...upload, state: 'removing' } })).toEqual({
      ok: false,
      reason: 'gone',
    });
    expect(decide({ upload: { ...upload, state: 'removed' } })).toEqual({
      ok: false,
      reason: 'gone',
    });
    expect(decide({ upload: { ...upload, damaged_at: new Date(now).toISOString() } })).toEqual({
      ok: false,
      reason: 'damaged',
    });
    expect(
      decide({
        upload: { ...upload, claim_gate: 'receiving' },
        claim: null,
        access: read({ userId: ADA }),
      })
    ).toEqual({
      ok: false,
      reason: 'not-ready',
    });
  });

  it('never expires a claimed upload on its own while no retention is chosen', () => {
    const claimed = Date.parse(claim.created_at);
    const years = 10 * 365 * 24 * 60 * 60 * 1000;
    expect(decide({ now: claimed + years })).toEqual({ ok: true });
    const held = { ...claim, held_reason: 'not_found' as const };
    expect(
      decide({ claim: held, message: null, access: read({ userId: ADA }), now: claimed + years })
    ).toEqual({ ok: true });
  });

  it('expires at a chosen retention, counted from the claim, even if the sweep has not run', () => {
    const claimed = Date.parse(claim.created_at);
    const retentionMs = 30 * 24 * 60 * 60 * 1000;
    expect(decide({ retentionMs, now: claimed + retentionMs - 1 })).toEqual({ ok: true });
    expect(decide({ retentionMs, now: claimed + retentionMs })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('treats an unclaimed upload as an orphan after an hour, even for its uploader', () => {
    const preview = { claim: null, message: null, access: read({ userId: ADA }) };
    expect(decide({ ...preview, now: CREATED + PENDING_TTL_MS - 1 })).toEqual({ ok: true });
    expect(decide({ ...preview, now: CREATED + PENDING_TTL_MS })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('fails closed on an unreadable time', () => {
    expect(decide({ claim: { ...claim, created_at: 'later' } })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });
});

describe('authorizeUpload: dispatch', () => {
  it('attaches only for the committed message being delivered', () => {
    const resolve = (messageId: string) => decide({ access: { kind: 'resolve', messageId } });
    expect(resolve(MESSAGE)).toEqual({ ok: true });
    expect(resolve(OTHER_UP)).toEqual({ ok: false, reason: 'not-committed' });
    expect(decide({ message: null, access: { kind: 'resolve', messageId: MESSAGE } })).toEqual({
      ok: false,
      reason: 'not-committed',
    });
    expect(
      decide({
        message: { ...committed, sender_user_id: SAM },
        access: { kind: 'resolve', messageId: MESSAGE },
      })
    ).toEqual({ ok: false, reason: 'not-committed' });
  });
});
