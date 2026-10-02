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
import { createRequestOf, deliveryFromSendResult } from '../services/send-receipt';
import { ThreadKeyTakenError } from '../mcp/tools/thread-key-taken';

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
  /** Runs before this send looks up its thread: a concurrent request acting first. */
  beforeSend?: () => void;
  /** Runs after the thread exists and before this send's store (a concurrent request). */
  beforeStore?: (thread: Row) => void;
  /** Fails after the store, before dispatch: a request that died mid-send. */
  failAfterStore?: boolean;
  /** Dies after creating the thread and its participants, before storing the message. */
  dieBeforeStore?: boolean;
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

/** The SB slugs on the conversation under KEY. */
function participants(): string[] {
  const thread = db.rows('inbox_threads').find((t) => t.thread_key === KEY);
  return db
    .rows('inbox_thread_participants')
    .filter((p) => p.thread_id === thread?.id && p.sb_slug)
    .map((p) => String(p.sb_slug))
    .sort();
}

/** SB participant rows as the handler writes them (sb_id), with the slug kept for reading. */
function addParticipants(thread: Row, slugs: string[]): void {
  for (const slug of slugs) {
    const there = db
      .rows('inbox_thread_participants')
      .some((p) => p.thread_id === thread.id && p.sb_slug === slug);
    if (!there) {
      db.seed('inbox_thread_participants', {
        thread_id: thread.id,
        sb_id: `sb-${slug}`,
        sb_slug: slug,
        user_id: null,
      });
    }
  }
}

function addPerson(thread: Row, userId: string): void {
  db.seed('inbox_thread_participants', { thread_id: thread.id, sb_id: null, user_id: userId });
}

/** A conversation another request already created under KEY, with its own first message. */
function seedConversation(
  slugs: string[],
  firstMessage?: { content: string; metadata: Row },
  createdBy = ME
): Row {
  const thread = db.seed('inbox_threads', {
    thread_key: KEY,
    workspace_id: WORKSPACE,
    created_by_user_id: createdBy,
  });
  addParticipants(thread, slugs);
  addPerson(thread, createdBy);
  if (firstMessage) storeMessage(thread, firstMessage.content, firstMessage.metadata, createdBy);
  return thread;
}

