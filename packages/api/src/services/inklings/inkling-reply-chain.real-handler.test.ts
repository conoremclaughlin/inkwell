/**
 * Inklings in a group answer their owner in turn, and a name wakes only its
 * inkling (ink://specs/inkling-group-dynamics), through the real admin
 * routes and the real handleSendToInbox, with only the database (the
 * in-memory FakePostgrest), the gateway and the read-pointer RPC faked.
 * A member's turn "ending" is what server.ts reports when handleMessage
 * settles: wakeNextInReplyChain with that wake's own payload.
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
const gateway = vi.hoisted(() => ({
  dispatchTrigger: vi.fn(() => ({ success: true, accepted: true })),
  processTrigger: vi.fn(async () => ({ success: true })),
}));
vi.mock('../../channels/agent-gateway', () => ({
  getAgentGateway: vi.fn(() => gateway),
}));
/**
 * The SBs a send woke: one dispatchTrigger per wake. processTrigger runs
 * for every addressed recipient as routing-only assignment, which starts
 * no turn, so it is not counted.
 */
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
import { userPrincipal } from '../principals';
import {
  dropReplyChainsFor,
  resetReplyChains,
  takeReplyTicket,
  wakeNextInReplyChain,
} from './inkling-reply-chain';

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
  // Reset, not cleared: a test may hold routing or refuse a wake.
  gateway.dispatchTrigger.mockReset().mockReturnValue({ success: true, accepted: true });
  gateway.processTrigger.mockReset().mockResolvedValue({ success: true });
  resetReplyChains();
  db = createInklingDb();
  db.rpcHandlers.advance_thread_read_pointer = () => ({ data: true, error: null });
  sb('pip', OWNER_TEST_INKLING);
  sb('fern');
  vi.stubEnv('INKLING_OWNER_TEST_USER_ID', ME);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The SB principal of an inkling in my workspace. */
function asSb(slug: string): Row {
  return { kind: 'sb', sbId: `sb-${slug}`, sbSlug: slug, userId: ME, workspaceId: WS };
}

/** The wake payloads sent so far, in order. */
const wakes = () =>
  gateway.dispatchTrigger.mock.calls as unknown as Array<
    [{ toSlug: string; toSbId: string; threadMessageId: string; metadata?: Row }]
  >;
const wokenInOrder = () => wakes().map(([payload]) => payload.toSlug);

/** A member's turn for the wake it was given is over, as server.ts reports it. */
function turnEnds(slug: string): void {
  const wake = [...wakes()].reverse().find(([payload]) => payload.toSlug === slug);
  if (!wake) throw new Error(`${slug} was never woken`);
  wakeNextInReplyChain(wake[0], (next) => gateway.dispatchTrigger(next as never));
}

const ownerMessages = () =>
  db.rows('inbox_thread_messages').filter((m) => m.sender_kind === 'user');

