/**
 * An inkling's turn that ended without a word to its owner gets its closing
 * text posted as its message (task 9edf62fe), through the real admin create
 * route and the real handleSendToInbox, with only the database (the
 * in-memory FakePostgrest), the gateway and the read-pointer RPC faked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createInklingDb } from '../../test/fake-inkling-db';
import type { FakePostgrest, Row } from '../../test/fake-postgrest';

const ME = '11111111-1111-4111-8111-111111111111';
const SOMEONE = '22222222-2222-4222-8222-222222222222';
const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY = 'chat:conversation-closing';

let db: FakePostgrest;
vi.mock('../user-resolver', async (original) => ({
  ...(await original<typeof import('../user-resolver')>()),
  resolveUserOrThrow: vi.fn(async () => ({ user: { id: ME }, resolvedBy: 'userId' })),
}));
const gateway = vi.hoisted(() => ({
  dispatchTrigger: vi.fn(() => ({ success: true, accepted: true })),
  processTrigger: vi.fn(async () => ({ success: true })),
}));
vi.mock('../../channels/agent-gateway', () => ({
  getAgentGateway: vi.fn(() => gateway),
}));
const woken = (): string[] =>
  (gateway.dispatchTrigger.mock.calls as unknown as Array<[{ toSlug: string }]>)
    .map(([payload]) => payload.toSlug)
    .sort();
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
import {
  CLOSING_TEXT_FOR,
  CLOSING_TEXT_MAX,
  closingText,
  postClosingTextIfSilent,
  type ClosingTextTurn,
} from './inkling-closing-text';
import { resetReplyChains } from './inkling-reply-chain';

type Handler = (req: Request, res: Response) => Promise<void>;
/* eslint-disable @typescript-eslint/no-explicit-any */
const route = (path: string): Handler =>
  (router as any).stack
    .find((x: any) => x.route?.path === path && x.route.methods.post)
    .route.stack.at(-1).handle;
/* eslint-enable @typescript-eslint/no-explicit-any */
const create = route('/threads');
const reply = route('/threads/reply');

async function call(handler: Handler, body: Row): Promise<{ status: number; body: Row }> {
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
      inkUserId: ME,
      inkWorkspaceId: WS,
      inkWorkspaceRole: 'owner',
    } as unknown as Request,
    res as unknown as Response
  );
  return answer;
}

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
const dataComposer = { repositories: {}, getClient: () => db } as never;

const messages = () => db.rows('inbox_thread_messages');
const threadOf = (key: string) => db.rows('inbox_threads').find((t) => t.thread_key === key)!;
const lastMessageIn = (key: string) => {
  const thread = threadOf(key);
  return messages()
    .filter((m) => m.thread_id === thread.id)
    .at(-1)!;
};

/** The owner starts the conversation; returns what a wake for that message names. */
async function ownerStarts(
  recipients: string[] = ['pip'],
  key = KEY
): Promise<Omit<ClosingTextTurn, 'result'>> {
  const started = await call(create, { key, recipients, content: 'hi' });
  expect(started.status).toBe(200);
  const waking = lastMessageIn(key);
  return {
    userId: ME,
    identityId: 'sb-pip',
    threadId: threadOf(key).id as string,
    threadKey: key,
    threadMessageId: waking.id as string,
  };
}

const SILENT = {
  success: true,
  admitted: true,
  finalTextResponse: "  I couldn't read our conversation, so I didn't reply.  ",
  sessionId: '44444444-4444-4444-8444-444444444444',
};

/** The inkling's own reply, as the server sends one for it. */
async function inklingReplies(content = 'here I am', key = KEY): Promise<void> {
  await handleSendToInbox(
    { userId: ME, threadKey: key, recipientSlug: 'pip', content },
    dataComposer,
    {
      sender: {
        principal: { kind: 'sb', sbId: 'sb-pip', sbSlug: 'pip', userId: ME, workspaceId: WS },
        workspaceId: WS,
      },
    }
  );
}

