/**
 * Who may write to a conversation with an inkling, through the real admin
 * routes and the real handleSendToInbox, with only the database (the
 * in-memory FakePostgrest), the gateway and the read-pointer RPC faked.
 * The owner test's account is ME (Lumen 97b1d66a).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createInklingDb } from '../../test/fake-inkling-db';
import type { FakePostgrest, Row } from '../../test/fake-postgrest';

const ME = '11111111-1111-4111-8111-111111111111';
const SOMEONE = '22222222-2222-4222-8222-222222222222';
const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY = 'chat:conversation-gate';

let db: FakePostgrest;
vi.mock('../user-resolver', async (original) => ({
  ...(await original<typeof import('../user-resolver')>()),
  resolveUserOrThrow: vi.fn(async () => ({ user: { id: ME }, resolvedBy: 'userId' })),
}));
vi.mock('../../utils/request-context', async (original) => ({
  ...(await original<typeof import('../../utils/request-context')>()),
  getRequestContext: vi.fn(() => ({ userId: ME })),
  getSessionContext: vi.fn(() => undefined),
  getPinnedSlug: vi.fn(() => undefined),
}));
vi.mock('../../channels/agent-gateway', () => ({
  getAgentGateway: vi.fn(() => ({
    dispatchTrigger: vi.fn(() => ({ success: true, accepted: true })),
    processTrigger: vi.fn(async () => ({ success: true })),
  })),
}));
vi.mock('../../auth/ink-tokens', () => ({
  signInkAccessToken: vi.fn(),
  createRefreshToken: vi.fn(),
  exchangeRefreshToken: vi.fn(),
  verifyInkAccessToken: vi.fn(),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => db) }));
vi.mock('../../data/composer', () => ({
  getDataComposer: vi.fn(async () => ({ repositories: {}, getClient: () => db })),
}));
vi.mock('../authorization', () => ({ getAuthorizationService: vi.fn(() => ({})) }));
vi.mock('../oauth', () => ({ getOAuthService: vi.fn(() => ({})) }));
vi.mock('../../config/env', async () => ({
  env: {
    ...(await import('../../test/fake-env')).fakeEnv,
    NODE_ENV: 'development',
    MCP_HTTP_PORT: 3001,
  },
  isDevelopment: () => true,
}));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import router from '../../routes/admin';
import { handleSendToInbox } from '../../mcp/tools/inbox-handlers';
import { InklingThreadRefusedError } from './inkling-thread-gate';

type Handler = (req: Request, res: Response) => Promise<void>;
/* eslint-disable @typescript-eslint/no-explicit-any */
const route = (path: string): Handler =>
  (router as any).stack
    .find((x: any) => x.route?.path === path && x.route.methods.post)
    .route.stack.at(-1).handle;
/* eslint-enable @typescript-eslint/no-explicit-any */
const create = route('/threads');
const reply = route('/threads/reply');

async function call(
  handler: Handler,
  body: Row,
  as: string = ME
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
  await handler(
    {
      body,
      headers: {},
      cookies: {},
      params: {},
      inkUserId: as,
      inkWorkspaceId: WS,
      inkWorkspaceRole: 'owner',
    } as unknown as Request,
    res as unknown as Response
  );
  return answer;
}

/** An SB in my workspace; an inkling when `inkling` metadata is given. */
function sb(slug: string, metadata: Row = {}, userId = ME): Row {
  return db.seed('agent_identities', {
    id: `sb-${slug}`,
    agent_id: slug,
    user_id: userId,
    workspace_id: WS,
    name: slug,
    metadata,
  });
}
const OWNER_TEST_INKLING = { client: 'inkling-mobile', named: false, ownerTest: true };

const written = () => ({
  threads: db.rows('inbox_threads').length,
  participants: db.rows('inbox_thread_participants').length,
  messages: db.rows('inbox_thread_messages').length,
});
const NOTHING = { threads: 0, participants: 0, messages: 0 };

