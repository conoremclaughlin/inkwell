/**
 * Who may be in a conversation with inklings, case by case: one person with
 * their inkling, one person with their own inklings together, and two people
 * with one inkling or with two (one each, or both of one owner's).
 *
 * Kind of evidence: synthetic. The real admin routes, the real
 * handleSendToInbox and add_thread_participant, and the real gate run; the
 * database is the in-memory FakePostgrest and the gateway is a mock, so no
 * turn runs and nothing reaches a model. A refusal here says the server
 * refuses today. It is not evidence that a two-person conversation works.
 *
 * Covered elsewhere, and not repeated here:
 * - 1:1 and owner-present groups of up to three, member replies, fixed
 *   membership, races: inkling-thread-gate.real-handler.test.ts.
 * - Turn order, rotation, Stop and wake-by-name:
 *   inkling-reply-chain.real-handler.test.ts.
 * - A rename sets the display name and never the slug or id:
 *   inkling-service.test.ts, describe('name').
 *
 * The two-person cases come in two kinds, named in each test:
 * - "outsider": a person writing into a conversation they were never part
 *   of. These stay refused when two-person groups ship.
 * - "today": a conversation two people are both in. Refused today; two-person
 *   groups would add consented-member success cases beside these, on their
 *   own path, rather than loosen the outsider refusals.
 *
 * No route adds a person to a conversation: a create names SBs, and
 * add_thread_participant takes an SB. A second person can only arrive by
 * writing into it (an outsider case) or by being stored there already, which
 * the "today" cases seed directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createInklingDb } from '../../test/fake-inkling-db';
import type { FakePostgrest, Row } from '../../test/fake-postgrest';

const ME = '11111111-1111-4111-8111-111111111111';
const SOMEONE = '22222222-2222-4222-8222-222222222222';
const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let db: FakePostgrest;
vi.mock('../user-resolver', async (original) => ({
  ...(await original<typeof import('../user-resolver')>()),
  resolveUserOrThrow: vi.fn(async () => ({
    user: { id: ME },
    resolvedBy: 'userId',
  })),
}));
vi.mock('../../utils/request-context', async (original) => ({
  ...(await original<typeof import('../../utils/request-context')>()),
  getRequestContext: vi.fn(() => ({ userId: ME })),
  getSessionContext: vi.fn(() => undefined),
  getPinnedSlug: vi.fn(() => undefined),
}));
const gateway = vi.hoisted(() => ({
  dispatchTrigger: vi.fn((_payload: unknown) => ({ success: true, accepted: true })),
  processTrigger: vi.fn(async () => ({ success: true })),
}));
vi.mock('../../channels/agent-gateway', () => ({
  getAgentGateway: vi.fn(() => gateway),
}));
vi.mock('../../auth/ink-tokens', () => ({
  signInkAccessToken: vi.fn(),
  createRefreshToken: vi.fn(),
  exchangeRefreshToken: vi.fn(),
  verifyInkAccessToken: vi.fn(),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => db) }));
vi.mock('../../data/composer', () => ({
  getDataComposer: vi.fn(async () => ({
    repositories: {},
    getClient: () => db,
  })),
}));
vi.mock('../authorization', () => ({
  getAuthorizationService: vi.fn(() => ({})),
}));
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
import { handleAddThreadParticipant } from '../../mcp/tools/thread-handlers';
import { getRequestContext } from '../../utils/request-context';
import { InklingThreadRefusedError } from './inkling-thread-gate';
import { resetReplyChains, wakeNextInReplyChain } from './inkling-reply-chain';

type Handler = (req: Request, res: Response) => Promise<void>;
/* eslint-disable @typescript-eslint/no-explicit-any */
const route = (path: string): Handler =>
  (router as any).stack
    .find((x: any) => x.route?.path === path && x.route.methods.post)
    .route.stack.at(-1).handle;
/* eslint-enable @typescript-eslint/no-explicit-any */
const create = route('/threads');
const reply = route('/threads/reply');

/** A person's request to an admin route, with their own workspace role. */
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
      inkWorkspaceRole: as === ME ? 'owner' : 'member',
    } as unknown as Request,
    res as unknown as Response
  );
  return answer;
}

/** An SB in the shared workspace; an inkling when `metadata` says so. */
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
const OWNER_TEST_INKLING = {
  client: 'inkling-mobile',
  named: false,
  ownerTest: true,
};

/** An SB principal as the server resolves one. */
function asSb(slug: string, userId = ME): Row {
  return {
    kind: 'sb',
    sbId: `sb-${slug}`,
    sbSlug: slug,
    userId,
    workspaceId: WS,
  };
}

