/**
 * An inkling's turn that ended without a word to its owner gets its closing
 * text posted as its message (task 9edf62fe), through the real admin create
 * route and the real handleSendToInbox, with only the database (the
 * in-memory FakePostgrest), the gateway and the read-pointer RPC faked.
 *
 * Each case plays a turn's life: the owner's message lands, the turn starts
 * (its boundary is read), things happen, the turn ends (the decision).
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
  closingTextTurnHooks,
  postClosingTextIfSilent,
  readTurnBoundary,
  type ClosingTextTurn,
  type ClosingTextWake,
  type TurnBoundary,
} from './inkling-closing-text';
import { resetReplyChains } from './inkling-reply-chain';
import type { SessionResult, SessionRequest } from '../sessions/types';
import { logger } from '../../utils/logger';

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
const wakeFor = (key: string, identityId = 'sb-pip'): ClosingTextWake => ({
  userId: ME,
  identityId,
  threadId: threadOf(key).id as string,
  threadKey: key,
  threadMessageId: lastMessageIn(key).id as string,
});

/** The owner starts the conversation; returns what a wake for that message names. */
async function ownerStarts(recipients: string[] = ['pip'], key = KEY): Promise<ClosingTextWake> {
  const started = await call(create, { key, recipients, content: 'hi' });
  expect(started.status).toBe(200);
  return wakeFor(key);
}

/** The owner writes again; returns the wake for that message. */
async function ownerWrites(content: string, key = KEY): Promise<ClosingTextWake> {
  expect((await call(reply, { key, content })).status).toBe(200);
  return wakeFor(key);
}

/** The turn begins: the boundary its hooks read. */
const turnStarts = (wake: ClosingTextWake): Promise<TurnBoundary> =>
  readTurnBoundary(dataComposer, wake.threadId!);

const SILENT: ClosingTextTurn['result'] = {
  success: true,
  admitted: true,
  finalTextResponse: "  I couldn't read our conversation, so I didn't reply.  ",
  sessionId: '44444444-4444-4444-8444-444444444444',
};

/** The turn ends: the decision. */
const turnEnds = (
  wake: ClosingTextWake,
  boundary: TurnBoundary | undefined,
  result: ClosingTextTurn['result'] = SILENT
) => postClosingTextIfSilent(dataComposer, { ...wake, boundary, result });

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

const ownerMembership = () =>
  db.rows('workspace_members').find((m) => m.user_id === ME && m.workspace_id === WS)!;

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
    const boundary = await turnStarts(wake);
    gateway.dispatchTrigger.mockClear();
    const before = messages().length;

    expect(await turnEnds(wake, boundary)).toMatchObject({ posted: true });

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

  it('a replay of the same wake, in a later turn, posts nothing more', async () => {
    const wake = await ownerStarts();
    expect(await turnEnds(wake, await turnStarts(wake))).toMatchObject({ posted: true });
    const after = messages().length;
    // A new turn for the same message: its boundary is after the first post.
    expect(await turnEnds(wake, await turnStarts(wake))).toEqual({
      posted: false,
      skipped: 'already-posted',
    });
    expect(messages()).toHaveLength(after);
  });

  it('two completions racing for the same message post once', async () => {
    const wake = await ownerStarts();
    const boundary = await turnStarts(wake);
    const before = messages().length;
    const outcomes = await Promise.all([turnEnds(wake, boundary), turnEnds(wake, boundary)]);
    expect(outcomes.filter((o) => o.posted)).toHaveLength(1);
    expect(outcomes).toContainEqual({ posted: false, skipped: 'in-flight' });
    expect(messages()).toHaveLength(before + 1);
  });

  it("an earlier turn's reply doesn't silence a later turn (Lumen, #769)", async () => {
    // A wakes; its turn starts. B arrives while A runs, and A replies.
    const wakeA = await ownerStarts();
    const boundaryA = await turnStarts(wakeA);
    const wakeB = await ownerWrites('and another thing');
    await inklingReplies('answer to the first');
    expect(await turnEnds(wakeA, boundaryA)).toEqual({ posted: false, skipped: 'replied' });

    // B's turn starts after A's ended, says nothing, and ends.
    const boundaryB = await turnStarts(wakeB);
    const before = messages().length;
    expect(await turnEnds(wakeB, boundaryB)).toMatchObject({ posted: true });
    expect(messages()).toHaveLength(before + 1);
    expect((messages().at(-1)!.metadata as Row)[CLOSING_TEXT_FOR]).toBe(wakeB.threadMessageId);
  });

  it("the owner's own follow-up during the turn isn't a reply: it still posts", async () => {
    const wake = await ownerStarts();
    const boundary = await turnStarts(wake);
    await ownerWrites('are you there?');
    const before = messages().length;
    expect(await turnEnds(wake, boundary)).toMatchObject({ posted: true });
    expect(messages()).toHaveLength(before + 1);
    expect(messages().at(-1)).toMatchObject({ sender_sb_id: 'sb-pip' });
  });
});