describe("a group of the owner's inklings answering in turn", () => {
  beforeEach(() => {
    sb('tam', OWNER_TEST_INKLING);
    sb('kit', OWNER_TEST_INKLING);
  });

  it('wakes one member for the owner message, then the next as each turn ends, once each', async () => {
    const started = await call(create, {
      key: KEY,
      recipients: ['pip', 'tam', 'kit'],
      content: 'what do you think?',
    });
    expect(started.status).toBe(200);
    expect(started.body.delivery).toEqual({ status: 'routed', unrouted: [] });
    expect(wokenInOrder()).toEqual(['kit']);

    turnEnds('kit');
    expect(wokenInOrder()).toEqual(['kit', 'pip']);
    // A second ending of the same turn moves nothing.
    turnEnds('kit');
    expect(wokenInOrder()).toEqual(['kit', 'pip']);
    turnEnds('pip');
    turnEnds('tam');
    expect(wokenInOrder()).toEqual(['kit', 'pip', 'tam']);
  });

  it("wakes each later member for the owner's own message, told others answered first", async () => {
    await call(create, { key: KEY, recipients: ['pip', 'tam'], content: 'hi both' });
    const [owner] = ownerMessages();
    turnEnds('pip');
    const [[first], [second]] = wakes();
    expect(first.threadMessageId).toBe(owner!.id);
    expect(first.metadata?.inklingAnswersInTurn).toBeUndefined();
    expect(second).toMatchObject({
      toSlug: 'tam',
      threadMessageId: owner!.id,
      metadata: { inklingAnswersInTurn: true },
    });
  });

  it('routes every member at once, so a waiting member is assigned before it is woken', async () => {
    await call(create, { key: KEY, recipients: ['pip', 'tam'], content: 'hi both' });
    const routed = (
      gateway.processTrigger.mock.calls as unknown as Array<
        [{ toSlug: string; routeOnly?: boolean }]
      >
    )
      .filter(([payload]) => payload.routeOnly)
      .map(([payload]) => payload.toSlug)
      .sort();
    expect(routed).toEqual(['pip', 'tam']);
  });

  it("an inkling's own reply wakes nobody and does not move the chain", async () => {
    await call(create, { key: KEY, recipients: ['pip', 'tam'], content: 'hi both' });
    const dataComposer = { repositories: {}, getClient: () => db };
    await handleSendToInbox(
      { userId: ME, threadKey: KEY, recipientSlug: 'pip', content: 'my take' },
      dataComposer as never,
      { sender: { principal: asSb('pip') as never, workspaceId: WS } }
    );
    expect(wokenInOrder()).toEqual(['pip']);
    turnEnds('pip');
    expect(wokenInOrder()).toEqual(['pip', 'tam']);
  });

  it('rotates who goes first with each owner message', async () => {
    await call(create, { key: KEY, recipients: ['pip', 'tam'], content: 'one' });
    await call(reply, { key: KEY, content: 'two' });
    await call(reply, { key: KEY, content: 'three' });
    expect(wokenInOrder()).toEqual(['pip', 'tam', 'pip']);
  });

  it('a newer owner message ends a chain still waiting on the older one', async () => {
    await call(create, { key: KEY, recipients: ['pip', 'tam'], content: 'one' });
    await call(reply, { key: KEY, content: 'actually, two' });
    expect(wokenInOrder()).toEqual(['pip', 'tam']);
    // pip's turn for the first message ends: tam is not woken for it again.
    const [firstWake] = wakes()[0]!;
    wakeNextInReplyChain(firstWake, (next) => gateway.dispatchTrigger(next as never));
    expect(wokenInOrder()).toEqual(['pip', 'tam']);
    // The second message's chain goes on as usual.
    turnEnds('tam');
    expect(wokenInOrder()).toEqual(['pip', 'tam', 'pip']);
  });

  it('a newer owner message naming one member also ends the waiting chain', async () => {
    await call(create, { key: KEY, recipients: ['pip', 'tam'], content: 'one' });
    await call(reply, { key: KEY, content: 'Pip, just you', wake: ['pip'] });
    expect(wokenInOrder()).toEqual(['pip', 'pip']);
    // pip's turn for the first message ends: tam is not woken for it.
    const [firstWake] = wakes()[0]!;
    wakeNextInReplyChain(firstWake, (next) => gateway.dispatchTrigger(next as never));
    expect(wokenInOrder()).toEqual(['pip', 'pip']);
  });

  it('only the owner writing moves the group: a send by one of its inklings never does', async () => {
    await call(create, { key: KEY, recipients: ['pip', 'tam'], content: 'hi both' });
    const dataComposer = { repositories: {}, getClient: () => db };
    // Even a server-side send that asked for the group rule, as an inkling.
    await handleSendToInbox(
      { userId: ME, threadKey: KEY, recipientSlug: 'tam', content: 'my take' },
      dataComposer as never,
      {
        sender: { principal: asSb('tam') as never, workspaceId: WS },
        inklingGroup: { inTurn: true },
      }
    );
    expect(wokenInOrder()).toEqual(['pip']);
    turnEnds('pip');
    expect(wokenInOrder()).toEqual(['pip', 'tam']);
  });

  it('Stop on any member drops the members not yet woken', async () => {
    await call(create, { key: KEY, recipients: ['pip', 'tam', 'kit'], content: 'hi all' });
    expect(wokenInOrder()).toEqual(['kit']);
    expect(dropReplyChainsFor('sb-kit')).toBe(2);
    turnEnds('kit');
    expect(wokenInOrder()).toEqual(['kit']);
  });

  it('wakes the next member, still one at a time, when the first wake is not accepted (Lumen)', async () => {
    gateway.dispatchTrigger.mockReturnValueOnce({ success: false, accepted: false });
    const res = await call(create, {
      key: KEY,
      recipients: ['kit', 'pip', 'tam'],
      content: 'hi all',
    });
    expect(wokenInOrder()).toEqual(['kit', 'pip']);
    // The receipt says so: kit was meant to wake and didn't.
    expect(res.body.delivery).toEqual({ status: 'partial', unrouted: ['kit'] });
    turnEnds('pip');
    expect(wokenInOrder()).toEqual(['kit', 'pip', 'tam']);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Holds the first routing of `slug` until released, as a slow database would. */
function holdRouting(slug: string) {
  const reached = deferred();
  const release = deferred();
  let held = false;
  gateway.processTrigger.mockImplementation(async (payload: { toSlug: string }) => {
    if (payload.toSlug === slug && !held) {
      held = true;
      reached.resolve();
      await release.promise;
    }
    return { success: true };
  });
  return { reached, release };
}

describe('while a send is still routing its members (Lumen)', () => {
  beforeEach(() => sb('tam', OWNER_TEST_INKLING));

  it("loses no ending: the first member's turn can end before a later member is routed", async () => {
    const barrier = holdRouting('tam');
    const sending = call(create, { key: KEY, recipients: ['pip', 'tam'], content: 'one' });
    await barrier.reached.promise;
    expect(wokenInOrder()).toEqual(['pip']);
    turnEnds('pip');
    barrier.release.resolve();
    await sending;
    expect(wokenInOrder()).toEqual(['pip', 'tam']);
  });

  it('Stop during routing ends the chain: nobody further is woken', async () => {
    const barrier = holdRouting('tam');
    const sending = call(create, { key: KEY, recipients: ['pip', 'tam'], content: 'one' });
    await barrier.reached.promise;
    dropReplyChainsFor('sb-pip');
    barrier.release.resolve();
    await sending;
    turnEnds('pip');
    expect(wokenInOrder()).toEqual(['pip']);
  });

  it('Stop before the first member is woken wakes nobody at all', async () => {
    const barrier = holdRouting('pip');
    const sending = call(create, { key: KEY, recipients: ['pip', 'tam'], content: 'one' });
    await barrier.reached.promise;
    dropReplyChainsFor('sb-tam');
    barrier.release.resolve();
    expect((await sending).status).toBe(200);
    expect(wokenInOrder()).toEqual([]);
  });

  it('an older send still routing cannot replace the chain of a newer owner message', async () => {
    const barrier = holdRouting('tam');
    const oldSend = call(create, { key: KEY, recipients: ['pip', 'tam'], content: 'one' });
    await barrier.reached.promise;
    expect((await call(reply, { key: KEY, content: 'two' })).status).toBe(200);
    expect(wokenInOrder()).toEqual(['pip', 'tam']);
    const [[oldWake], [newWake]] = wakes();
    barrier.release.resolve();
    await oldSend;
    // The older message wakes nobody further; the newer one's chain goes on.
    wakeNextInReplyChain(oldWake, (next) => gateway.dispatchTrigger(next as never));
    expect(wakes().filter(([p]) => p.threadMessageId === oldWake.threadMessageId)).toHaveLength(1);
    wakeNextInReplyChain(newWake, (next) => gateway.dispatchTrigger(next as never));
    expect(wakes().filter(([p]) => p.threadMessageId === newWake.threadMessageId)).toHaveLength(2);
    expect(wokenInOrder()).toEqual(['pip', 'tam', 'pip']);
  });
});

describe('a name wakes only its inkling', () => {
  beforeEach(() => {
    sb('tam', OWNER_TEST_INKLING);
  });

  it('on a reply: only the named member is woken, and no chain waits', async () => {
    await call(create, { key: KEY, recipients: ['pip', 'tam'], content: 'hi both' });
    turnEnds('pip');
    turnEnds('tam');
    gateway.dispatchTrigger.mockClear();
    const res = await call(reply, { key: KEY, content: 'Tam, what about you?', wake: ['tam'] });
    expect(res.status).toBe(200);
    expect(wokenInOrder()).toEqual(['tam']);
    turnEnds('tam');
    expect(wokenInOrder()).toEqual(['tam']);
  });

  it('on the first message of a new group too', async () => {
    const res = await call(create, {
      key: KEY,
      recipients: ['pip', 'tam'],
      content: 'Tam, start us off',
      wake: ['TAM'],
    });
    expect(res.status).toBe(200);
    expect(wokenInOrder()).toEqual(['tam']);
  });

  it('refuses a wake list naming anyone outside the conversation, before writing', async () => {
    await call(create, { key: KEY, recipients: ['pip', 'tam'], content: 'hi both' });
    const before = db.rows('inbox_thread_messages').length;
    for (const wake of [['fern'], [], 'tam', [7]]) {
      const res = await call(reply, { key: KEY, content: 'hello?', wake });
      expect(res, JSON.stringify(wake)).toMatchObject({
        status: 400,
        body: { code: 'wake_not_member' },
      });
    }
    const created = await call(create, {
      key: 'chat:other',
      recipients: ['pip'],
      content: 'hi',
      wake: ['tam'],
    });
    expect(created).toMatchObject({ status: 400, body: { code: 'wake_not_member' } });
    expect(db.rows('inbox_thread_messages').length).toBe(before);
  });
});

describe('a Stop that lands after a send arrived, before it decides who answers (Lumen)', () => {
  beforeEach(() => sb('tam', OWNER_TEST_INKLING));

  /** The reply route's own call, made by hand with the ticket it took on arrival. */
  const replyAsOwner = (content: string, inklingGroup: Row) =>
    handleSendToInbox(
      {
        userId: ME,
        threadKey: KEY,
        content,
        recipients: ['pip', 'tam'],
        triggerAll: true,
        metadata: { sentBy: 'user', channel: 'admin-api' },
      },
      { repositories: {}, getClient: () => db } as never,
      {
        sender: { principal: userPrincipal(ME), workspaceId: WS },
        inklingGroup,
      } as never
    );

  it('wakes nobody in turn for it; a send after the Stop is answered', async () => {
    await call(create, { key: KEY, recipients: ['pip', 'tam'], content: 'one' });
    turnEnds('pip');
    turnEnds('tam');
    gateway.dispatchTrigger.mockClear();
    const ticket = takeReplyTicket();
    dropReplyChainsFor('sb-tam');
    await replyAsOwner('two', { inTurn: true, ticket });
    expect(wokenInOrder()).toEqual([]);
    await call(reply, { key: KEY, content: 'three' });
    expect(wokenInOrder()).toHaveLength(1);
  });

  it('does not wake a named member stopped since; one not stopped is woken', async () => {
    await call(create, { key: KEY, recipients: ['pip', 'tam'], content: 'one' });
    turnEnds('pip');
    turnEnds('tam');
    gateway.dispatchTrigger.mockClear();
    const ticket = takeReplyTicket();
    dropReplyChainsFor('sb-pip');
    await replyAsOwner('Pip?', { wake: ['pip'], ticket });
    expect(wokenInOrder()).toEqual([]);
    await replyAsOwner('Tam?', { wake: ['tam'], ticket });
    expect(wokenInOrder()).toEqual(['tam']);
  });

  it('an older send deciding after a newer one wakes nobody in turn', async () => {
    await call(create, { key: KEY, recipients: ['pip', 'tam'], content: 'one' });
    turnEnds('pip');
    turnEnds('tam');
    gateway.dispatchTrigger.mockClear();
    const older = takeReplyTicket();
    await call(reply, { key: KEY, content: 'newer' });
    const [[newerWake]] = wakes();
    await replyAsOwner('older', { inTurn: true, ticket: older });
    expect(wokenInOrder()).toHaveLength(1);
    // The newer message's chain goes on.
    wakeNextInReplyChain(newerWake, (next) => gateway.dispatchTrigger(next as never));
    expect(wokenInOrder()).toHaveLength(2);
  });
});

describe('a named or one-to-one wake is checked again just before it is sent (Lumen r3)', () => {
  beforeEach(() => sb('tam', OWNER_TEST_INKLING));

  it('a named member stopped while its routing is held is not woken; the receipt does not call that a failure', async () => {
    const barrier = holdRouting('pip');
    const sending = call(create, {
      key: KEY,
      recipients: ['pip', 'tam'],
      content: 'Pip?',
      wake: ['pip'],
    });
    await barrier.reached.promise;
    dropReplyChainsFor('sb-pip');
    barrier.release.resolve();
    const res = await sending;
    expect(res.status).toBe(200);
    expect(wokenInOrder()).toEqual([]);
    expect(res.body.delivery).toEqual({ status: 'routed', unrouted: [] });
  });

  it('a one-to-one inkling stopped while its routing is held is not woken', async () => {
    const barrier = holdRouting('pip');
    const sending = call(create, { key: KEY, recipients: ['pip'], content: 'Hello?' });
    await barrier.reached.promise;
    dropReplyChainsFor('sb-pip');
    barrier.release.resolve();
    expect((await sending).status).toBe(200);
    expect(wokenInOrder()).toEqual([]);
  });

  it('an older named send still routing wakes nobody once a newer message has decided', async () => {
    const barrier = holdRouting('pip');
    const older = call(create, {
      key: KEY,
      recipients: ['pip', 'tam'],
      content: 'Pip?',
      wake: ['pip'],
    });
    await barrier.reached.promise;
    expect((await call(reply, { key: KEY, content: 'Tam instead?', wake: ['tam'] })).status).toBe(
      200
    );
    barrier.release.resolve();
    await older;
    expect(wokenInOrder()).toEqual(['tam']);
  });

  it('an older named send deciding after a newer one wakes nobody', async () => {
    await call(create, { key: KEY, recipients: ['pip', 'tam'], content: 'setup', wake: ['tam'] });
    gateway.dispatchTrigger.mockClear();
    const ticket = takeReplyTicket();
    await call(reply, { key: KEY, content: 'newer', wake: ['tam'] });
    await handleSendToInbox(
      {
        userId: ME,
        threadKey: KEY,
        content: 'older',
        recipients: ['pip', 'tam'],
        triggerAll: true,
        metadata: { sentBy: 'user', channel: 'admin-api' },
      },
      { repositories: {}, getClient: () => db } as never,
      {
        sender: { principal: userPrincipal(ME), workspaceId: WS },
        inklingGroup: { wake: ['pip'], ticket },
      } as never
    );
    expect(wokenInOrder()).toEqual(['tam']);
  });
});

describe('a retried send is held to the members it named (Lumen)', () => {
  beforeEach(() => sb('tam', OWNER_TEST_INKLING));
  const CLIENT_MESSAGE = '33333333-3333-4333-8333-333333333333';

  it('on a reply: the same names replay and wake nobody; other names, or none, are a 409', async () => {
    await call(create, { key: KEY, recipients: ['pip', 'tam'], content: 'setup' });
    const body = { key: KEY, content: 'same words', clientMessageId: CLIENT_MESSAGE };
    const first = await call(reply, { ...body, wake: ['pip'] });
    expect(first.status).toBe(200);
    gateway.dispatchTrigger.mockClear();
    const again = await call(reply, { ...body, wake: ['PIP'] });
    expect(again).toMatchObject({ status: 200, body: { replayed: true } });
    expect(wokenInOrder()).toEqual([]);
    for (const wake of [['tam'], ['pip', 'tam'], undefined, 'pip']) {
      const res = await call(reply, { ...body, ...(wake === undefined ? {} : { wake }) });
      expect(res.status, JSON.stringify(wake)).toBe(409);
    }
    expect(wokenInOrder()).toEqual([]);
  });

  it('a reply that named nobody replays only without names', async () => {
    await call(create, { key: KEY, recipients: ['pip', 'tam'], content: 'setup' });
    const body = { key: KEY, content: 'same words', clientMessageId: CLIENT_MESSAGE };
    expect((await call(reply, body)).status).toBe(200);
    expect((await call(reply, body)).body).toMatchObject({ replayed: true });
    expect((await call(reply, { ...body, wake: ['tam'] })).status).toBe(409);
  });

  it('on a create too', async () => {
    const body = {
      key: KEY,
      recipients: ['pip', 'tam'],
      content: 'same words',
      clientMessageId: CLIENT_MESSAGE,
    };
    expect((await call(create, { ...body, wake: ['pip'] })).status).toBe(200);
    expect((await call(create, { ...body, wake: ['pip'] })).body).toMatchObject({
      replayed: true,
    });
    expect((await call(create, { ...body, wake: ['tam'] })).status).toBe(409);
    expect((await call(create, body)).status).toBe(409);
  });

  it("keeps the names out of the woken member's prompt metadata", async () => {
    await call(create, {
      key: KEY,
      recipients: ['pip', 'tam'],
      content: 'Tam?',
      clientMessageId: CLIENT_MESSAGE,
      wake: ['tam'],
    });
    const [[wake]] = wakes();
    expect(JSON.stringify(wake.metadata ?? {})).not.toMatch(/"wake"/);
  });
});

describe('unchanged elsewhere', () => {
  it('a one-to-one wakes its inkling, with nothing held', async () => {
    await call(create, { key: KEY, recipients: ['pip'], content: 'hi' });
    expect(wokenInOrder()).toEqual(['pip']);
    turnEnds('pip');
    expect(wokenInOrder()).toEqual(['pip']);
  });

  it("an ordinary SB group isn't an inkling conversation: every member is woken", async () => {
    sb('sage');
    sb('myra');
    const res = await call(create, {
      key: 'chat:team',
      recipients: ['sage', 'myra'],
      content: 'hello team',
    });
    expect(res.status).toBe(200);
    expect(wokenInOrder().sort()).toEqual(['myra', 'sage']);
  });
});
