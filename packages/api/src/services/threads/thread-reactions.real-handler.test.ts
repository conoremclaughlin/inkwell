/**
 * Reactions through the real admin routes (POST /threads/reactions, GET
 * /threads/messages) and the real MCP handlers (react_to_message,
 * get_thread_messages), with only the database (FakePostgrest with the
 * reactions table mirrored), the gateway and the request context faked.
 * ink://specs/inkling-reactions, "Wire".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { FakePostgrest, type Row } from '../../test/fake-postgrest';
import { withReactionsTable } from '../../test/fake-reactions-db';

const ME = '11111111-1111-4111-8111-111111111111';
const SOMEONE = '22222222-2222-4222-8222-222222222222';
const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let db: FakePostgrest;
const context = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const gateway = vi.hoisted(() => ({
  dispatchTrigger: vi.fn(() => ({ success: true, accepted: true })),
  processTrigger: vi.fn(async () => ({ success: true })),
}));

vi.mock('../user-resolver', async (original) => ({
  ...(await original<typeof import('../user-resolver')>()),
  resolveUserOrThrow: vi.fn(async () => ({ user: { id: ME }, resolvedBy: 'userId' })),
}));
vi.mock('../../utils/request-context', async (original) => ({
  ...(await original<typeof import('../../utils/request-context')>()),
  getRequestContext: vi.fn(() => context.current),
  getSessionContext: vi.fn(() => undefined),
  getPinnedSlug: vi.fn(() => undefined),
}));
vi.mock('../../channels/agent-gateway', () => ({ getAgentGateway: vi.fn(() => gateway) }));
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
import * as threadHandlers from '../../mcp/tools/thread-handlers';
import { REACTIONS_TABLE } from './thread-reactions';

type Handler = (req: Request, res: Response) => Promise<void>;
/* eslint-disable @typescript-eslint/no-explicit-any */
const route = (method: 'get' | 'post', routePath: string): Handler | undefined =>
  (router as any).stack
    .find((x: any) => x.route?.path === routePath && x.route.methods[method])
    ?.route.stack.at(-1).handle;
/* eslint-enable @typescript-eslint/no-explicit-any */

async function call(
  handler: Handler | undefined,
  input: { body?: Row; query?: Row },
  as: { userId?: string; role?: string } = {}
): Promise<{ status: number; body: Row }> {
  if (!handler) throw new Error('route not registered');
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
      body: input.body ?? {},
      query: input.query ?? {},
      headers: {},
      cookies: {},
      params: {},
      inkUserId: as.userId ?? ME,
      inkWorkspaceId: WS,
      inkWorkspaceRole: as.role ?? 'owner',
    } as unknown as Request,
    res as unknown as Response
  );
  return answer;
}

const postReaction = (body: Row, as?: { userId?: string; role?: string }) =>
  call(route('post', '/threads/reactions'), { body }, as);
const getMessages = (key: string, as?: { userId?: string }) =>
  call(route('get', '/threads/messages'), { query: { key } }, as);

/** A tool handler by name, failing the test (not the import) when it is missing. */
function tool(
  name: string
): (args: unknown, dc: unknown) => Promise<{ content: Array<{ text: string }> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const definition = (threadHandlers.threadToolDefinitions as any[]).find((d) => d.name === name);
  if (!definition) throw new Error(`no thread tool ${name}`);
  return definition.handler;
}
const dataComposer = () => ({ repositories: {}, getClient: () => db });
async function asSb(sbId: string, name: string, args: Row): Promise<Row> {
  context.current = { userId: ME, sbId };
  const result = await tool(name)(args, dataComposer());
  return JSON.parse(result.content[0].text) as Row;
}

/** Every read of the reactions table fails, as it would before the migration. */
function failReactionReads(): void {
  const originalFrom = db.from.bind(db);
  db.from = (table: string) => {
    if (table !== REACTIONS_TABLE) return originalFrom(table);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failing: any = {
      then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
        Promise.resolve({ data: null, error: { message: 'relation does not exist' } }).then(ok, ko),
    };
    for (const method of ['select', 'in', 'eq', 'order', 'range']) failing[method] = () => failing;
    return failing;
  };
}

let seq = 0;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function sb(slug: string, metadata: Row = {}): Row {
  return db.seed('agent_identities', {
    id: uuid(++seq),
    agent_id: slug,
    user_id: ME,
    workspace_id: WS,
    name: slug,
    metadata,
  });
}