describe('nothing is posted', () => {
  it('when the inkling replied during the turn', async () => {
    const wake = await ownerStarts();
    const boundary = await turnStarts(wake);
    await inklingReplies();
    const before = messages().length;
    expect(await turnEnds(wake, boundary)).toEqual({ posted: false, skipped: 'replied' });
    expect(messages()).toHaveLength(before);
  });

  it('when the turn routed a reply of its own, landed or not', async () => {
    const wake = await ownerStarts();
    const boundary = await turnStarts(wake);
    const before = messages().length;
    expect(
      await turnEnds(wake, boundary, { ...SILENT, responses: [{ channel: 'api', content: 'hi' }] })
    ).toEqual({ posted: false, skipped: 'replied' });
    expect(messages()).toHaveLength(before);
  });

  it('for a failed, stopped, unadmitted or carried turn', async () => {
    const wake = await ownerStarts();
    const boundary = await turnStarts(wake);
    const before = messages().length;
    for (const result of [
      { ...SILENT, success: false },
      { ...SILENT, admitted: false },
      { ...SILENT, admitted: undefined },
      { ...SILENT, wake: { coalescedInto: '55555555-5555-4555-8555-555555555555' } },
    ]) {
      expect(await turnEnds(wake, boundary, result)).toEqual({ posted: false, skipped: 'turn' });
    }
    expect(messages()).toHaveLength(before);
  });

  it('when the turn ended with no text', async () => {
    const wake = await ownerStarts();
    const boundary = await turnStarts(wake);
    for (const finalTextResponse of [
      undefined,
      '',
      ' \n\t ',
      '(local tool call emitted; see tool results above)',
      '<invoke name="signal_status"><parameter name="status">completed</parameter></invoke>',
      '<invoke name="signal_status"></invoke>',
    ]) {
      expect(await turnEnds(wake, boundary, { ...SILENT, finalTextResponse })).toEqual({
        posted: false,
        skipped: 'empty',
      });
    }
  });

  it("when the turn's start was never read, or its read failed", async () => {
    const wake = await ownerStarts();
    for (const boundary of [undefined, 'unreadable' as const]) {
      expect(await turnEnds(wake, boundary)).toEqual({ posted: false, skipped: 'unreadable' });
    }
  });

  it('when the wake names no thread or waking message, or one from another thread', async () => {
    const wake = await ownerStarts();
    const boundary = await turnStarts(wake);
    const elsewhere = await ownerStarts(['pip'], 'chat:conversation-other');
    for (const over of [
      { threadId: undefined },
      { threadKey: undefined },
      { threadMessageId: undefined },
      { identityId: undefined },
      { threadMessageId: elsewhere.threadMessageId },
    ]) {
      expect(await turnEnds({ ...wake, ...over }, boundary), JSON.stringify(over)).toEqual({
        posted: false,
        skipped: 'no-trigger',
      });
    }
  });

  it("for an SB that isn't an inkling, or another account's", async () => {
    expect((await call(create, { key: 'pr:9', recipients: ['fern'], content: 'hi' })).status).toBe(
      200
    );
    const fernWake = wakeFor('pr:9', 'sb-fern');
    expect(await turnEnds(fernWake, await turnStarts(fernWake))).toEqual({
      posted: false,
      skipped: 'not-inkling',
    });

    const wake = await ownerStarts();
    expect(await turnEnds({ ...wake, userId: SOMEONE }, await turnStarts(wake))).toEqual({
      posted: false,
      skipped: 'not-inkling',
    });
  });

  it("on a thread that isn't the inkling's conversation", async () => {
    const wake = await ownerStarts();
    const boundary = await turnStarts(wake);
    // The mark is what makes a thread a conversation; the key alone doesn't.
    const thread = threadOf(KEY);
    thread.metadata = {};
    expect(await turnEnds(wake, boundary)).toEqual({ posted: false, skipped: 'not-conversation' });
    thread.metadata = { inklingConversation: true };
    // The key the wake names must be the thread's own.
    expect(await turnEnds({ ...wake, threadKey: 'chat:else' }, boundary)).toEqual({
      posted: false,
      skipped: 'not-conversation',
    });
    // And the inkling must be one of its members.
    db.rows('inbox_thread_participants').splice(
      db.rows('inbox_thread_participants').findIndex((p) => p.sb_id === 'sb-pip'),
      1
    );
    expect(await turnEnds(wake, boundary)).toEqual({ posted: false, skipped: 'not-conversation' });
  });

  it('in a group conversation, where staying quiet can be the reply', async () => {
    const wake = await ownerStarts(['pip', 'moss']);
    const before = messages().length;
    expect(await turnEnds(wake, await turnStarts(wake))).toEqual({
      posted: false,
      skipped: 'group',
    });
    expect(messages()).toHaveLength(before);
  });

  it('when a read fails, and decides nothing', async () => {
    const wake = await ownerStarts();
    const boundary = await turnStarts(wake);
    const before = messages().length;
    const originalFrom = db.from.bind(db);
    db.from = ((table: string) => {
      if (table === 'inbox_thread_participants') {
        return { select: () => ({ eq: async () => ({ data: null, error: { message: 'down' } }) }) };
      }
      return originalFrom(table);
    }) as typeof db.from;
    expect(await turnEnds(wake, boundary)).toEqual({ posted: false, skipped: 'unreadable' });
    db.from = originalFrom;
    expect(messages()).toHaveLength(before);
  });

  it('when the gate refuses the post: the owner test is off', async () => {
    const wake = await ownerStarts();
    const boundary = await turnStarts(wake);
    const before = messages().length;
    vi.stubEnv('INKLING_OWNER_TEST_USER_ID', '');
    expect(await turnEnds(wake, boundary)).toEqual({
      posted: false,
      error: 'Inklings are not open on this server',
    });
    expect(messages()).toHaveLength(before);
  });

  it("when the owner's role no longer writes, or they've left the workspace (Lumen, #769)", async () => {
    const wake = await ownerStarts();
    const boundary = await turnStarts(wake);
    const before = messages().length;

    ownerMembership().role = 'viewer';
    expect(await turnEnds(wake, boundary)).toEqual({
      posted: false,
      error: 'Your role in this workspace (viewer) cannot send to a thread',
    });

    db.rows('workspace_members').splice(db.rows('workspace_members').indexOf(ownerMembership()), 1);
    expect(await turnEnds(wake, boundary)).toEqual({
      posted: false,
      error: "pip's owner cannot act in this workspace: not a member",
    });
    expect(messages()).toHaveLength(before);
  });
});