/** A send by an inkling (as its turn's server-internal sender) on `key`. */
function inklingSays(slug: string, key: string, content: string, owner = ME): Promise<unknown> {
  return handleSendToInbox(
    { userId: ME, threadKey: key, recipientSlug: slug, content },
    { repositories: {}, getClient: () => db } as never,
    { sender: { principal: asSb(slug, owner) as never, workspaceId: WS } }
  ).then(
    () => null,
    (e: unknown) => e
  );
}

/** add_thread_participant, as the person (ME) bound to no SB. */
function personAdds(key: string, newcomer: string): Promise<unknown> {
  return handleAddThreadParticipant(
    {
      userId: ME,
      threadKey: key,
      sbSlug: newcomer,
      triggerNewParticipant: true,
    },
    { repositories: {}, getClient: () => db } as never
  ).then(
    (r) => JSON.parse(r.content[0].text) as Row,
    (e: unknown) => e
  );
}

/** A conversation as stored, with exactly these members. */
function seedThread(
  key: string,
  members: Array<{ sb_id: string | null; user_id: string | null }>
): void {
  const thread = db.seed('inbox_threads', {
    thread_key: key,
    workspace_id: WS,
  });
  for (const member of members) {
    db.seed('inbox_thread_participants', {
      thread_id: thread.id,
      workspace_id: WS,
      ...member,
    });
  }
}
const person = (userId: string) => ({ sb_id: null, user_id: userId });
const inkling = (slug: string) => ({ sb_id: `sb-${slug}`, user_id: null });

/** Every row a send could write, as stored: threads, members and messages. */
const stored = () =>
  structuredClone({
    threads: db.rows('inbox_threads'),
    participants: db.rows('inbox_thread_participants'),
    messages: db.rows('inbox_thread_messages'),
  });
const NOTHING = { threads: [], participants: [], messages: [] };

type Wake = {
  toSlug: string;
  threadKey: string;
  threadId: string;
  threadMessageId: string;
};
const wakes = (): Wake[] =>
  (gateway.dispatchTrigger.mock.calls as unknown as Array<[Wake]>).map(([payload]) => payload);

const threadOf = (key: string) => db.rows('inbox_threads').find((t) => t.thread_key === key);
const messagesIn = (key: string) =>
  db.rows('inbox_thread_messages').filter((m) => m.thread_id === threadOf(key)?.id);

/** A setup step that must have been accepted before anything is measured. */
async function accepted(answer: Promise<{ status: number; body: Row }>): Promise<void> {
  expect((await answer).status).toBe(200);
}

/**
 * Refused by the conversation rule itself, not disabled and not some other
 * failure: a route's 403 answer, or the error a server-side send throws.
 */
function expectRefused(outcome: unknown, label?: string): void {
  if (outcome && typeof outcome === 'object' && 'status' in outcome) {
    expect(outcome, label).toMatchObject({
      status: 403,
      body: { code: 'inkling_thread_refused' },
    });
    return;
  }
  expect(outcome, label).toBeInstanceOf(InklingThreadRefusedError);
  expect((outcome as InklingThreadRefusedError).code, label).toBe('inkling_thread_refused');
}

/**
 * Each attempt, in turn, is refused, leaves every stored thread, member and
 * message exactly as it found them (rows compared whole, so a changed row
 * fails as well as an added one), and wakes nobody.
 */
async function refusedWithoutTrace(attempts: Record<string, () => Promise<unknown>>) {
  for (const [label, attempt] of Object.entries(attempts)) {
    const before = stored();
    const wakesBefore = wakes().length;
    expectRefused(await attempt(), label);
    expect(stored(), label).toEqual(before);
    expect(wakes().length, label).toBe(wakesBefore);
  }
}
/** A person's reply on `key`, through the route. */
const personReplies = (key: string, who: string) => () =>
  call(reply, { key, content: `from ${who}` }, who);
/** A person's new conversation, through the route. */
const personStarts = (key: string, recipients: string[], who: string) => () =>
  call(create, { key, recipients, content: 'hi' }, who);

beforeEach(() => {
  gateway.dispatchTrigger.mockReset().mockReturnValue({ success: true, accepted: true });
  gateway.processTrigger.mockReset().mockResolvedValue({ success: true });
  resetReplyChains();
  db = createInklingDb();
  db.rpcHandlers.advance_thread_read_pointer = () => ({
    data: true,
    error: null,
  });
  // Both people are in one shared space, both in the owner test: so every
  // refusal below is the conversation rule, not a missing role or account.
  db.seed('workspace_members', {
    workspace_id: WS,
    user_id: ME,
    role: 'owner',
  });
  db.seed('workspace_members', {
    workspace_id: WS,
    user_id: SOMEONE,
    role: 'member',
  });
  vi.stubEnv('INKLING_OWNER_TEST_USER_ID', '');
  vi.stubEnv('INKLING_OWNER_TEST_USER_IDS', `${ME},${SOMEONE}`);
  sb('pip', OWNER_TEST_INKLING);
  sb('tam', OWNER_TEST_INKLING);
  sb('moss', OWNER_TEST_INKLING, SOMEONE);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(getRequestContext).mockImplementation(() => ({ userId: ME }) as never);
});