function thread(key: string, members: Array<Row | string>): Row {
  const t = db.seed('inbox_threads', {
    id: uuid(++seq),
    thread_key: key,
    workspace_id: WS,
    created_by_kind: 'user',
    created_by_sb_id: null,
    created_by_user_id: ME,
    title: null,
    summary: null,
    title_updated_at: null,
    summary_updated_at: null,
    status: 'open',
    metadata: {},
    updated_at: '2026-10-04T00:00:00.000Z',
    closed_at: null,
  });
  for (const m of members) {
    db.seed('inbox_thread_participants', {
      thread_id: t.id,
      sb_id: typeof m === 'string' ? null : m.id,
      user_id: typeof m === 'string' ? m : null,
      session_id: null,
      joined_at: '2026-10-01T00:00:00.000Z',
    });
  }
  return t;
}

function message(t: Row, content: string): Row {
  return db.seed('inbox_thread_messages', {
    id: uuid(++seq),
    thread_id: t.id,
    sender_kind: 'user',
    sender_sb_id: null,
    sender_user_id: ME,
    sender_agent_id: null,
    content,
    message_type: 'message',
    priority: 'normal',
    metadata: {},
  });
}

let wren: Row;
let pip: Row;
let team: Row;
let first: Row;
let second: Row;
let background: Row;
let backgroundMessage: Row;
let inklingThread: Row;
let inklingMessage: Row;

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  db = withReactionsTable(new FakePostgrest());
  db.rpcHandlers.advance_thread_read_pointer = () => ({ data: true, error: null });
  db.seed('workspace_members', { workspace_id: WS, user_id: ME, role: 'owner' });
  db.seed('users', { id: ME, first_name: 'Ada', last_name: null, username: null, email: null });
  // Studio history reads lease events through a PostgREST `or`; there are
  // none here, so the filter has nothing to decide.
  const originalFrom = db.from.bind(db);
  db.from = (table: string) => {
    const query = originalFrom(table);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (table === 'studio_lease_events') (query as any).or = () => query;
    return query;
  };
  wren = sb('wren');
  pip = sb('pip', { client: 'inkling-mobile', named: false, ownerTest: true });
  team = thread('thread:team', [wren, ME]);
  first = message(team, 'first');
  second = message(team, 'second');
  background = thread('thread:background', [wren]);
  backgroundMessage = message(background, 'not yours');
  inklingThread = thread('chat:pip', [pip, ME]);
  inklingMessage = message(inklingThread, 'hi pip');
  vi.stubEnv('INKLING_OWNER_TEST_USER_ID', ME);
  context.current = { userId: ME };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/admin/threads/reactions', () => {
  it('adds a member’s reaction: 200 { messageId, reactions }, mine for them', async () => {
    const answer = await postReaction({
      threadKey: team.thread_key,
      messageId: first.id,
      emoji: '👍',
    });
    expect(answer).toEqual({
      status: 200,
      body: {
        messageId: first.id,
        reactions: [{ emoji: '👍', count: 1, reactors: [{ kind: 'user', id: ME }], mine: true }],
      },
    });
  });

  it('removes it with remove: true, and removing what is not there is 200 and changes nothing', async () => {
    await postReaction({ threadKey: team.thread_key, messageId: first.id, emoji: '👍' });
    const body = { threadKey: team.thread_key, messageId: first.id, emoji: '👍', remove: true };
    expect(await postReaction(body)).toEqual({
      status: 200,
      body: { messageId: first.id, reactions: [] },
    });
    expect(await postReaction(body)).toEqual({
      status: 200,
      body: { messageId: first.id, reactions: [] },
    });
    expect(db.rows(REACTIONS_TABLE)).toHaveLength(0);
  });

  it.each([
    ['a malformed emoji', { emoji: 'thumbs up' }, 'invalid_emoji'],
    ['a malformed message id', { messageId: 'm1' }, 'invalid_message_id'],
    ['a remove that is not a boolean', { remove: 'yes' }, 'invalid_remove'],
  ])('answers 400 for %s', async (_label, overrides, code) => {
    const answer = await postReaction({
      threadKey: team.thread_key,
      messageId: first.id,
      emoji: '👍',
      ...overrides,
    });
    expect(answer.status).toBe(400);
    expect(answer.body.code).toBe(code);
    expect(db.rows(REACTIONS_TABLE)).toHaveLength(0);
  });

  it('answers 403 in a background thread, where the person is not a member', async () => {
    const answer = await postReaction({
      threadKey: background.thread_key,
      messageId: backgroundMessage.id,
      emoji: '👍',
    });
    expect(answer.status).toBe(403);
    expect(answer.body.code).toBe('background_thread');
  });

  it('answers 403 to a role that cannot write to threads', async () => {
    const answer = await postReaction(
      { threadKey: team.thread_key, messageId: first.id, emoji: '👍' },
      { role: 'viewer' }
    );
    expect(answer.status).toBe(403);
    expect(db.rows(REACTIONS_TABLE)).toHaveLength(0);
  });

  it('answers 404 for a message that is not in that thread', async () => {
    const answer = await postReaction({
      threadKey: team.thread_key,
      messageId: backgroundMessage.id,
      emoji: '👍',
    });
    expect(answer.status).toBe(404);
    expect(answer.body.code).toBe('message_not_found');
  });

  it('answers 409 for a seventh emoji from one person on one message', async () => {
    for (const emoji of ['❤️', '👍', '😂', '😮', '😢', '🙏']) {
      expect(
        (await postReaction({ threadKey: team.thread_key, messageId: first.id, emoji })).status
      ).toBe(200);
    }
    const answer = await postReaction({
      threadKey: team.thread_key,
      messageId: first.id,
      emoji: '🎉',
    });
    expect(answer.status).toBe(409);
    expect(answer.body.code).toBe('reaction_limit');
  });

  it('lets the owner react in their inkling’s conversation, and refuses anyone else there', async () => {
    const mine = await postReaction({
      threadKey: inklingThread.thread_key,
      messageId: inklingMessage.id,
      emoji: '❤️',
    });
    expect(mine.status).toBe(200);
    db.seed('inbox_thread_participants', { thread_id: inklingThread.id, user_id: SOMEONE });
    const theirs = await postReaction(
      { threadKey: inklingThread.thread_key, messageId: inklingMessage.id, emoji: '❤️' },
      { userId: SOMEONE }
    );
    expect(theirs.status).toBe(403);
    expect(theirs.body.code).toBe('inkling_thread_refused');
  });

  it('wakes nobody, writes no message, and moves no read pointer or thread recency', async () => {
    const threadBefore = { ...team };
    const messagesBefore = db.rows('inbox_thread_messages').length;
    await postReaction({ threadKey: team.thread_key, messageId: first.id, emoji: '👍' });
    await postReaction({
      threadKey: team.thread_key,
      messageId: first.id,
      emoji: '👍',
      remove: true,
    });
    expect(gateway.dispatchTrigger).not.toHaveBeenCalled();
    expect(gateway.processTrigger).not.toHaveBeenCalled();
    expect(db.rows('inbox_thread_messages')).toHaveLength(messagesBefore);
    expect(db.rows('inbox_threads').find((t) => t.id === team.id)).toEqual(threadBefore);
    expect(db.log.filter((e) => e.op !== 'select').map((e) => e.table)).toEqual([
      REACTIONS_TABLE,
      REACTIONS_TABLE,
    ]);
  });
});