describe('the turn hooks', () => {
  const sessionResult = (over: Partial<SessionResult> = {}): SessionResult =>
    ({
      ...SILENT,
      sessionId: SILENT.sessionId!,
      responses: [],
      sessionStatus: 'active',
      compactionTriggered: false,
      ...over,
    }) as SessionResult;

  it("read the turn's start, and post at its end when it said nothing", async () => {
    const wake = await ownerStarts();
    const hooks = closingTextTurnHooks(dataComposer, wake);
    await hooks.start();
    await ownerWrites('still there?');
    const before = messages().length;
    await hooks.end(sessionResult());
    expect(messages()).toHaveLength(before + 1);
    expect(messages().at(-1)).toMatchObject({ sender_sb_id: 'sb-pip' });
  });

  it('post nothing when the inkling replied between start and end', async () => {
    const wake = await ownerStarts();
    const hooks = closingTextTurnHooks(dataComposer, wake);
    await hooks.start();
    await inklingReplies();
    const before = messages().length;
    await hooks.end(sessionResult());
    expect(messages()).toHaveLength(before);
  });

  it("cost another SB's turn one read, and post nothing", async () => {
    expect((await call(create, { key: 'pr:9', recipients: ['fern'], content: 'hi' })).status).toBe(
      200
    );
    const hooks = closingTextTurnHooks(dataComposer, wakeFor('pr:9', 'sb-fern'));
    const read: string[] = [];
    const originalFrom = db.from.bind(db);
    db.from = ((table: string) => {
      read.push(table);
      return originalFrom(table);
    }) as typeof db.from;
    const before = messages().length;
    vi.mocked(logger.warn).mockClear();
    await hooks.start();
    await hooks.end(sessionResult());
    db.from = originalFrom;
    expect(read).toEqual(['agent_identities']);
    expect(messages()).toHaveLength(before);
    // Nor a warning: it isn't a decision that failed, there was none to make.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("judge without a boundary when the turn's start was never called", async () => {
    const wake = await ownerStarts();
    const before = messages().length;
    await closingTextTurnHooks(dataComposer, wake).end(sessionResult());
    expect(messages()).toHaveLength(before);
  });
});

