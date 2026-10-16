/**
 * A conversation's mode on POST /api/admin/threads
 * (ink://specs/inkling-multi-person-groups, D8; services/threads/conversation-mode.ts).
 *
 * Kind of evidence: synthetic. The real admin route, the real
 * handleSendToInbox and the real inkling gate run; the database is the
 * in-memory FakePostgrest and the gateway is a mock, so no turn runs. The
 * column's CHECK is proven against the real schema in CI's integration job.
 *
 * Pinned here: a mode is written by the insert that creates the thread, only
 * by a client-identified create, and only for a conversation with an inkling;
 * anything else is refused before a row is written. A retry is held to the
 * mode it first named, and an adopting retry completes the thread its
 * original created without writing the mode again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createInklingDb } from '../test/fake-inkling-db';
import type { FakePostgrest, Row } from '../test/fake-postgrest';

const ME = '11111111-1111-4111-8111-111111111111';
const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';

let db: FakePostgrest;
vi.mock('../services/user-resolver', async (original) => ({
  ...(await original<typeof import('../services/user-resolver')>()),
  resolveUserOrThrow: vi.fn(async () => ({ user: { id: ME }, resolvedBy: 'userId' })),
}));
vi.mock('../utils/request-context', async (original) => ({
  ...(await original<typeof import('../utils/request-context')>()),
  getRequestContext: vi.fn(() => ({ userId: ME })),
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
import { ConversationModeRefusedError } from '../services/threads/conversation-mode';
import { CLIENT_MESSAGE_CONFLICT, createIntentOf, createRequestOf } from '../services/send-receipt';
import { userPrincipal } from '../services/principals';

type Handler = (req: Request, res: Response) => Promise<void>;
/* eslint-disable @typescript-eslint/no-explicit-any */
const create: Handler = (router as any).stack
  .find((x: any) => x.route?.path === '/threads' && x.route.methods.post)
  .route.stack.at(-1).handle;
/* eslint-enable @typescript-eslint/no-explicit-any */

async function post(body: Row): Promise<{ status: number; body: Row }> {
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
  await create(
    {
      body,
      headers: {},
      cookies: {},
      params: {},
      inkUserId: ME,
      inkWorkspaceId: WS,
      inkWorkspaceRole: 'owner',
    } as unknown as Request,
    res as unknown as Response
  );
  return answer;
}

const stored = () =>
  structuredClone({
    threads: db.rows('inbox_threads'),
    participants: db.rows('inbox_thread_participants'),
    messages: db.rows('inbox_thread_messages'),
  });
const NOTHING = { threads: [], participants: [], messages: [] };
const threadOf = (key: string) => db.rows('inbox_threads').find((t) => t.thread_key === key);

beforeEach(() => {
  gateway.dispatchTrigger.mockReset().mockReturnValue({ success: true, accepted: true });
  gateway.processTrigger.mockReset().mockResolvedValue({ success: true });
  resetReplyChains();
  db = createInklingDb();
  db.rpcHandlers.advance_thread_read_pointer = () => ({ data: true, error: null });
  db.seed('workspace_members', { workspace_id: WS, user_id: ME, role: 'owner' });
  vi.stubEnv('INKLING_OWNER_TEST_USER_ID', '');
  vi.stubEnv('INKLING_OWNER_TEST_USER_IDS', ME);
  db.seed('agent_identities', {
    id: 'sb-pip',
    agent_id: 'pip',
    user_id: ME,
    workspace_id: WS,
    name: 'pip',
    metadata: { client: 'inkling-mobile', named: false, ownerTest: true },
  });
  // An SB that is not an inkling: Inkwell's own kind of conversation.
  db.seed('agent_identities', {
    id: 'sb-ivy',
    agent_id: 'ivy',
    user_id: ME,
    workspace_id: WS,
    name: 'ivy',
    metadata: {},
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a create that names a mode', () => {
  it.each(['public', 'private'] as const)(
    'writes %s on the thread row it creates, in the same insert',
    async (mode) => {
      const answer = await post({
        key: `chat:${mode}`,
        recipients: ['pip'],
        content: 'hello',
        clientMessageId: ID,
        mode,
      });
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      expect(threadOf(`chat:${mode}`)?.conversation_mode).toBe(mode);
      // The intent the row records names it, so a retry is held to it.
      expect((threadOf(`chat:${mode}`)?.metadata as Row).createIntent).toMatchObject({ mode });
    }
  );

  it('writes no mode when the create names none', async () => {
    const answer = await post({
      key: 'chat:plain',
      recipients: ['pip'],
      content: 'hello',
      clientMessageId: ID,
    });
    expect(answer.status).toBe(200);
    expect(threadOf('chat:plain')?.conversation_mode).toBeUndefined();
    expect((threadOf('chat:plain')?.metadata as Row).createIntent).not.toHaveProperty('mode');
  });
});

describe('a mode that may not be set is refused before anything is written', () => {
  it.each([['Public'], ['shared'], [1], [true], [''], [['private']]])(
    'refuses mode %j as invalid',
    async (mode) => {
      const answer = await post({
        key: 'chat:bad',
        recipients: ['pip'],
        content: 'hello',
        clientMessageId: ID,
        mode,
      });
      expect(answer).toEqual({
        status: 400,
        body: { error: "mode must be 'public' or 'private'", code: 'mode_invalid' },
      });
      expect(stored()).toEqual(NOTHING);
    }
  );

  it('refuses a mode without a clientMessageId', async () => {
    const answer = await post({
      key: 'chat:no-id',
      recipients: ['pip'],
      content: 'hello',
      mode: 'private',
    });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ code: 'mode_needs_client_message_id' });
    expect(stored()).toEqual(NOTHING);
  });

  it('refuses a mode on a conversation with no inkling', async () => {
    const answer = await post({
      key: 'chat:ivy',
      recipients: ['ivy'],
      content: 'hello',
      clientMessageId: ID,
      mode: 'public',
    });
    expect(answer).toEqual({
      status: 400,
      body: {
        error: 'Only a conversation with an inkling has a mode',
        code: 'conversation_mode_refused',
      },
    });
    expect(stored()).toEqual(NOTHING);
    expect(gateway.dispatchTrigger).not.toHaveBeenCalled();
  });

  it('starts the same conversation with no inkling when it names no mode (control)', async () => {
    const answer = await post({
      key: 'chat:ivy',
      recipients: ['ivy'],
      content: 'hello',
      clientMessageId: ID,
    });
    expect(answer.status).toBe(200);
    expect(threadOf('chat:ivy')?.conversation_mode).toBeUndefined();
  });

  it('refuses, in the handler, a mode on a send that may join a thread', async () => {
    const outcome = await handleSendToInbox(
      { userId: ME, threadKey: 'chat:join', recipientSlug: 'pip', content: 'hello' },
      { repositories: {}, getClient: () => db } as never,
      {
        sender: { principal: userPrincipal(ME), workspaceId: WS },
        conversationMode: 'private',
      }
    ).then(
      () => null,
      (e: unknown) => e
    );
    expect(outcome).toBeInstanceOf(ConversationModeRefusedError);
    expect(stored()).toEqual(NOTHING);
  });
});