describe('GET /api/admin/threads/messages carries reactions', () => {
  it('on every message, [] where there are none, mine for the viewer', async () => {
    await postReaction({ threadKey: team.thread_key, messageId: second.id, emoji: '😂' });
    db.seed(REACTIONS_TABLE, {
      message_id: second.id,
      thread_id: team.id,
      workspace_id: WS,
      reactor_user_id: null,
      reactor_sb_id: wren.id,
      emoji: '😂',
    });
    const answer = await getMessages(team.thread_key as string);
    expect(answer.status).toBe(200);
    const messages = answer.body.messages as Row[];
    expect(messages.map((m) => [m.id, m.reactions])).toEqual([
      [first.id, []],
      [
        second.id,
        [
          {
            emoji: '😂',
            count: 2,
            reactors: [
              { kind: 'user', id: ME },
              { kind: 'sb', id: wren.id },
            ],
            mine: true,
          },
        ],
      ],
    ]);
  });

  it('shows a background thread’s reactions to a person who is not in it, never as theirs', async () => {
    db.seed(REACTIONS_TABLE, {
      message_id: backgroundMessage.id,
      thread_id: background.id,
      workspace_id: WS,
      reactor_user_id: null,
      reactor_sb_id: wren.id,
      emoji: '👍',
    });
    const answer = await getMessages(background.thread_key as string);
    expect((answer.body.messages as Row[])[0].reactions).toEqual([
      { emoji: '👍', count: 1, reactors: [{ kind: 'sb', id: wren.id }], mine: false },
    ]);
  });

  it('says reactions are unavailable, rather than answering [] for each, when they cannot be read', async () => {
    failReactionReads();
    const answer = await getMessages(team.thread_key as string);
    expect(answer.status).toBe(200);
    const messages = answer.body.messages as Row[];
    expect(messages).toHaveLength(2);
    for (const m of messages) expect(m).not.toHaveProperty('reactions');
    expect((answer.body.meta as Row).reactionsUnavailable).toBe(true);
  });
});