describe('the boundary', () => {
  it("is the conversation's newest message as the turn begins", async () => {
    const wake = await ownerStarts();
    await ownerWrites('second');
    expect(await turnStarts(wake)).toEqual({ createdAt: lastMessageIn(KEY).created_at });
  });

  it('is unreadable when the read fails', async () => {
    const wake = await ownerStarts();
    const originalFrom = db.from.bind(db);
    db.from = ((table: string) => {
      if (table === 'inbox_thread_messages') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({ limit: async () => ({ data: null, error: { message: 'down' } }) }),
            }),
          }),
        };
      }
      return originalFrom(table);
    }) as typeof db.from;
    expect(await turnStarts(wake)).toBe('unreadable');
    db.from = originalFrom;
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

describe('the common send_response inkling channel', () => {
  async function send(conversationId: string, content = 'An invented reply.', extra = {}) {
    const { handleSendResponse } = await import('../../mcp/tools/response-handlers');
    const { runWithRequestContext } = await import('../../utils/request-context');
    return runWithRequestContext(
      { userId: ME, sbId: 'sb-pip', sbSlug: 'pip', workspaceId: WS },
      () =>
        handleSendResponse({ channel: 'inkling', conversationId, content, ...extra }, dataComposer)
    );
  }

  it('does not retain an external-listener delivery mark for an Inkling conversation', async () => {
    const { consumeExplicitResponse } = await import('../../mcp/tools/response-handlers');
    const key = 'chat:synthetic-no-external-mark';
    await ownerStarts(['pip'], key);
    expect((await send(key)).isError).not.toBe(true);
    expect(consumeExplicitResponse('inkling', key)).toBe(false);
  });

  it('stores as the caller through the real thread gate, wakes nobody, and suppresses fallback', async () => {
    const wake = await ownerStarts();
    const boundary = await turnStarts(wake);
    gateway.dispatchTrigger.mockClear();
    const result = await send(KEY);
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      success: true,
      channel: 'inkling',
      conversationId: KEY,
    });
    expect(messages().at(-1)).toMatchObject({
      sender_sb_id: 'sb-pip',
      content: 'An invented reply.',
    });
    expect(woken()).toEqual([]);
    expect(await turnEnds(wake, boundary)).toEqual({ posted: false, skipped: 'replied' });
  });

  it('does not send to another conversation, create one, or add the caller', async () => {
    await ownerStarts(['moss']);
    const before = messages().length;
    for (const key of [KEY, 'chat:conversation-missing'])
      expect((await send(key)).isError).toBe(true);
    expect(messages()).toHaveLength(before);
    expect(db.rows('inbox_threads')).toHaveLength(1);
  });

  it('keeps owner-test and current write-role checks', async () => {
    await ownerStarts();
    const before = messages().length;
    ownerMembership().role = 'viewer';
    expect((await send(KEY)).isError).toBe(true);
    ownerMembership().role = 'owner';
    vi.stubEnv('INKLING_OWNER_TEST_USER_ID', '');
    expect((await send(KEY)).isError).toBe(true);
    expect(messages()).toHaveLength(before);
  });

  it('accepts the conversation UUID but refuses another workspace or an unmarked thread', async () => {
    await ownerStarts();
    const thread = threadOf(KEY);
    const uuid = '99999999-9999-4999-8999-999999999999';
    const previousId = thread.id;
    thread.id = uuid;
    for (const row of db.rows('inbox_thread_participants')) {
      if (row.thread_id === previousId) row.thread_id = uuid;
    }
    expect((await send(uuid)).isError).not.toBe(true);
    expect(messages().at(-1)?.thread_id).toBe(uuid);
    const before = messages().length;
    thread.workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    expect((await send(uuid)).isError).toBe(true);
    expect((await send(KEY)).isError).toBe(true);
    thread.workspace_id = WS;
    thread.metadata = {};
    expect((await send(KEY)).isError).toBe(true);
    expect(messages()).toHaveLength(before);
  });

  it('refuses unsupported media and empty content instead of claiming delivery', async () => {
    await ownerStarts();
    const before = messages().length;
    expect((await send(KEY, ' ')).isError).toBe(true);
    expect(
      (await send(KEY, 'Caption', { media: [{ type: 'image', path: '/invented.jpg' }] })).isError
    ).toBe(true);
    expect((await send(KEY, 'Voice', { voiceReply: true })).isError).toBe(true);
    expect(messages()).toHaveLength(before);
  });
});