beforeEach(() => {
  db = createInklingDb();
  db.rpcHandlers.advance_thread_read_pointer = () => ({ data: true, error: null });
  sb('pip', OWNER_TEST_INKLING);
  sb('fern');
  vi.stubEnv('INKLING_OWNER_TEST_USER_ID', ME);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** handleSendToInbox as the server sends for a non-person: an SB, or the system. */
async function sendAs(principal: Row): Promise<unknown> {
  const dataComposer = { repositories: {}, getClient: () => db };
  return handleSendToInbox(
    { userId: ME, threadKey: KEY, recipients: ['pip'], content: 'hello pip', triggerAll: true },
    dataComposer as never,
    { sender: { principal: principal as never, workspaceId: WS } }
  ).then(
    () => null,
    (e: unknown) => e
  );
}

describe('a conversation with an inkling is only between it and its owner (Lumen 97b1d66a)', () => {
  it('the owner may start one with their inkling, and reply in it', async () => {
    const started = await call(create, { key: KEY, recipients: ['pip'], content: 'hi' });
    expect(started.status).toBe(200);
    const replied = await call(reply, { key: KEY, content: 'still here' });
    expect(replied.status).toBe(200);
    expect(written()).toEqual({ threads: 1, participants: 2, messages: 2 });
  });

  it('with the owner test off, even the owner is refused, and nothing is written', async () => {
    vi.stubEnv('INKLING_OWNER_TEST_USER_ID', '');
    const res = await call(create, { key: KEY, recipients: ['pip'], content: 'hi' });
    expect(res).toMatchObject({ status: 403, body: { code: 'inklings_disabled' } });
    expect(written()).toEqual(NOTHING);
  });

  it('another SB may not join: the owner adding Fern is refused whole', async () => {
    const res = await call(create, { key: KEY, recipients: ['pip', 'fern'], content: 'hi' });
    expect(res).toMatchObject({ status: 403, body: { code: 'inkling_thread_refused' } });
    expect(written()).toEqual(NOTHING);
  });

  it('another person may not write to it, new or existing', async () => {
    const theirs = await call(create, { key: KEY, recipients: ['pip'], content: 'hi' }, SOMEONE);
    expect(theirs).toMatchObject({ status: 403, body: { code: 'inkling_thread_refused' } });
    expect(written()).toEqual(NOTHING);

    await call(create, { key: KEY, recipients: ['pip'], content: 'hi' });
    const before = written();
    const intruding = await call(reply, { key: KEY, content: 'me too' }, SOMEONE);
    expect(intruding.status).not.toBe(200);
    expect(written()).toEqual(before);
  });

  it('an SB, a strategy or the system may not send to an inkling', async () => {
    const myra = sb('myra');
    const asMyra = { kind: 'sb', sbId: myra.id, sbSlug: 'myra', userId: ME, workspaceId: WS };
    for (const principal of [asMyra, { kind: 'system' }]) {
      expect(await sendAs(principal)).toBeInstanceOf(InklingThreadRefusedError);
    }
    expect(written()).toEqual(NOTHING);
  });

  it('an existing conversation that already holds someone else stays closed to the owner too', async () => {
    const thread = db.seed('inbox_threads', { thread_key: KEY, workspace_id: WS });
    for (const member of [
      { sb_id: 'sb-pip', user_id: null },
      { sb_id: null, user_id: ME },
      { sb_id: null, user_id: SOMEONE },
    ]) {
      db.seed('inbox_thread_participants', { thread_id: thread.id, workspace_id: WS, ...member });
    }
    const res = await call(reply, { key: KEY, content: 'hi' });
    expect(res).toMatchObject({ status: 403, body: { code: 'inkling_thread_refused' } });
    expect(db.rows('inbox_thread_messages')).toHaveLength(0);
  });

  it("an inkling not born under the owner test, or another account's, never talks", async () => {
    sb('old', { client: 'inkling-mobile', named: false });
    sb('elsewhere', OWNER_TEST_INKLING, SOMEONE);
    for (const slug of ['old', 'elsewhere']) {
      const res = await call(create, { key: `${KEY}-${slug}`, recipients: [slug], content: 'hi' });
      expect(res.status, slug).not.toBe(200);
    }
    expect(written()).toEqual(NOTHING);
  });

  it('a conversation with no inkling is untouched by the gate, on or off', async () => {
    for (const gate of [ME, '']) {
      vi.stubEnv('INKLING_OWNER_TEST_USER_ID', gate);
      const res = await call(create, {
        key: `chat:fern-${gate ? 'on' : 'off'}`,
        recipients: ['fern'],
        content: 'hi',
      });
      expect(res.status).toBe(200);
    }
  });
});