beforeEach(() => {
  gateway.dispatchTrigger.mockClear();
  gateway.processTrigger.mockClear();
  resetReplyChains();
  db = createInklingDb();
  db.rpcHandlers.advance_thread_read_pointer = () => ({ data: true, error: null });
  db.seed('workspace_members', { workspace_id: WS, user_id: ME, role: 'owner' });
  sb('pip', OWNER_TEST_INKLING);
  sb('moss', OWNER_TEST_INKLING);
  sb('fern');
  vi.stubEnv('INKLING_OWNER_TEST_USER_ID', ME);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a silent turn on its own conversation', () => {
  it("posts the closing text once, as the inkling's message, and wakes nobody", async () => {
    const wake = await ownerStarts();
    gateway.dispatchTrigger.mockClear();
    const before = messages().length;

    const outcome = await postClosingTextIfSilent(dataComposer, { ...wake, result: SILENT });

    expect(outcome).toMatchObject({ posted: true });
    expect(messages()).toHaveLength(before + 1);
    const posted = messages().at(-1)!;
    expect(posted).toMatchObject({
      thread_id: wake.threadId,
      sender_kind: 'sb',
      sender_sb_id: 'sb-pip',
      content: "I couldn't read our conversation, so I didn't reply.",
    });
    expect((posted.metadata as Row)[CLOSING_TEXT_FOR]).toBe(wake.threadMessageId);
    expect(woken()).toEqual([]);
  });

  it('posts nothing a second time: its own post is the reply', async () => {
    const wake = await ownerStarts();
    expect(await postClosingTextIfSilent(dataComposer, { ...wake, result: SILENT })).toMatchObject({
      posted: true,
    });
    const after = messages().length;
    expect(await postClosingTextIfSilent(dataComposer, { ...wake, result: SILENT })).toEqual({
      posted: false,
      skipped: 'replied',
    });
    expect(messages()).toHaveLength(after);
  });

  it('two completions racing for the same message post once', async () => {
    const wake = await ownerStarts();
    const before = messages().length;
    const outcomes = await Promise.all([
      postClosingTextIfSilent(dataComposer, { ...wake, result: SILENT }),
      postClosingTextIfSilent(dataComposer, { ...wake, result: SILENT }),
    ]);
    expect(outcomes.filter((o) => o.posted)).toHaveLength(1);
    expect(outcomes).toContainEqual({ posted: false, skipped: 'in-flight' });
    expect(messages()).toHaveLength(before + 1);
  });

  it("the owner's own follow-up isn't a reply: it still posts", async () => {
    const wake = await ownerStarts();
    // Sent while the turn ran; it queues behind it.
    expect((await call(reply, { key: KEY, content: 'are you there?' })).status).toBe(200);
    const before = messages().length;
    expect(await postClosingTextIfSilent(dataComposer, { ...wake, result: SILENT })).toMatchObject({
      posted: true,
    });
    expect(messages()).toHaveLength(before + 1);
    expect(messages().at(-1)).toMatchObject({ sender_sb_id: 'sb-pip' });
  });

  it("an earlier turn's reply doesn't count: only one after the waking message does", async () => {
    await ownerStarts();
    await inklingReplies('answer to the first');
    const second = await call(reply, { key: KEY, content: 'and another thing' });
    expect(second.status).toBe(200);
    const waking = lastMessageIn(KEY);
    const before = messages().length;

    const outcome = await postClosingTextIfSilent(dataComposer, {
      userId: ME,
      identityId: 'sb-pip',
      threadId: threadOf(KEY).id as string,
      threadKey: KEY,
      threadMessageId: waking.id as string,
      result: SILENT,
    });

    expect(outcome).toMatchObject({ posted: true });
    expect(messages()).toHaveLength(before + 1);
  });
});