// Phase 2 gate 3 (ink://specs/inkling-multi-person-groups): a space-turn
// reply is checked against one thread, by id, and must be written to that
// thread or nowhere. Through the real policy, resolver, handler-argument pin,
// response handler, inkling send and inbox send (Lumen, PR #867 review).
describe('a space-turn reply stays on the thread it was checked against', () => {
  const REPLACEMENT_ID = '99999999-9999-4999-8999-999999999999';
  const REPLY = 'A synthetic scoped reply.';

  /**
   * After the inkling send's membership check, before the inbox send runs:
   * the checked thread is deleted, or deleted and recreated under the same
   * key with the same members.
   */
  function changeThreadAfterTheCheck(change: 'replace' | 'delete', originalId: string) {
    let changed = false;
    const originalFrom = db.from.bind(db);
    db.from = ((table: string) => {
      const query = originalFrom(table);
      if (table === 'inbox_thread_participants') {
        const originalSingle = query.maybeSingle.bind(query);
        query.maybeSingle = async () => {
          const result = await originalSingle();
          if (!changed && result.data) {
            changed = true;
            const oldThread = threadOf(KEY);
            const members = db
              .rows('inbox_thread_participants')
              .filter((row) => row.thread_id === originalId);
            db.tables.inbox_threads = db.rows('inbox_threads').filter((t) => t.id !== originalId);
            db.tables.inbox_thread_participants = db
              .rows('inbox_thread_participants')
              .filter((row) => row.thread_id !== originalId);
            if (change === 'replace') {
              db.seed('inbox_threads', { ...oldThread, id: REPLACEMENT_ID });
              for (const member of members) {
                db.seed('inbox_thread_participants', { ...member, thread_id: REPLACEMENT_ID });
              }
            }
          }
          return result;
        };
      }
      return query;
    }) as typeof db.from;
    return {
      changed: () => changed,
      restore: () => {
        db.from = originalFrom;
      },
    };
  }

  async function spaceTurnReply(originalId: string) {
    const { handleSendResponse } = await import('../../mcp/tools/response-handlers');
    const { runWithRequestContext } = await import('../../utils/request-context');
    const { decideSpaceTurnCall, spaceTurnHandlerArgs } =
      await import('../../mcp/tools/space-turn-policy');
    const { createSpaceTurnThreadResolver } =
      await import('../../mcp/tools/space-turn-thread-resolver');
    const context = {
      userId: ME,
      sbId: 'sb-pip',
      sbSlug: 'pip',
      workspaceId: WS,
      tokenSlug: 'pip',
      tokenSbId: 'sb-pip',
      agentTokenBound: true,
      tokenScope: 'mcp:space-turn',
      tokenThreadKey: KEY,
      tokenThreadId: originalId,
      tokenWorkspaceId: WS,
    };
    const args = { channel: 'inkling', conversationId: KEY, content: REPLY };
    return runWithRequestContext(context, async () => {
      const decision = await decideSpaceTurnCall(
        'send_response',
        args,
        context,
        createSpaceTurnThreadResolver(dataComposer)
      );
      expect(decision).toMatchObject({ allowed: true, thread: { id: originalId } });
      if (!decision.allowed || !decision.thread) throw new Error('The reply was not admitted');
      const [pinned] = spaceTurnHandlerArgs('send_response', [args], decision.thread);
      expect(pinned).toMatchObject({ conversationId: originalId });
      return handleSendResponse(pinned, dataComposer);
    });
  }

  const replies = () => messages().filter((row) => row.content === REPLY);

  it('stores the reply on the checked thread when nothing changed (control)', async () => {
    await ownerStarts();
    const originalId = threadOf(KEY).id as string;
    const result = await spaceTurnReply(originalId);
    expect(result.isError).not.toBe(true);
    expect(replies().map((row) => row.thread_id)).toEqual([originalId]);
  });

  it('refuses when the thread was replaced under the same key, writing nothing', async () => {
    await ownerStarts();
    const originalId = threadOf(KEY).id as string;
    const change = changeThreadAfterTheCheck('replace', originalId);
    try {
      const result = await spaceTurnReply(originalId);
      expect(change.changed()).toBe(true);
      expect(result.isError).toBe(true);
      expect(replies()).toEqual([]);
    } finally {
      change.restore();
    }
  });

  it('refuses when the thread disappeared, creating nothing under its key', async () => {
    await ownerStarts();
    const originalId = threadOf(KEY).id as string;
    const change = changeThreadAfterTheCheck('delete', originalId);
    try {
      const result = await spaceTurnReply(originalId);
      expect(change.changed()).toBe(true);
      expect(result.isError).toBe(true);
      expect(replies()).toEqual([]);
      expect(db.rows('inbox_threads').filter((t) => t.thread_key === KEY)).toEqual([]);
    } finally {
      change.restore();
    }
  });

  describe('the inbox send bound to a thread id', () => {
    const asPip = {
      sender: {
        principal: {
          kind: 'sb' as const,
          sbId: 'sb-pip',
          sbSlug: 'pip',
          userId: ME,
          workspaceId: WS,
        },
        workspaceId: WS,
      },
    };

    it('writes to that thread when the key still names it (control)', async () => {
      await ownerStarts();
      const id = threadOf(KEY).id as string;
      await handleSendToInbox(
        { userId: ME, threadKey: KEY, recipientSlug: 'pip', content: REPLY },
        dataComposer,
        { ...asPip, expectedThreadId: id }
      );
      expect(replies().map((row) => row.thread_id)).toEqual([id]);
    });

    it('refuses when the key names another thread, or none, and creates nothing', async () => {
      await ownerStarts();
      const threadsBefore = db.rows('inbox_threads').length;
      for (const [threadKey, expectedThreadId] of [
        [KEY, REPLACEMENT_ID],
        ['chat:conversation-never-made', threadOf(KEY).id as string],
      ]) {
        await expect(
          handleSendToInbox(
            { userId: ME, threadKey, recipientSlug: 'pip', content: REPLY },
            dataComposer,
            { ...asPip, expectedThreadId }
          )
        ).rejects.toThrow(/gone or was replaced/);
      }
      expect(replies()).toEqual([]);
      expect(db.rows('inbox_threads')).toHaveLength(threadsBefore);
    });

    // A key lookup after the check could find a thread that replaced the
    // checked one; the bound send makes none, so every write uses the id.
    it('looks the key up once, for its check, and writes to the checked id', async () => {
      await ownerStarts();
      const id = threadOf(KEY).id as string;
      let keyLookups = 0;
      const originalFrom = db.from.bind(db);
      db.from = ((name: string) => {
        const query = originalFrom(name);
        if (name === 'inbox_threads') {
          const originalEq = query.eq.bind(query);
          query.eq = (column: string, value: unknown) => {
            if (column === 'thread_key') keyLookups += 1;
            return originalEq(column, value);
          };
        }
        return query;
      }) as typeof db.from;
      try {
        await handleSendToInbox(
          { userId: ME, threadKey: KEY, recipientSlug: 'pip', content: REPLY },
          dataComposer,
          { ...asPip, expectedThreadId: id }
        );
      } finally {
        db.from = originalFrom;
      }
      expect(keyLookups).toBe(1);
      expect(replies().map((row) => row.thread_id)).toEqual([id]);
    });

    it('refuses a bound send that names no thread key', async () => {
      await ownerStarts();
      await expect(
        handleSendToInbox({ userId: ME, recipientSlug: 'pip', content: REPLY }, dataComposer, {
          ...asPip,
          expectedThreadId: threadOf(KEY).id as string,
        })
      ).rejects.toThrow(/needs its thread key/);
      expect(replies()).toEqual([]);
    });
  });
});