describe('one person: a 1:1 and a group of their own inklings stay separate conversations', () => {
  const ONE = 'chat:pip';
  const GROUP = 'chat:pip-and-tam';

  it('what is said in the 1:1 is never stored in, or woken for, the group', async () => {
    await accepted(call(create, { key: ONE, recipients: ['pip'], content: 'PRIVATE-1:1' }));
    expect(await inklingSays('pip', ONE, 'PRIVATE-REPLY')).toBeNull();
    gateway.dispatchTrigger.mockClear();

    await accepted(call(create, { key: GROUP, recipients: ['pip', 'tam'], content: 'hi both' }));
    // Starting the group copies nothing into it: it holds its first message only.
    expect(messagesIn(GROUP).map((m) => m.content)).toEqual(['hi both']);
    expect(await inklingSays('pip', GROUP, 'group reply')).toBeNull();

    const groupContent = messagesIn(GROUP).map((m) => String(m.content));
    expect(groupContent).toEqual(['hi both', 'group reply']);
    expect(groupContent.join('\n')).not.toMatch(/PRIVATE/);
    expect(messagesIn(ONE).map((m) => m.content)).toEqual(['PRIVATE-1:1', 'PRIVATE-REPLY']);

    // Every wake the group caused names the group and one of its own messages.
    const groupIds = new Set(messagesIn(GROUP).map((m) => m.id));
    expect(wakes().length).toBeGreaterThan(0);
    for (const wake of wakes()) {
      expect(wake.threadKey).toBe(GROUP);
      expect(wake.threadId).toBe(threadOf(GROUP)?.id);
      expect(groupIds.has(wake.threadMessageId)).toBe(true);
    }
  });

  it('the next owner message in the 1:1 wakes only the 1:1 inkling, never a group member', async () => {
    await accepted(call(create, { key: ONE, recipients: ['pip'], content: 'hi' }));
    await accepted(call(create, { key: GROUP, recipients: ['pip', 'tam'], content: 'hi both' }));
    gateway.dispatchTrigger.mockClear();
    await accepted(call(reply, { key: ONE, content: 'just us' }));
    expect(wakes().map((w) => [w.toSlug, w.threadKey])).toEqual([['pip', ONE]]);
  });

  it('every stored message names its sender by durable id, not by display name', async () => {
    await accepted(call(create, { key: GROUP, recipients: ['pip', 'tam'], content: 'hi both' }));
    expect(await inklingSays('pip', GROUP, 'pip here')).toBeNull();
    expect(await inklingSays('tam', GROUP, 'tam here')).toBeNull();
    const senders = messagesIn(GROUP).map((m) => ({
      kind: m.sender_kind,
      user: m.sender_user_id,
      sb: m.sender_sb_id,
    }));
    expect(senders).toEqual([
      { kind: 'user', user: ME, sb: null },
      { kind: 'sb', user: null, sb: 'sb-pip' },
      { kind: 'sb', user: null, sb: 'sb-tam' },
    ]);
  });

  it('an inkling turn that ends in the group moves only the group', async () => {
    await accepted(call(create, { key: ONE, recipients: ['pip'], content: 'hi' }));
    await accepted(call(create, { key: GROUP, recipients: ['pip', 'tam'], content: 'hi both' }));
    const groupWakes = wakes().filter((w) => w.threadKey === GROUP);
    expect(groupWakes).toHaveLength(1);
    gateway.dispatchTrigger.mockClear();
    wakeNextInReplyChain(groupWakes[0] as never, (next) => gateway.dispatchTrigger(next as never));
    expect(wakes().map((w) => [w.toSlug, w.threadKey])).toEqual([['tam', GROUP]]);
  });
});