describe('nothing is posted', () => {
  it('when the inkling already replied after the waking message', async () => {
    const wake = await ownerStarts();
    await inklingReplies();
    const before = messages().length;
    expect(await postClosingTextIfSilent(dataComposer, { ...wake, result: SILENT })).toEqual({
      posted: false,
      skipped: 'replied',
    });
    expect(messages()).toHaveLength(before);
  });

  it('for a failed, stopped, unadmitted or carried turn', async () => {
    const wake = await ownerStarts();
    const before = messages().length;
    for (const result of [
      { ...SILENT, success: false },
      { ...SILENT, admitted: false },
      { ...SILENT, admitted: undefined },
      { ...SILENT, wake: { coalescedInto: '55555555-5555-4555-8555-555555555555' } },
    ]) {
      expect(await postClosingTextIfSilent(dataComposer, { ...wake, result })).toEqual({
        posted: false,
        skipped: 'turn',
      });
    }
    expect(messages()).toHaveLength(before);
  });

  it('when the turn ended with no text', async () => {
    const wake = await ownerStarts();
    for (const finalTextResponse of [undefined, '', ' \n\t ']) {
      expect(
        await postClosingTextIfSilent(dataComposer, {
          ...wake,
          result: { ...SILENT, finalTextResponse },
        })
      ).toEqual({ posted: false, skipped: 'empty' });
    }
  });

  it('when the wake names no thread or waking message, or one from another thread', async () => {
    const wake = await ownerStarts();
    await ownerStarts(['pip'], 'chat:conversation-other');
    const elsewhere = lastMessageIn('chat:conversation-other');
    for (const over of [
      { threadId: undefined },
      { threadKey: undefined },
      { threadMessageId: undefined },
      { identityId: undefined },
      { threadMessageId: elsewhere.id as string },
    ]) {
      expect(
        await postClosingTextIfSilent(dataComposer, { ...wake, ...over, result: SILENT }),
        JSON.stringify(over)
      ).toEqual({ posted: false, skipped: 'no-trigger' });
    }
  });

  it("for an SB that isn't an inkling, or another account's", async () => {
    const started = await call(create, { key: 'pr:9', recipients: ['fern'], content: 'hi' });
    expect(started.status).toBe(200);
    const fernWake = {
      userId: ME,
      identityId: 'sb-fern',
      threadId: threadOf('pr:9').id as string,
      threadKey: 'pr:9',
      threadMessageId: lastMessageIn('pr:9').id as string,
    };
    expect(await postClosingTextIfSilent(dataComposer, { ...fernWake, result: SILENT })).toEqual({
      posted: false,
      skipped: 'not-inkling',
    });

    const wake = await ownerStarts();
    expect(
      await postClosingTextIfSilent(dataComposer, { ...wake, userId: SOMEONE, result: SILENT })
    ).toEqual({ posted: false, skipped: 'not-inkling' });
  });

  it("on a thread that isn't the inkling's conversation", async () => {
    const wake = await ownerStarts();
    // The mark is what makes a thread a conversation; the key alone doesn't.
    const thread = threadOf(KEY);
    thread.metadata = {};
    expect(await postClosingTextIfSilent(dataComposer, { ...wake, result: SILENT })).toEqual({
      posted: false,
      skipped: 'not-conversation',
    });
    thread.metadata = { inklingConversation: true };
    // The key the wake names must be the thread's own.
    expect(
      await postClosingTextIfSilent(dataComposer, {
        ...wake,
        threadKey: 'chat:else',
        result: SILENT,
      })
    ).toEqual({ posted: false, skipped: 'not-conversation' });
    // And the inkling must be one of its members.
    db.rows('inbox_thread_participants').splice(
      db.rows('inbox_thread_participants').findIndex((p) => p.sb_id === 'sb-pip'),
      1
    );
    expect(await postClosingTextIfSilent(dataComposer, { ...wake, result: SILENT })).toEqual({
      posted: false,
      skipped: 'not-conversation',
    });
  });

  it('in a group conversation, where staying quiet can be the reply', async () => {
    const wake = await ownerStarts(['pip', 'moss']);
    const before = messages().length;
    expect(await postClosingTextIfSilent(dataComposer, { ...wake, result: SILENT })).toEqual({
      posted: false,
      skipped: 'group',
    });
    expect(messages()).toHaveLength(before);
  });

  it('when a read fails, and decides nothing', async () => {
    const wake = await ownerStarts();
    const before = messages().length;
    const originalFrom = db.from.bind(db);
    db.from = ((table: string) => {
      if (table === 'inbox_thread_participants') {
        return { select: () => ({ eq: async () => ({ data: null, error: { message: 'down' } }) }) };
      }
      return originalFrom(table);
    }) as typeof db.from;
    expect(await postClosingTextIfSilent(dataComposer, { ...wake, result: SILENT })).toEqual({
      posted: false,
      skipped: 'unreadable',
    });
    db.from = originalFrom;
    expect(messages()).toHaveLength(before);
  });

  it('when the gate refuses the post: the owner test is off', async () => {
    const wake = await ownerStarts();
    const before = messages().length;
    vi.stubEnv('INKLING_OWNER_TEST_USER_ID', '');
    const outcome = await postClosingTextIfSilent(dataComposer, { ...wake, result: SILENT });
    expect(outcome).toEqual({ posted: false, error: 'Inklings are not open on this server' });
    expect(messages()).toHaveLength(before);
  });
});

describe('the text', () => {
  it('is trimmed, null when blank, and cut by code points so a pair is never split', () => {
    expect(closingText(undefined)).toBeNull();
    expect(closingText(' \n ')).toBeNull();
    expect(closingText('  hello  ')).toBe('hello');
    const long = 'a'.repeat(CLOSING_TEXT_MAX - 2) + '😀😀😀';
    const cut = closingText(long)!;
    expect(Array.from(cut)).toHaveLength(CLOSING_TEXT_MAX);
    expect(cut.endsWith('😀…')).toBe(true);
    expect(closingText('b'.repeat(CLOSING_TEXT_MAX))).toBe('b'.repeat(CLOSING_TEXT_MAX));
  });
});