describe('consecutive owner messages through the real session queue and closing hooks', () => {
  it('stores the follow-ups while busy, then answers their verified batch once', async () => {
    const { SessionService } = await import('../sessions/session-service');
    const firstWake = await ownerStarts();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processMessage = vi.fn(async (request: SessionRequest) => {
      if (processMessage.mock.calls.length === 1) await held;
      return {
        success: true,
        sessionId: SILENT.sessionId!,
        responses: [],
        finalTextResponse: request.content.includes('Wake 2')
          ? 'Reply to both follow-ups.'
          : 'First reply.',
        sessionStatus: 'active',
        compactionTriggered: false,
      } as SessionResult;
    });
    // No constructor: only the real queue and hook methods run. Routing,
    // activity persistence and provider execution are inert mocks; all thread
    // reads and writes use the fake database already used by this suite.
    const service = Object.assign(Object.create(SessionService.prototype) as SessionService, {
      supabase: db,
      activityStream: { logMessage: vi.fn(async () => ({})) },
      processingLocks: new Set<string>(),
      pendingQueues: new Map<string, unknown[]>(),
      getOrCreateSession: vi.fn(async () => ({ id: SILENT.sessionId!, sbId: 'sb-pip' })),
      classifyTurnIdentity: vi.fn(async () => ({ kind: 'inkling', id: 'sb-pip', userId: ME })),
      leaseTurnEpochs: vi.fn(async () => new Set()),
      processMessage,
    });
    const request = (wake: ClosingTextWake, content: string): SessionRequest => ({
      userId: ME,
      sbSlug: 'pip',
      channel: 'agent',
      content,
      sender: { id: 'user', name: 'user' },
      metadata: {
        threadKey: KEY,
        triggerThreadMessageId: wake.threadMessageId,
        wakeCoalescible: true,
      },
      turnHooks: closingTextTurnHooks(dataComposer, wake),
    });
    const first = service.handleMessage(request(firstWake, 'First synthetic wake.'));
    await vi.waitFor(() => expect(processMessage).toHaveBeenCalledTimes(1));
    const secondWake = await ownerWrites('Second invented message.');
    const thirdWake = await ownerWrites('Third invented message.');
    const second = service.handleMessage(request(secondWake, 'Second synthetic wake.'));
    const third = service.handleMessage(request(thirdWake, 'Third synthetic wake.'));
    const queue = service as unknown as { pendingQueues: Map<string, unknown[]> };
    await vi.waitFor(() => expect([...queue.pendingQueues.values()][0]).toHaveLength(2));
    expect(messages().filter((m) => m.sender_kind === 'user')).toHaveLength(3);
    expect(processMessage).toHaveBeenCalledTimes(1);
    release();
    const results = await Promise.all([first, second, third]);
    expect(processMessage).toHaveBeenCalledTimes(2);
    expect(processMessage.mock.calls[1][0].metadata?.coalescedSources).toEqual([
      secondWake.threadMessageId,
      thirdWake.threadMessageId,
    ]);
    expect(results[2].wake).toEqual({ coalescedInto: secondWake.threadMessageId });
    expect(
      messages()
        .filter((m) => m.sender_kind === 'sb')
        .map((m) => m.content)
    ).toEqual(['First reply.', 'Reply to both follow-ups.']);
    expect(queue.pendingQueues.size).toBe(0);
  });
});
