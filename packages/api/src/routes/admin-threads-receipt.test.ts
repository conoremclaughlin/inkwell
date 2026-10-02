/**
 * The send receipt on POST /threads and /threads/reply (contract v3 §4):
 * clientMessageId replay and a delivery status from positive evidence.
 *
 * The send handler is replaced by a stand-in that stores through the same
 * in-memory database the routes read (src/test/fake-postgrest.ts), with the
 * real (thread, clientMessageId) unique index, and records every wake it
 * would have dispatched. So "stored once" and "woken once" are counted, not
 * inferred from which function was called.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createInklingDb } from '../test/fake-inkling-db';
import type { FakePostgrest, Row } from '../test/fake-postgrest';
import { deliveryFromSendResult } from '../services/send-receipt';

const mockHandleSendToInbox = vi.fn();
const mockGetParticipants = vi.fn();
vi.mock('../mcp/tools/inbox-handlers', () => ({
  handleSendToInbox: (...args: unknown[]) => mockHandleSendToInbox(...args),
}));
vi.mock('../mcp/tools/thread-handlers', () => ({
  getParticipants: (...args: unknown[]) => mockGetParticipants(...args),
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
    ...(await import('../test/fake-env')).fakeEnv,
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

type Handler = (req: Request, res: Response) => Promise<void>;

function handler(path: string): Handler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.post
  );
  if (!layer) throw new Error(`POST ${path} not found in router stack`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const create = handler('/threads');
const reply = handler('/threads/reply');

const ME = 'user-1';
const WORKSPACE = 'ws-1';
const KEY = 'chat:conversation-5f0c';
const CMID = '6d1f8a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';

interface MockResponse extends Response {
  _status: number;
  _json: Record<string, unknown>;
}

function createReq(body: Record<string, unknown>, role = 'owner', userId = ME): Request {
  return {
    body,
    headers: {},
    cookies: {},
    params: {},
    inkUserId: userId,
    inkWorkspaceId: WORKSPACE,
    inkWorkspaceRole: role,
  } as unknown as Request;
}

function createRes(): MockResponse {
  const res: Record<string, unknown> = {
    _status: 200,
    _json: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(payload: unknown) {
      res._json = payload;
      return res;
    },
  };
  return res as unknown as MockResponse;
}

async function call(
  h: Handler,
  body: Record<string, unknown>,
  role?: string,
  userId?: string
): Promise<MockResponse> {
  const res = createRes();
  await h(createReq(body, role, userId), res);
  return res;
}

/** What the stand-in handler does on its next send. */
interface Script {
  recipients: string[];
  triggered: string[];
  routingFailures?: Array<{ sbSlug: string; error: string }>;
  extra?: Record<string, unknown>;
  /** Runs after the thread exists and before this send's store (a concurrent request). */
  beforeStore?: (thread: Row) => void;
  /** Fails after the store, before dispatch: a request that died mid-send. */
  failAfterStore?: boolean;
}

let script: Script;
let wakes: string[];

function stored(): Row[] {
  return db.rows('inbox_thread_messages');
}

