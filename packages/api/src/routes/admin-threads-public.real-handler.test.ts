/**
 * Public and private conversations in a shared space (Conor, 2026-10-16
 * 11:12 AM: "It's just a flag whether it's private or public").
 *
 * Kind of evidence: synthetic. The real admin routes, the real
 * handleSendToInbox, the real thread gate and the real turn gate's message
 * proof run; the database is the in-memory FakePostgrest and the gateway is a
 * mock, so no turn runs. The list, its counts and its database filters are
 * proven against a real database in admin-private-threads.integration.test.ts.
 *
 * One team space: owner A (the inkling's owner), members B and C, an admin
 * and a viewer. Every person is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createInklingDb } from '../test/fake-inkling-db';
import type { FakePostgrest, Row } from '../test/fake-postgrest';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const VIEWER = '55555555-5555-4555-8555-555555555555';
/** Has an account, and no place in the space. */
const OUTSIDER = '66666666-6666-4666-8666-666666666666';
const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PUBLIC_KEY = 'chat:public-plans';
const ID = '77777777-7777-4777-8777-777777777777';
const ID_2 = '88888888-8888-4888-8888-888888888888';

let db: FakePostgrest;
vi.mock('../services/user-resolver', async (original) => ({
  ...(await original<typeof import('../services/user-resolver')>()),
  resolveUserOrThrow: vi.fn(async () => ({ user: { id: A }, resolvedBy: 'userId' })),
}));
vi.mock('../utils/request-context', async (original) => ({
  ...(await original<typeof import('../utils/request-context')>()),
  getRequestContext: vi.fn(() => ({ userId: A })),
  getSessionContext: vi.fn(() => undefined),
  getPinnedSlug: vi.fn(() => undefined),
}));
const gateway = vi.hoisted(() => ({
  dispatchTrigger: vi.fn((_payload: unknown) => ({ success: true, accepted: true })),
  processTrigger: vi.fn(async () => ({ success: true })),
}));
vi.mock('../channels/agent-gateway', () => ({ getAgentGateway: vi.fn(() => gateway) }));
vi.mock('../auth/ink-tokens', () => ({
  signInkAccessToken: vi.fn(),
  createRefreshToken: vi.fn(),
  exchangeRefreshToken: vi.fn(),
  verifyInkAccessToken: vi.fn(),
}));
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

import router from './admin';
import { handleSendToInbox } from '../mcp/tools/inbox-handlers';
import { resetReplyChains } from '../services/inklings/inkling-reply-chain';
import { isOwnersOwnMessage } from '../services/inklings/inkling-turn-gate';
import {
  GROUP_PRIVACY_RULE,
  inklingConversationNote,
  publicThreadOpening,
} from '../services/inklings/inkling-conversation-note';

type Handler = (req: Request, res: Response) => Promise<void>;
/* eslint-disable @typescript-eslint/no-explicit-any */
const handlerOf = (path: string, method: 'get' | 'post'): Handler =>
  (router as any).stack
    .find((x: any) => x.route?.path === path && x.route.methods[method])
    .route.stack.at(-1).handle;
/* eslint-enable @typescript-eslint/no-explicit-any */
const createRoute = handlerOf('/threads', 'post');
const replyRoute = handlerOf('/threads/reply', 'post');
const messagesRoute = handlerOf('/threads/messages', 'get');

const ROLE: Record<string, string> = {
  [A]: 'owner',
  [B]: 'member',
  [C]: 'member',
  [ADMIN]: 'admin',
  [VIEWER]: 'viewer',
};

/**
 * One request to a route as a person, with the role the middleware resolves
 * for them. `role` overrides it, to reach what a route's own role check
 * would otherwise stop.
 */
async function call(
  handler: Handler,
  input: { body?: Row; query?: Row },
  as: string,
  role = ROLE[as] ?? 'member'
): Promise<{ status: number; body: Row }> {
  const answer = { status: 200, body: {} as Row };
  const res = {
    status(n: number) {
      answer.status = n;
      return res;
    },
    json(r: Row) {
      answer.body = r;
      return res;
    },
  };
  // The messages route's studio history filters studio_lease_events with an
  // `.or()` the fake does not evaluate. The table is empty here, so passing
  // every row answers exactly what PostgREST would: none.
  const realFrom = db.from.bind(db);
  db.from = ((table: string) => {
    const query = realFrom(table);
    if (table === 'studio_lease_events') {
      expect(db.rows(table)).toHaveLength(0);
      Object.assign(query, { or: () => query });
    }
    return query;
  }) as typeof db.from;
  try {
    await handler(
      {
        body: input.body ?? {},
        query: input.query ?? {},
        headers: {},
        cookies: {},
        params: {},
        inkUserId: as,
        inkWorkspaceId: WS,
        inkWorkspaceRole: role,
      } as unknown as Request,
      res as unknown as Response
    );
  } finally {
    db.from = realFrom;
  }
  return answer;
}

const create = (body: Row, as = A, role?: string) => call(createRoute, { body }, as, role);
const reply = (key: string, content: string, as: string, role?: string) =>
  call(replyRoute, { body: { key, content } }, as, role);