describe('a retry is held to the mode it first named', () => {
  const first = {
    key: 'chat:retry',
    recipients: ['pip'],
    content: 'hello',
    clientMessageId: ID,
    mode: 'private',
  };

  it('replays the same submission, mode included', async () => {
    const original = await post(first);
    expect(original.status).toBe(200);
    const retry = await post(first);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ replayed: true, messageId: original.body.messageId });
  });

  it.each([
    ['another mode', { mode: 'public' }],
    ['no mode', { mode: undefined }],
  ])('answers a retry naming %s with a 409, writing nothing', async (_label, change) => {
    expect((await post(first)).status).toBe(200);
    const before = stored();
    const retry = await post({ ...first, ...change });
    expect(retry).toEqual({ status: 409, body: { error: CLIENT_MESSAGE_CONFLICT } });
    expect(stored()).toEqual(before);
    expect(threadOf('chat:retry')?.conversation_mode).toBe('private');
  });

  it('answers a mode on a new create aimed at a key in use as taken, leaving its mode', async () => {
    expect((await post(first)).status).toBe(200);
    const taken = await post({ ...first, clientMessageId: OTHER_ID, mode: 'public' });
    expect(taken.status).toBe(409);
    expect(threadOf('chat:retry')?.conversation_mode).toBe('private');
  });
});

describe('an adopting retry completes the thread its original created', () => {
  /**
   * What an interrupted create left: its row, written with its mode, and
   * the members findOrCreateThread writes next, but no message.
   */
  function interrupted(mode: 'public' | 'private') {
    for (const member of [{ sb_id: 'sb-pip' }, { user_id: ME }]) {
      db.seed('inbox_thread_participants', {
        thread_id: 'thread-interrupted',
        workspace_id: WS,
        sb_id: null,
        user_id: null,
        ...member,
      });
    }
    db.seed('inbox_threads', {
      id: 'thread-interrupted',
      thread_key: 'chat:interrupted',
      workspace_id: WS,
      created_by_kind: 'user',
      created_by_user_id: ME,
      title: null,
      conversation_mode: mode,
      metadata: {
        createIntent: createIntentOf(ID, createRequestOf(['pip'], '', [], mode), 'hello', null),
        inklingConversation: true,
      },
    });
  }
  const retry = (mode: string) =>
    post({
      key: 'chat:interrupted',
      recipients: ['pip'],
      content: 'hello',
      clientMessageId: ID,
      mode,
    });

  it('adopts it when the retry names the same mode, and the mode stays as written', async () => {
    interrupted('private');
    const answer = await retry('private');
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body).toMatchObject({ created: false, replayed: false });
    expect(db.rows('inbox_threads')).toHaveLength(1);
    expect(threadOf('chat:interrupted')?.conversation_mode).toBe('private');
    expect(db.rows('inbox_thread_messages')).toHaveLength(1);
  });

  it('refuses to adopt it for a retry naming another mode', async () => {
    interrupted('private');
    const before = stored();
    const answer = await retry('public');
    expect(answer.status).toBe(409);
    expect(stored()).toEqual(before);
  });
});