function storeMessage(thread: Row, content: string, metadata: Row, userId = ME): Row {
  return db.seed('inbox_thread_messages', {
    thread_id: thread.id,
    sender_kind: 'user',
    sender_user_id: userId,
    content,
    metadata,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  db = createInklingDb();
  wakes = [];
  script = { recipients: ['wren', 'lumen'], triggered: ['wren', 'lumen'] };
  mockGetParticipants.mockResolvedValue([
    { sbId: 'sb-wren', sbSlug: 'wren', userId: null },
    { sbId: 'sb-lumen', sbSlug: 'lumen', userId: null },
  ]);
  mockHandleSendToInbox.mockImplementation(
    async (
      args: Record<string, unknown>,
      _dataComposer: unknown,
      internal: { sender: { principal: { userId: string }; workspaceId: string } }
    ) => {
      const workspaceId = internal.sender.workspaceId;
      let thread = db
        .rows('inbox_threads')
        .find((t) => t.thread_key === args.threadKey && t.workspace_id === workspaceId);
      thread ??= db.seed('inbox_threads', {
        thread_key: args.threadKey,
        workspace_id: workspaceId,
      });
      script.beforeStore?.(thread);

      const { data, error } = await db
        .from('inbox_thread_messages')
        .insert({
          thread_id: thread.id,
          sender_kind: 'user',
          sender_user_id: internal.sender.principal.userId,
          content: args.content,
          metadata: { ...(args.metadata as Row), pcp: { sender: { kind: 'user' } } },
        })
        .select('id')
        .single();
      // The real handler's wording: the violated index is named in it.
      if (error) throw new Error(`Failed to send thread message: ${error.message}`);
      if (script.failAfterStore) throw new Error('Failed to advance the read pointer');

      wakes.push(...script.triggered);
      const failures = script.routingFailures ?? [];
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: failures.length === 0,
              ...(failures.length > 0 ? { routingFailures: failures } : {}),
              messageId: (data as Row).id,
              threadId: thread.id,
              recipients: script.recipients,
              triggered: script.triggered,
              ...script.extra,
            }),
          },
        ],
      };
    }
  );
});

function seedThread(): Row {
  return db.seed('inbox_threads', { thread_key: KEY, workspace_id: WORKSPACE });
}

const createBody = (extra: Record<string, unknown> = {}) => ({
  key: KEY,
  recipients: ['wren', 'lumen'],
  content: 'hello both',
  ...extra,
});
const replyBody = (extra: Record<string, unknown> = {}) => ({
  key: KEY,
  content: 'one more thing',
  ...extra,
});

