/**
 * POST /threads/reply with `uploads`: the send claims its uploads as one set
 * before its message is stored, names them in metadata.media, and confirms
 * them once stored. Over the in-memory FakePostgrest with the real
 * (thread, clientMessageId) index and the claim table's two keys; the send
 * handler is a stand-in that stores through the same database. The claim
 * gate's foreign key and the all-or-nothing claim set are PostgreSQL
 * behaviour, proved against a disposable cluster separately.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createInklingDb } from '../test/fake-inkling-db';
import type { FakePostgrest, Row } from '../test/fake-postgrest';

const mockHandleSendToInbox = vi.fn();
vi.mock('../mcp/tools/inbox-handlers', () => ({
  handleSendToInbox: (...args: unknown[]) => mockHandleSendToInbox(...args),
}));
vi.mock('../mcp/tools/thread-handlers', () => ({
  getParticipants: vi.fn(async () => [{ sbId: 'sb-fern', sbSlug: 'fern', userId: null }]),
  participantSlugs: (ps: Array<{ sbId: string | null; sbSlug: string | null }>) =>
    ps.filter((p) => p.sbId).map((p) => p.sbSlug as string),
}));
vi.mock('../auth/ink-tokens', () => ({
  signInkAccessToken: vi.fn(),
  createRefreshToken: vi.fn(),
  exchangeRefreshToken: vi.fn(),
  verifyInkAccessToken: vi.fn(),
}));
let db: FakePostgrest;
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => db) }));
vi.mock('../data/composer', () => ({
  getDataComposer: vi.fn(async () => ({ repositories: {}, getClient: () => db })),
}));
vi.mock('../services/authorization', () => ({ getAuthorizationService: vi.fn(() => ({})) }));
vi.mock('../services/oauth', () => ({ getOAuthService: vi.fn(() => ({})) }));
vi.mock('../config/env', async () => ({
  env: {
    ...(await import('../test/fake-env.js')).fakeEnv,
    NODE_ENV: 'development',
    MCP_HTTP_PORT: 3001,
  },
  isDevelopment: () => true,
}));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/request-context', () => ({
  runWithRequestContext: (_context: Record<string, unknown>, fn: () => void) => fn(),
}));

import router from './admin';
import { CLIENT_MESSAGE_CONFLICT } from '../services/send-receipt';
import { manifestDigest } from '../services/uploads/claims';

type Handler = (req: Request, res: Response) => Promise<void>;
/* eslint-disable @typescript-eslint/no-explicit-any */
const reply: Handler = (() => {
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === '/threads/reply' && entry.route?.methods?.post
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
})();
/* eslint-enable @typescript-eslint/no-explicit-any */

const ADA = '0a0a0a0a-0000-4000-8000-0000000000aa';
const SAM = '0b0b0b0b-0000-4000-8000-0000000000bb';
const WS = '1c1c1c1c-0000-4000-8000-0000000000cc';
const KEY = 'inkling:dm:fern';
const U1 = '5a5a5a5a-0000-4000-8000-000000000001';
const U2 = '5a5a5a5a-0000-4000-8000-000000000002';
const UNFINISHED = '5a5a5a5a-0000-4000-8000-000000000003';
const CMID = '6b6b6b6b-0000-4000-8000-000000000001';

let thread: Row;
let refuseSend: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  db = createInklingDb();
  db.unique.thread_upload_claims = [
    { name: 'thread_upload_claims_pkey', key: (r) => String(r.upload_id) },
    {
      name: 'thread_upload_claims_send_key',
      key: (r) => `${r.thread_id}|${r.client_message_id}|${r.manifest_index}`,
    },
  ];
  thread = db.seed('inbox_threads', { thread_key: KEY, workspace_id: WS, created_by_user_id: ADA });
  for (const [id, gate] of [
    [U1, 'open'],
    [U2, 'open'],
    [UNFINISHED, 'receiving'],
  ]) {
    db.seed('thread_uploads', {
      id,
      user_id: ADA,
      workspace_id: WS,
      thread_id: thread.id,
      state: 'live',
      claim_gate: gate,
      pending_slot: 1,
      // The route stamps its attempt with the API clock: these were written
      // a minute earlier, well inside their pending hour.
      created_at: new Date(Date.now() - 60_000).toISOString(),
    });
  }
  refuseSend = false;
  // Stores like the real handler where this route can observe it: the
  // caller's metadata kept, and the index refusing a second copy of one
  // client message id.
  mockHandleSendToInbox.mockImplementation(
    async (
      args: Record<string, unknown>,
      _dc: unknown,
      internal: { sender: { principal: { userId: string } } }
    ) => {
      if (refuseSend) {
        return { content: [{ text: JSON.stringify({ success: false, error: 'refused' }) }] };
      }
      const { data, error } = await db
        .from('inbox_thread_messages')
        .insert({
          thread_id: thread.id,
          sender_kind: 'user',
          sender_user_id: internal.sender.principal.userId,
          content: args.content,
          metadata: args.metadata,
        })
        .select('id')
        .single();
      if (error) throw new Error(`Failed to send thread message: ${error.message}`);
      return {
        content: [
          {
            text: JSON.stringify({
              success: true,
              messageId: (data as Row).id,
              threadId: thread.id,
              triggered: ['fern'],
            }),
          },
        ],
      };
    }
  );
});