async function read(key: string, as: string, role?: string) {
  const answer = await call(messagesRoute, { query: { key } }, as, role);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body as {
    thread: { threadKey: string; conversationMode?: string | null; shared?: boolean } | null;
    messages: Array<{ content: string }>;
  };
}

const NOTHING = { thread: null, messages: [], studioHistory: [] };

const threadOf = (key: string) => db.rows('inbox_threads').find((t) => t.thread_key === key);
const peopleOn = (key: string) =>
  db
    .rows('inbox_thread_participants')
    .filter((r) => r.thread_id === threadOf(key)?.id && r.user_id)
    .map((r) => r.user_id as string)
    .sort();
const written = () => ({
  threads: db.rows('inbox_threads').length,
  participants: db.rows('inbox_thread_participants').length,
  messages: db.rows('inbox_thread_messages').length,
});
/** The SBs a send woke: one dispatchTrigger per wake. */
const woken = (): string[] =>
  (gateway.dispatchTrigger.mock.calls as unknown as Array<[{ toSlug: string }]>)
    .map(([payload]) => payload.toSlug)
    .sort();

function space(type: 'team' | 'personal'): void {
  db.seed('workspaces', { id: WS, name: 'Choir', type, metadata: {} });
}

beforeEach(() => {
  gateway.dispatchTrigger.mockReset().mockReturnValue({ success: true, accepted: true });
  gateway.processTrigger.mockReset().mockResolvedValue({ success: true });
  resetReplyChains();
  db = createInklingDb();
  db.rpcHandlers.advance_thread_read_pointer = () => ({ data: true, error: null });
  for (const [user, role] of Object.entries(ROLE)) {
    db.seed('workspace_members', { workspace_id: WS, user_id: user, role });
  }
  db.seed('agent_identities', {
    id: 'sb-pip',
    agent_id: 'pip',
    user_id: A,
    workspace_id: WS,
    name: 'pip',
    metadata: { client: 'inkling-mobile', named: false, ownerTest: true },
  });
  db.seed('agent_identities', {
    id: 'sb-fern',
    agent_id: 'fern',
    user_id: A,
    workspace_id: WS,
    name: 'fern',
    metadata: {},
  });
  vi.stubEnv('INKLING_OWNER_TEST_USER_ID', '');
  vi.stubEnv('INKLING_OWNER_TEST_USER_IDS', A);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a public conversation in a shared space', () => {
  beforeEach(() => space('team'));

  it('A starts it with the inkling; C reads it marked public, posts, joins, and the inkling wakes and answers C', async () => {
    const started = await create({
      key: PUBLIC_KEY,
      recipients: ['pip'],
      content: 'hi space',
      clientMessageId: ID,
      mode: 'public',
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(threadOf(PUBLIC_KEY)).toMatchObject({ conversation_mode: 'public' });
    // A public conversation carries its mode, never the group-with-people mark.
    expect(threadOf(PUBLIC_KEY)?.metadata).not.toHaveProperty('inklingShared');

    const seen = await read(PUBLIC_KEY, C);
    expect(seen.thread).toMatchObject({ threadKey: PUBLIC_KEY, conversationMode: 'public' });
    expect(seen.messages.map((m) => m.content)).toEqual(['hi space']);

    gateway.dispatchTrigger.mockClear();
    const fromC = await reply(PUBLIC_KEY, 'count me in', C);
    expect(fromC.status, JSON.stringify(fromC.body)).toBe(200);
    expect(peopleOn(PUBLIC_KEY)).toEqual([A, C].sort());
    const stored = db.rows('inbox_thread_messages').find((m) => m.sender_user_id === C);
    expect(stored?.content).toBe('count me in');
    expect(woken()).toEqual(['pip']);
    // The turn gate's shared branch reads that stored message: it wakes pip.
    expect(
      await isOwnersOwnMessage(db as never, {
        threadMessageId: stored?.id as string,
        inklingId: 'sb-pip',
        ownerUserId: A,
        workspaceId: WS,
      })
    ).toBe('yes');

    // And pip answers C there, waking nobody.
    gateway.dispatchTrigger.mockClear();
    const answered = await handleSendToInbox(
      { userId: A, threadKey: PUBLIC_KEY, recipientSlug: 'pip', content: 'welcome, C' },
      { repositories: {}, getClient: () => db } as never,
      {
        sender: {
          principal: {
            kind: 'sb',
            sbId: 'sb-pip',
            sbSlug: 'pip',
            userId: A,
            workspaceId: WS,
          } as never,
          workspaceId: WS,
        },
      }
    ).then(
      () => null,
      (e: unknown) => e
    );
    expect(answered).toBeNull();
    expect(woken()).toEqual([]);
    expect(db.rows('inbox_thread_messages')).toHaveLength(3);
  });

  it('a member may start one with the space’s inkling too', async () => {
    const started = await create(
      {
        key: PUBLIC_KEY,
        recipients: ['pip'],
        content: 'trip ideas?',
        clientMessageId: ID,
        mode: 'public',
      },
      B
    );
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(threadOf(PUBLIC_KEY)).toMatchObject({ conversation_mode: 'public' });
    // Through the gate's shared branch, still without the group-with-people mark.
    expect(threadOf(PUBLIC_KEY)?.metadata).not.toHaveProperty('inklingShared');
    expect((await read(PUBLIC_KEY, C)).thread).toMatchObject({ conversationMode: 'public' });
  });

  it('a viewer and an admin read it; a viewer may neither post in it nor start one', async () => {
    await create({
      key: PUBLIC_KEY,
      recipients: ['pip'],
      content: 'hi space',
      clientMessageId: ID,
      mode: 'public',
    });
    for (const who of [VIEWER, ADMIN]) {
      expect((await read(PUBLIC_KEY, who)).messages, who).toHaveLength(1);
    }
    const before = written();
    expect((await reply(PUBLIC_KEY, 'me too', VIEWER)).status).toBe(403);
    // Past the route's role check, the gate reads the membership itself.
    expect((await reply(PUBLIC_KEY, 'me too', VIEWER, 'member')).status).not.toBe(200);
    expect(
      (
        await create(
          {
            key: 'chat:viewer-start',
            recipients: ['pip'],
            content: 'hi',
            clientMessageId: ID_2,
            mode: 'public',
          },
          VIEWER,
          'member'
        )
      ).status
    ).toBe(403);
    expect(written()).toEqual(before);
  });

  it('a person outside the space cannot post in it, even past the route', async () => {
    await create({
      key: PUBLIC_KEY,
      recipients: ['pip'],
      content: 'hi space',
      clientMessageId: ID,
      mode: 'public',
    });
    const before = written();
    gateway.dispatchTrigger.mockClear();
    expect((await reply(PUBLIC_KEY, 'let me in', OUTSIDER, 'member')).status).not.toBe(200);
    expect(written()).toEqual(before);
    expect(woken()).toEqual([]);
  });

  it('tells the inkling it is public, and what stays private (pinned)', async () => {
    await create({
      key: PUBLIC_KEY,
      recipients: ['pip'],
      content: 'hi space',
      clientMessageId: ID,
      mode: 'public',
    });
    expect(publicThreadOpening('Choir')).toBe(
      'This is a public thread in Choir: anyone in the space can read it and join.'
    );
    const note = await inklingConversationNote(db as never, {
      workspaceId: WS,
      threadKey: PUBLIC_KEY,
      recipientSbId: 'sb-pip',
    });
    expect(note).toBe(
      [
        'This is a public thread in Choir: anyone in the space can read it and join.',
        'Each message names who sent it; answer that person, in front of everyone here.',
        GROUP_PRIVACY_RULE,
      ].join('\n')
    );
    // Told only to an SB on it.
    expect(
      await inklingConversationNote(db as never, {
        workspaceId: WS,
        threadKey: PUBLIC_KEY,
        recipientSbId: 'sb-fern',
      })
    ).toBeNull();
  });
});

describe('private conversations stay their people’s', () => {
  beforeEach(() => space('team'));

  it('A’s group with B: C, an admin and a viewer read nothing; B reads it, private', async () => {
    const started = await create({
      key: 'chat:a-and-b',
      recipients: ['pip'],
      people: [B],
      content: 'just us two',
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    for (const who of [C, ADMIN, VIEWER]) {
      expect(await read('chat:a-and-b', who), who).toEqual(NOTHING);
    }
    expect((await read('chat:a-and-b', B)).thread).toMatchObject({
      shared: true,
      conversationMode: null,
    });
    const before = written();
    expect((await reply('chat:a-and-b', 'hello?', C)).status).toBe(404);
    expect(written()).toEqual(before);
  });

  it('a 1:1, with no mode or named private: nobody else reads it, the owner and an admin included', async () => {
    await create({ key: 'chat:a-alone', recipients: ['pip'], content: 'just me' });
    await create({
      key: 'chat:a-private',
      recipients: ['pip'],
      content: 'just me, privately',
      clientMessageId: ID,
      mode: 'private',
    });
    for (const key of ['chat:a-alone', 'chat:a-private']) {
      for (const who of [C, ADMIN]) {
        expect(await read(key, who), `${who} ${key}`).toEqual(NOTHING);
      }
    }
    expect((await read('chat:a-private', A)).thread).toMatchObject({
      conversationMode: 'private',
    });
    expect((await reply('chat:a-alone', 'hi', C)).status).toBe(404);
  });
});

describe('a personal space is unchanged', () => {
  beforeEach(() => space('personal'));

  it('refuses a public create before anything is written', async () => {
    const answer = await create({
      key: PUBLIC_KEY,
      recipients: ['pip'],
      content: 'hi',
      clientMessageId: ID,
      mode: 'public',
    });
    expect(answer).toMatchObject({ status: 400, body: { code: 'conversation_mode_refused' } });
    expect(written()).toEqual({ threads: 0, participants: 0, messages: 0 });
  });

  it('keeps its 1:1 its owner’s alone', async () => {
    await create({ key: 'chat:a-alone', recipients: ['pip'], content: 'just me' });
    expect(await read('chat:a-alone', B)).toEqual(NOTHING);
  });
});