describe('clientMessageId replay', () => {
  it('create: a retry answers with the original message, stores nothing and wakes nobody', async () => {
    const first = await call(create, createBody({ clientMessageId: CMID }));
    expect(first._json).toMatchObject({ success: true, created: true, replayed: false });

    const retry = await call(create, createBody({ clientMessageId: CMID }));

    expect(retry._status).toBe(200);
    expect(retry._json).toMatchObject({
      success: true,
      created: false,
      messageId: first._json.messageId,
      threadId: first._json.threadId,
      threadKey: KEY,
      replayed: true,
      delivery: { status: 'routed', unrouted: [] },
    });
    expect(stored()).toHaveLength(1);
    expect(mockHandleSendToInbox).toHaveBeenCalledTimes(1);
    expect(wakes).toEqual(['wren', 'lumen']);
  });

  it('reply: a retry answers with the original message, stores nothing and wakes nobody', async () => {
    seedThread();
    const first = await call(reply, replyBody({ clientMessageId: CMID }));
    expect(first._json).toMatchObject({ success: true, replayed: false });

    const retry = await call(reply, replyBody({ clientMessageId: CMID }));

    expect(retry._json).toMatchObject({
      success: true,
      messageId: first._json.messageId,
      triggered: [],
      replayed: true,
      delivery: first._json.delivery,
    });
    expect(stored()).toHaveLength(1);
    // The pre-check answered; the index is only the backstop for a race.
    expect(mockHandleSendToInbox).toHaveBeenCalledTimes(1);
    expect(wakes).toEqual(['wren', 'lumen']);
  });

  it('the id is case-insensitive: an upper-cased retry is the same message', async () => {
    seedThread();
    const first = await call(reply, replyBody({ clientMessageId: CMID }));
    const retry = await call(reply, replyBody({ clientMessageId: CMID.toUpperCase() }));
    expect(retry._json).toMatchObject({ messageId: first._json.messageId, replayed: true });
  });

  for (const [label, route, body] of [
    ['create', create, createBody],
    ['reply', reply, replyBody],
  ] as const) {
    it(`${label}: a retry that lost the race to a concurrent copy answers with the winner and wakes nobody`, async () => {
      const thread = seedThread();
      let winner: Row | undefined;
      script.beforeStore = (t) => {
        // The concurrent request stores first; its dispatch has not finished.
        script.beforeStore = undefined;
        winner = storeMessage(t, String(body().content), {
          sentBy: 'user',
          clientMessageId: CMID,
        });
      };

      const res = await call(route, body({ clientMessageId: CMID }));

      expect(winner?.thread_id).toBe(thread.id);
      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        messageId: winner?.id,
        replayed: true,
        // The winner recorded no outcome yet: never a fabricated routed.
        delivery: { status: 'unknown', unrouted: [] },
      });
      expect(stored()).toHaveLength(1);
      expect(wakes).toEqual([]);
    });
  }

  it('the same id with different words is a 409, and nothing is stored or woken', async () => {
    seedThread();
    await call(reply, replyBody({ clientMessageId: CMID }));
    const res = await call(reply, replyBody({ clientMessageId: CMID, content: 'edited draft' }));
    expect(res._status).toBe(409);
    expect(stored()).toHaveLength(1);
    expect(mockHandleSendToInbox).toHaveBeenCalledTimes(1);

    const created = await call(create, createBody({ clientMessageId: CMID, content: 'other' }));
    expect(created._status).toBe(409);
  });

  it("another sender's message under the same id is a 409, never their message", async () => {
    const thread = seedThread();
    storeMessage(thread, 'one more thing', { clientMessageId: CMID }, 'user-2');
    const res = await call(reply, replyBody({ clientMessageId: CMID }));
    expect(res._status).toBe(409);
    expect(res._json).not.toHaveProperty('messageId');
  });

  it('a non-member is refused before any message is looked up', async () => {
    const thread = seedThread();
    storeMessage(thread, 'one more thing', { clientMessageId: CMID });
    for (const role of ['viewer', 'trusted']) {
      for (const [route, body] of [
        [reply, replyBody],
        [create, createBody],
      ] as const) {
        const res = await call(route, body({ clientMessageId: CMID }), role);
        expect(res._status).toBe(403);
      }
    }
    expect(db.log.some((e) => e.table === 'inbox_thread_messages')).toBe(false);
  });

  it('a malformed clientMessageId is a 400', async () => {
    seedThread();
    for (const clientMessageId of ['retry-1', 7, '']) {
      expect((await call(reply, replyBody({ clientMessageId })))._status).toBe(400);
      expect((await call(create, createBody({ clientMessageId })))._status).toBe(400);
    }
    expect(mockHandleSendToInbox).not.toHaveBeenCalled();
  });

  it('a request that died after storing is a 500, and its retry replays as unknown without waking anyone', async () => {
    seedThread();
    script.failAfterStore = true;
    const died = await call(reply, replyBody({ clientMessageId: CMID }));
    expect(died._status).toBe(500);
    expect(stored()).toHaveLength(1);

    script.failAfterStore = false;
    const retry = await call(reply, replyBody({ clientMessageId: CMID }));
    expect(retry._json).toMatchObject({
      messageId: stored()[0].id,
      replayed: true,
      delivery: { status: 'unknown', unrouted: [] },
    });
    expect(wakes).toEqual([]);
  });

  it('records the outcome on the stored message when a client id is given, and only then', async () => {
    seedThread();
    const res = await call(reply, replyBody({ clientMessageId: CMID }));
    const recorded = (stored()[0].metadata as Row).pcp as Row;
    expect(recorded.delivery).toMatchObject({
      ...(res._json.delivery as Row),
      recordedAt: expect.any(String),
    });
    expect((stored()[0].metadata as Row).clientMessageId).toBe(CMID);

    await call(reply, replyBody({ content: 'no id' }));
    const second = stored()[1];
    expect(((second.metadata as Row).pcp as Row).delivery).toBeUndefined();
    expect(db.log.filter((e) => e.op === 'update')).toHaveLength(1);
  });
});