beforeEach(() => {
  vi.clearAllMocks();
  db = createInklingDb();
  for (const slug of ['wren', 'lumen']) {
    db.seed('agent_identities', {
      id: `sb-${slug}`,
      user_id: ME,
      workspace_id: WORKSPACE,
      agent_id: slug,
      name: slug,
      metadata: {},
    });
  }
  wakes = [];
  script = { recipients: ['wren', 'lumen'], triggered: ['wren', 'lumen'] };
  mockGetParticipants.mockResolvedValue([
    { sbId: 'sb-wren', sbSlug: 'wren', userId: null },
    { sbId: 'sb-lumen', sbSlug: 'lumen', userId: null },
  ]);
  // Mirrors the real handler where these routes can observe it: a
  // create-only send refuses a taken key before writing anything (proven on
  // the real handler in inbox-handlers.create-only.test.ts); otherwise the
  // thread is found or created, recipients become participants, the message
  // is stored with the caller's metadata.pcp kept, and the index refuses a
  // second copy of one client message id.
  mockHandleSendToInbox.mockImplementation(
    async (
      args: Record<string, unknown>,
      _dataComposer: unknown,
      internal: {
        sender: { principal: { userId: string }; workspaceId: string };
        createOnly?: boolean;
      }
    ) => {
      const workspaceId = internal.sender.workspaceId;
      script.beforeSend?.();
      let thread = db
        .rows('inbox_threads')
        .find((t) => t.thread_key === args.threadKey && t.workspace_id === workspaceId);
      if (thread && internal.createOnly) throw new ThreadKeyTakenError(String(args.threadKey));
      if (!thread) {
        thread = db.seed('inbox_threads', {
          thread_key: args.threadKey,
          workspace_id: workspaceId,
          created_by_user_id: internal.sender.principal.userId,
        });
        addPerson(thread, internal.sender.principal.userId);
      }
      addParticipants(
        thread,
        (args.recipients as string[] | undefined) ?? [String(args.recipientSlug)]
      );
      if (script.dieBeforeStore) throw new Error('connection reset');
      script.beforeStore?.(thread);

      const metadata = args.metadata as Row;
      const { data, error } = await db
        .from('inbox_thread_messages')
        .insert({
          thread_id: thread.id,
          sender_kind: 'user',
          sender_user_id: internal.sender.principal.userId,
          content: args.content,
          metadata: {
            ...metadata,
            pcp: { ...((metadata.pcp as Row) ?? {}), sender: { kind: 'user' } },
          },
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
              // Like the real handler: every SB on the thread is routed to
              // and woken, including participants nobody requested.
              dispatched: db
                .rows('inbox_thread_participants')
                .filter((p) => p.thread_id === thread.id && p.sb_slug)
                .map((p) => ({ sbSlug: p.sb_slug, wake: true })),
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

  it('reply: a retry that lost the race to a concurrent copy answers with the winner and wakes nobody', async () => {
    const thread = seedThread();
    let winner: Row | undefined;
    script.beforeStore = (t) => {
      // The concurrent request stores first; its dispatch has not finished.
      script.beforeStore = undefined;
      winner = storeMessage(t, String(replyBody().content), {
        sentBy: 'user',
        clientMessageId: CMID,
      });
    };

    const res = await call(reply, replyBody({ clientMessageId: CMID }));

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

  it('create: a retry racing its own original, which takes the key mid-send, waits for it and replays', async () => {
    let winner: Row | undefined;
    let landed: Promise<void> = Promise.resolve();
    const ownDb = db;
    script.beforeSend = () => {
      // The original creates the conversation after this retry's pre-check;
      // its first message lands a moment later.
      script.beforeSend = undefined;
      const thread = seedConversation(['wren', 'lumen']);
      landed = new Promise((resolve) =>
        setTimeout(() => {
          // This test's database, even if the next test has replaced `db`.
          winner = ownDb.seed('inbox_thread_messages', {
            thread_id: thread.id,
            sender_kind: 'user',
            sender_user_id: ME,
            content: String(createBody().content),
            metadata: {
              sentBy: 'user',
              clientMessageId: CMID,
              pcp: { createRequest: createRequestOf(['wren', 'lumen'], '') },
            },
          });
          resolve();
        }, 150)
      );
    };

    const res = await call(create, createBody({ clientMessageId: CMID }));
    await landed;

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      messageId: winner?.id,
      replayed: true,
      delivery: { status: 'unknown', unrouted: [] },
    });
    expect(stored()).toHaveLength(1);
    expect(wakes).toEqual([]);
  });

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

describe('a client-identified create never changes who is in a conversation', () => {
  // Fern's private conversation under KEY, created by a submission whose
  // response was lost. Every retry below reuses its key and message id.
  async function createFernsConversation(): Promise<MockResponse> {
    script.recipients = ['wren'];
    script.triggered = ['wren'];
    const res = await call(
      create,
      createBody({ recipients: ['wren'], title: 'Just us', clientMessageId: CMID })
    );
    expect(res._json).toMatchObject({ created: true, replayed: false });
    return res;
  }

  it('the same id with different recipients is a 409, and nobody is added', async () => {
    await createFernsConversation();
    const res = await call(
      create,
      createBody({ recipients: ['wren', 'lumen'], title: 'Just us', clientMessageId: CMID })
    );
    expect(res._status).toBe(409);
    expect(participants()).toEqual(['wren']);
    expect(stored()).toHaveLength(1);
    expect(mockHandleSendToInbox).toHaveBeenCalledTimes(1);
  });

  it('the same id with a different title is a 409', async () => {
    await createFernsConversation();
    const res = await call(
      create,
      createBody({ recipients: ['wren'], title: 'Something else', clientMessageId: CMID })
    );
    expect(res._status).toBe(409);
    expect(mockHandleSendToInbox).toHaveBeenCalledTimes(1);
  });

  it('the same recipients in another order and case replay', async () => {
    script.recipients = ['wren', 'lumen'];
    const first = await call(
      create,
      createBody({ recipients: ['wren', 'lumen'], title: 'Both', clientMessageId: CMID })
    );
    const retry = await call(
      create,
      createBody({ recipients: ['Lumen', 'wren'], title: 'Both', clientMessageId: CMID })
    );
    expect(retry._status).toBe(200);
    expect(retry._json).toMatchObject({ messageId: first._json.messageId, replayed: true });
    expect(mockHandleSendToInbox).toHaveBeenCalledTimes(1);
  });

  it('a new id aimed at a key already in use is a 409, and nothing is written', async () => {
    await createFernsConversation();
    const res = await call(
      create,
      createBody({
        recipients: ['wren', 'lumen'],
        title: 'Just us',
        clientMessageId: '0f0e0d0c-0b0a-4908-8706-050403020100',
      })
    );
    expect(res._status).toBe(409);
    expect(participants()).toEqual(['wren']);
    expect(stored()).toHaveLength(1);
    expect(mockHandleSendToInbox).toHaveBeenCalledTimes(1);
  });

  it('a different submission taking the key mid-send is a 409, and nobody is added', async () => {
    script.beforeSend = () => {
      script.beforeSend = undefined;
      seedConversation(
        ['wren'],
        {
          content: 'just you',
          metadata: { clientMessageId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' },
        },
        'user-2'
      );
    };
    const res = await call(create, createBody({ clientMessageId: CMID }));
    expect(res._status).toBe(409);
    expect(participants()).toEqual(['wren']);
    expect(stored().map((m) => m.content)).toEqual(['just you']);
    expect(wakes).toEqual([]);
  });

  describe('a create that died between making the thread and storing its message', () => {
    // Review 15fac9a8 (P2): the thread, its participants and the first
    // message are separate writes. A correct retry must not be stranded on a
    // 409 by the empty conversation its own dead original left behind.
    async function dieAfterCreatingTheThread(body: Record<string, unknown>): Promise<void> {
      script.dieBeforeStore = true;
      const died = await call(create, createBody(body));
      expect(died._status).toBe(500);
      expect(stored()).toHaveLength(0);
      script.dieBeforeStore = false;
    }

    it('a correct retry adopts the empty conversation and stores exactly one message', async () => {
      await dieAfterCreatingTheThread({ clientMessageId: CMID });
      const retry = await call(create, createBody({ clientMessageId: CMID }));
      expect(retry._status).toBe(200);
      expect(retry._json).toMatchObject({ success: true, replayed: false });
      expect(stored()).toHaveLength(1);
      expect(stored()[0].id).toBe(retry._json.messageId);
      expect(participants()).toEqual(['lumen', 'wren']);

      // And a retry of that retry replays it.
      const again = await call(create, createBody({ clientMessageId: CMID }));
      expect(again._json).toMatchObject({ messageId: retry._json.messageId, replayed: true });
    });

    it('a retry naming different inklings is still a 409, and nobody is added', async () => {
      await dieAfterCreatingTheThread({ recipients: ['wren'], clientMessageId: CMID });
      const res = await call(
        create,
        createBody({ recipients: ['wren', 'lumen'], clientMessageId: CMID })
      );
      expect(res._status).toBe(409);
      expect(participants()).toEqual(['wren']);
      expect(stored()).toHaveLength(0);
    });

    it('a retry with a different title is still a 409', async () => {
      await dieAfterCreatingTheThread({ title: 'Just us', clientMessageId: CMID });
      const res = await call(create, createBody({ title: 'Everyone', clientMessageId: CMID }));
      expect(res._status).toBe(409);
      expect(stored()).toHaveLength(0);
    });

    it('an empty conversation someone else created is never adopted', async () => {
      seedConversation(['wren', 'lumen'], undefined, 'user-2');
      const res = await call(create, createBody({ clientMessageId: CMID }));
      expect(res._status).toBe(409);
      expect(stored()).toHaveLength(0);
    });
  });

  it('without a client id, a create still continues a thread under its key, as before', async () => {
    seedConversation(['wren']);
    const res = await call(create, createBody({ recipients: ['wren', 'lumen'] }));
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ created: false, replayed: false });
    expect(participants()).toEqual(['lumen', 'wren']);
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
    expect(deliveryFromSendResult({ messageId: 'm', dispatched: [], triggered: [] })).toEqual({
      status: 'unknown',
      unrouted: [],
    });
    // The requested list is not evidence of who was routed to.
    expect(
      deliveryFromSendResult({ messageId: 'm', recipients: ['wren'], triggered: ['wren'] })
    ).toEqual({ status: 'unknown', unrouted: [] });
  });

  it('a target routed without a wake (routeOnly) is delivered once its stamp holds', () => {
    expect(
      deliveryFromSendResult({
        dispatched: [
          { sbSlug: 'wren', wake: true },
          { sbSlug: 'lumen', wake: false },
        ],
        triggered: ['wren'],
      })
    ).toEqual({ status: 'routed', unrouted: [] });
    expect(
      deliveryFromSendResult({
        dispatched: [
          { sbSlug: 'wren', wake: true },
          { sbSlug: 'lumen', wake: false },
        ],
        triggered: ['wren'],
        routingFailures: [{ sbSlug: 'lumen', error: 'x' }],
      })
    ).toEqual({ status: 'partial', unrouted: ['lumen'] });
  });

  it("a participant nobody requested still counts: its failed routing is not 'routed'", async () => {
    // Thread K holds wren and lumen; the person addresses only wren. The
    // handler wakes both, and lumen's routing fails (review bbbbba99, P2 1).
    seedConversation(['wren', 'lumen']);
    script.recipients = ['wren'];
    script.triggered = ['wren', 'lumen'];
    script.routingFailures = [{ sbSlug: 'lumen', error: 'no live session' }];
    const res = await call(create, createBody({ recipients: ['wren'] }));
    expect(res._json.delivery).toEqual({ status: 'partial', unrouted: ['lumen'] });
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