interface Sent {
  status: number;
  body: Record<string, unknown>;
}

async function send(body: Record<string, unknown>, userId = ADA): Promise<Sent> {
  const sent: Sent = { status: 200, body: {} };
  const res = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(payload: Record<string, unknown>) {
      sent.body = payload;
      return res;
    },
  };
  const req = {
    body,
    headers: {},
    cookies: {},
    params: {},
    inkUserId: userId,
    inkWorkspaceId: WS,
    inkWorkspaceRole: 'member',
  };
  await reply(req as unknown as Request, res as unknown as Response);
  return sent;
}

const messages = () => db.rows('inbox_thread_messages');
const claims = () => db.rows('thread_upload_claims');

describe('POST /threads/reply with uploads', () => {
  it('claims the set, stores the message naming it, then confirms the claims', async () => {
    const sent = await send({
      key: KEY,
      content: 'Receipts',
      clientMessageId: CMID,
      uploads: [U2, U1],
    });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ success: true, replayed: false });
    const [message] = messages();
    expect((message.metadata as Row).media).toEqual([{ upload: U1 }, { upload: U2 }]);
    expect(claims().map((c) => [c.upload_id, c.message_id, c.manifest_sha256])).toEqual([
      [U1, message.id, manifestDigest([U1, U2])],
      [U2, message.id, manifestDigest([U1, U2])],
    ]);
    expect(
      db
        .rows('thread_uploads')
        .filter((u) => u.pending_slot === null)
        .map((u) => u.id)
    ).toEqual([U1, U2]);
  });

  it('answers a retry of the same send with the original, and a retry naming other uploads with 409', async () => {
    const first = await send({
      key: KEY,
      content: 'Receipts',
      clientMessageId: CMID,
      uploads: [U1],
    });
    const again = await send({
      key: KEY,
      content: 'Receipts',
      clientMessageId: CMID,
      uploads: [U1],
    });
    expect(again.body).toMatchObject({ replayed: true, messageId: first.body.messageId });
    const other = await send({
      key: KEY,
      content: 'Receipts',
      clientMessageId: CMID,
      uploads: [U2],
    });
    expect(other).toEqual({ status: 409, body: { error: CLIENT_MESSAGE_CONFLICT } });
    // Dropping the uploads from the retry is a different send too.
    const none = await send({ key: KEY, content: 'Receipts', clientMessageId: CMID });
    expect(none.status).toBe(409);
    expect(messages()).toHaveLength(1);
    expect(claims().map((c) => c.upload_id)).toEqual([U1]);
  });

  it('refuses an upload that cannot be sent, storing nothing and claiming nothing', async () => {
    const sent = await send({
      key: KEY,
      content: 'Hi',
      clientMessageId: CMID,
      uploads: [U1, UNFINISHED],
    });
    expect(sent).toMatchObject({ status: 409, body: { code: 'uploads_unavailable' } });
    // Someone else's send cannot take Ada's uploads either.
    expect(
      (await send({ key: KEY, content: 'Hi', clientMessageId: CMID, uploads: [U1] }, SAM)).status
    ).toBe(409);
    expect(messages()).toHaveLength(0);
    expect(claims()).toHaveLength(0);
  });

  it('refuses a send naming no uploads under a key whose uploads were claimed', async () => {
    refuseSend = true;
    expect(
      (await send({ key: KEY, content: 'Hi', clientMessageId: CMID, uploads: [U1] })).status
    ).toBe(400);
    refuseSend = false;
    for (const body of [
      { key: KEY, content: 'Something else', clientMessageId: CMID },
      { key: KEY, content: 'Hi', clientMessageId: CMID, uploads: [] },
    ]) {
      expect(await send(body)).toEqual({ status: 409, body: { error: CLIENT_MESSAGE_CONFLICT } });
    }
    expect(messages()).toHaveLength(0);
    // The send that holds them can still go through on retry.
    expect(
      (await send({ key: KEY, content: 'Hi', clientMessageId: CMID, uploads: [U1] })).status
    ).toBe(200);
  });

  it('needs a client message id with uploads, and 1 to 4 different canonical ids', async () => {
    expect(await send({ key: KEY, content: 'Hi', uploads: [U1] })).toMatchObject({
      status: 400,
      body: { code: 'uploads_need_client_message_id' },
    });
    for (const uploads of [[U1, U1], [U1, U2, UNFINISHED, CMID, KEY], [U1.toUpperCase()], 'x']) {
      expect(await send({ key: KEY, content: 'Hi', clientMessageId: CMID, uploads })).toMatchObject(
        {
          status: 400,
          body: { code: 'uploads_invalid' },
        }
      );
    }
    expect(messages()).toHaveLength(0);
  });

  it('treats an empty list as no uploads', async () => {
    const sent = await send({ key: KEY, content: 'Hi', clientMessageId: CMID, uploads: [] });
    expect(sent.status).toBe(200);
    expect((messages()[0].metadata as Row).media).toBeUndefined();
    expect(claims()).toHaveLength(0);
  });

  it('keeps the claims, unconfirmed, when the send stores nothing', async () => {
    refuseSend = true;
    const sent = await send({ key: KEY, content: 'Hi', clientMessageId: CMID, uploads: [U1] });
    expect(sent.status).toBe(400);
    expect(claims()).toHaveLength(1);
    expect(claims()[0].message_id).toBeUndefined();
  });
});