describe('delivery status from positive evidence', () => {
  const cases: Array<[string, Partial<Script>, { status: string; unrouted: string[] }]> = [
    ['routed: every recipient stamped and woken', {}, { status: 'routed', unrouted: [] }],
    [
      'partial: one routing stamp failed',
      { routingFailures: [{ sbSlug: 'lumen', error: 'assignment failed' }] },
      { status: 'partial', unrouted: ['lumen'] },
    ],
    [
      'partial: one wake was not accepted',
      { triggered: ['wren'] },
      { status: 'partial', unrouted: ['lumen'] },
    ],
    [
      'unrouted: nobody was woken, though no failure was reported',
      { triggered: [] },
      { status: 'unrouted', unrouted: ['wren', 'lumen'] },
    ],
    [
      'unrouted: every stamp failed',
      {
        routingFailures: [
          { sbSlug: 'wren', error: 'x' },
          { sbSlug: 'lumen', error: 'y' },
        ],
      },
      { status: 'unrouted', unrouted: ['wren', 'lumen'] },
    ],
  ];

  for (const [label, overrides, expected] of cases) {
    for (const [routeLabel, route, body] of [
      ['create', create, createBody],
      ['reply', reply, replyBody],
    ] as const) {
      it(`${routeLabel} — ${label}`, async () => {
        seedThread();
        Object.assign(script, overrides);
        const res = await call(route, body());
        expect(res._status).toBe(200);
        expect(res._json.success).toBe(true);
        expect(res._json.delivery).toEqual(expected);
      });
    }
  }

  it('unknown when the result does not say who was dispatched to or woken', () => {
    expect(deliveryFromSendResult({ success: true, messageId: 'm' })).toEqual({
      status: 'unknown',
      unrouted: [],
    });
    // An empty failure list alone is not routed.
    expect(deliveryFromSendResult({ success: true, messageId: 'm', routingFailures: [] })).toEqual({
      status: 'unknown',
      unrouted: [],
    });
    expect(
      deliveryFromSendResult({ messageId: 'm', recipients: ['wren'], routingFailures: [] })
    ).toEqual({ status: 'unknown', unrouted: [] });
    expect(deliveryFromSendResult({ messageId: 'm', recipients: [], triggered: [] })).toEqual({
      status: 'unknown',
      unrouted: [],
    });
  });

  it('a replay of a message stored before dispatch finished reports unknown', async () => {
    const thread = seedThread();
    const early = storeMessage(thread, 'one more thing', { sentBy: 'user', clientMessageId: CMID });
    const res = await call(reply, replyBody({ clientMessageId: CMID }));
    expect(res._json).toMatchObject({
      messageId: early.id,
      replayed: true,
      delivery: { status: 'unknown', unrouted: [] },
    });
    expect(mockHandleSendToInbox).not.toHaveBeenCalled();
  });
});

describe('routingFailures reach the person (regression: both routes used to drop them)', () => {
  // On origin/main 3f30caf7 both routes answered { success: true, ... } with
  // no trace of the handler's routingFailures, so a stored-but-unrouted
  // message looked delivered.
  for (const [label, route, body] of [
    ['POST /threads', create, createBody],
    ['POST /threads/reply', reply, replyBody],
  ] as const) {
    it(`${label} reports the recipient whose routing failed`, async () => {
      seedThread();
      script.routingFailures = [{ sbSlug: 'lumen', error: 'no live session' }];
      const res = await call(route, body());
      expect(res._json.delivery).toEqual({ status: 'partial', unrouted: ['lumen'] });
      // The raw handler error stays in the logs.
      expect(JSON.stringify(res._json)).not.toContain('no live session');
    });
  }

  it('POST /threads passes the thread-key warning through', async () => {
    script.extra = { threadKeyWarning: 'Unregistered project prefix "chat"' };
    const res = await call(create, createBody());
    expect(res._json.threadKeyWarning).toBe('Unregistered project prefix "chat"');
    expect(res._json.warning).toBeNull();
  });
});