describe('react_to_message (MCP)', () => {
  it('is registered, and its description says a reaction is never approval', () => {
    const definition = threadHandlers.threadTool('react_to_message');
    expect(definition.description).toMatch(/never approval/i);
    expect(definition.description).toContain('a 👍 is not a yes');
  });

  it('adds the calling SB’s reaction, waking nobody and writing no message', async () => {
    const messagesBefore = db.rows('inbox_thread_messages').length;
    const answer = await asSb(wren.id as string, 'react_to_message', {
      userId: ME,
      sbSlug: 'wren',
      threadKey: team.thread_key,
      messageId: first.id,
      emoji: '🙏',
    });
    expect(answer).toMatchObject({
      success: true,
      messageId: first.id,
      reactions: [{ emoji: '🙏', count: 1, reactors: [{ kind: 'sb', id: wren.id }], mine: true }],
    });
    expect(gateway.dispatchTrigger).not.toHaveBeenCalled();
    expect(gateway.processTrigger).not.toHaveBeenCalled();
    expect(db.rows('inbox_thread_messages')).toHaveLength(messagesBefore);
    expect(db.log.filter((e) => e.op !== 'select').map((e) => e.table)).toEqual([REACTIONS_TABLE]);
  });

  it('refuses an SB that is not a member, with the status and code the route would use', async () => {
    const fern = sb('fern');
    const answer = await asSb(fern.id as string, 'react_to_message', {
      userId: ME,
      sbSlug: 'fern',
      threadKey: team.thread_key,
      messageId: first.id,
      emoji: '👍',
    });
    expect(answer).toMatchObject({ success: false, status: 403, code: 'not_a_member' });
    expect(db.rows(REACTIONS_TABLE)).toHaveLength(0);
  });

  it('refuses the inkling in its own conversation, for now', async () => {
    const answer = await asSb(pip.id as string, 'react_to_message', {
      userId: ME,
      sbSlug: 'pip',
      threadKey: inklingThread.thread_key,
      messageId: inklingMessage.id,
      emoji: '❤️',
    });
    expect(answer).toMatchObject({ success: false, status: 403, code: 'inkling_reaction_refused' });
    expect(db.rows(REACTIONS_TABLE)).toHaveLength(0);
  });

  it('refuses an SB whose owner can only read the workspace', async () => {
    db.rows('workspace_members')[0].role = 'viewer';
    await expect(
      asSb(wren.id as string, 'react_to_message', {
        userId: ME,
        sbSlug: 'wren',
        threadKey: team.thread_key,
        messageId: first.id,
        emoji: '👍',
      })
    ).rejects.toThrow(/cannot react/);
    expect(db.rows(REACTIONS_TABLE)).toHaveLength(0);
  });
});

describe('get_thread_messages (MCP) carries reactions', () => {
  const read = () =>
    asSb(wren.id as string, 'get_thread_messages', {
      userId: ME,
      sbSlug: 'wren',
      threadKey: team.thread_key,
      fullHistory: true,
      markRead: false,
    });

  it('on every message, mine for the calling SB, with the not-approval line beside them', async () => {
    await postReaction({ threadKey: team.thread_key, messageId: first.id, emoji: '👍' });
    const answer = await read();
    expect(answer.success).toBe(true);
    expect((answer.messages as Row[]).map((m) => [m.id, m.reactions])).toEqual([
      [first.id, [{ emoji: '👍', count: 1, reactors: [{ kind: 'user', id: ME }], mine: false }]],
      [second.id, []],
    ]);
    expect(answer.reactionsNote).toBe(
      'A reaction is never approval of anything: a 👍 is not a yes.'
    );

    await asSb(wren.id as string, 'react_to_message', {
      userId: ME,
      sbSlug: 'wren',
      threadKey: team.thread_key,
      messageId: first.id,
      emoji: '👍',
    });
    expect(((await read()).messages as Row[])[0].reactions).toEqual([
      {
        emoji: '👍',
        count: 2,
        reactors: [
          { kind: 'user', id: ME },
          { kind: 'sb', id: wren.id },
        ],
        mine: true,
      },
    ]);
  });

  it('leaves the line out when nothing has a reaction', async () => {
    const answer = await read();
    expect((answer.messages as Row[]).every((m) => Array.isArray(m.reactions))).toBe(true);
    expect(answer).not.toHaveProperty('reactionsNote');
  });

  it('says reactions are unavailable, rather than [] for each, when they cannot be read', async () => {
    failReactionReads();
    const answer = await read();
    expect(answer.success).toBe(true);
    for (const m of answer.messages as Row[]) expect(m).not.toHaveProperty('reactions');
    expect(answer.reactionsUnavailable).toBe(true);
  });
});