describe('two people and one inkling: refused today', () => {
  const MINE = 'chat:pip';
  const THEIRS = 'chat:moss';

  it("outsider: another person may not start a conversation with someone else's inkling", async () => {
    await refusedWithoutTrace({ 'B starts with pip': personStarts(MINE, ['pip'], SOMEONE) });
    expect(stored()).toEqual(NOTHING);
  });

  it("outsider: another person may not write into someone's 1:1 with their inkling, either way round", async () => {
    await accepted(call(create, { key: MINE, recipients: ['pip'], content: 'hi pip' }));
    await accepted(
      call(create, { key: THEIRS, recipients: ['moss'], content: 'hi moss' }, SOMEONE)
    );
    await refusedWithoutTrace({
      "B into A's 1:1": personReplies(MINE, SOMEONE),
      "A into B's 1:1": personReplies(THEIRS, ME),
    });
  });

  it('today: in a conversation holding both people and the inkling, nobody may write', async () => {
    const BOTH = 'chat:pip-with-two-people';
    seedThread(BOTH, [person(ME), person(SOMEONE), inkling('pip')]);
    await refusedWithoutTrace({
      A: personReplies(BOTH, ME),
      B: personReplies(BOTH, SOMEONE),
      pip: () => inklingSays('pip', BOTH, 'hello both'),
    });
  });

  it("today: the same, when the inkling is the other person's", async () => {
    const BOTH = 'chat:moss-with-two-people';
    seedThread(BOTH, [person(ME), person(SOMEONE), inkling('moss')]);
    await refusedWithoutTrace({
      B: personReplies(BOTH, SOMEONE),
      A: personReplies(BOTH, ME),
      moss: () => inklingSays('moss', BOTH, 'hello both', SOMEONE),
    });
  });
});

describe('two people and two inklings, one each: refused today', () => {
  it('outsider: neither person may start a conversation with both inklings', async () => {
    await refusedWithoutTrace({
      A: personStarts('chat:both-from-a', ['pip', 'moss'], ME),
      B: personStarts('chat:both-from-b', ['pip', 'moss'], SOMEONE),
    });
    expect(stored()).toEqual(NOTHING);
  });

  it("outsider: an owner may not add the other person's inkling to their own 1:1", async () => {
    // The workspace a caller bound to no SB writes in; without it the add
    // fails for want of one, which is not the refusal this case is about.
    db.seed('workspaces', {
      id: WS,
      user_id: ME,
      type: 'personal',
      slug: 'personal',
      archived_at: null,
    });
    await accepted(call(create, { key: 'chat:pip', recipients: ['pip'], content: 'hi' }));
    await refusedWithoutTrace({ 'A adds moss': () => personAdds('chat:pip', 'moss') });
  });

  it("outsider: an inkling may not write into the other person's 1:1", async () => {
    await accepted(
      call(create, { key: 'chat:moss', recipients: ['moss'], content: 'hi' }, SOMEONE)
    );
    await refusedWithoutTrace({
      'pip into moss': () => inklingSays('pip', 'chat:moss', 'hello moss'),
    });
  });

  it('today: in a conversation holding both people and an inkling of each, nobody may write', async () => {
    const ALL = 'chat:two-and-two';
    seedThread(ALL, [person(ME), person(SOMEONE), inkling('pip'), inkling('moss')]);
    await refusedWithoutTrace({
      A: personReplies(ALL, ME),
      B: personReplies(ALL, SOMEONE),
      pip: () => inklingSays('pip', ALL, 'pip here'),
      moss: () => inklingSays('moss', ALL, 'moss here', SOMEONE),
    });
  });
});

describe("two people and two of one owner's inklings: refused today", () => {
  const GROUP = 'chat:pip-and-tam';

  it("outsider: another person may not start a group with someone else's inklings", async () => {
    await refusedWithoutTrace({ 'B starts': personStarts(GROUP, ['pip', 'tam'], SOMEONE) });
    expect(stored()).toEqual(NOTHING);
  });

  it("outsider: another person may not write into the owner's group, and its turns go on as before", async () => {
    await accepted(call(create, { key: GROUP, recipients: ['pip', 'tam'], content: 'hi both' }));
    const [first] = wakes();
    expect(first?.toSlug).toBe('pip');
    await refusedWithoutTrace({ 'B into the group': personReplies(GROUP, SOMEONE) });

    // The refusal left the owner's chain alone: pip's turn ending still
    // wakes tam, once, for the owner's same message.
    gateway.dispatchTrigger.mockClear();
    wakeNextInReplyChain(first as never, (next) => gateway.dispatchTrigger(next as never));
    expect(wakes().map((w) => [w.toSlug, w.threadKey, w.threadMessageId])).toEqual([
      ['tam', GROUP, first?.threadMessageId],
    ]);
  });

  it('today: in a conversation holding both people and both inklings, nobody may write', async () => {
    const ALL = 'chat:two-people-pip-and-tam';
    seedThread(ALL, [person(ME), person(SOMEONE), inkling('pip'), inkling('tam')]);
    await refusedWithoutTrace({
      A: personReplies(ALL, ME),
      B: personReplies(ALL, SOMEONE),
      pip: () => inklingSays('pip', ALL, 'pip here'),
      tam: () => inklingSays('tam', ALL, 'tam here'),
    });
  });
});
