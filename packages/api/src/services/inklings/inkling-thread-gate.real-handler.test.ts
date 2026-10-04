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
import { getRequestContext } from '../../utils/request-context';
import { assertInklingThreadAllowed, InklingThreadRefusedError } from './inkling-thread-gate';

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
  gateway.dispatchTrigger.mockClear();
  gateway.processTrigger.mockClear();
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

  it("the inkling's own reply in its owner's conversation is stored (MCP tool path)", async () => {
    await call(create, { key: KEY, recipients: ['pip'], content: 'hi' });
    // An SB writes with its owner's role, read from the membership table.
    db.seed('workspace_members', { workspace_id: WS, user_id: ME, role: 'owner' });
    // A turn's MCP token binds the inkling's own identity.
    vi.mocked(getRequestContext).mockImplementation(
      () => ({ userId: ME, sbId: 'sb-pip', sbSlug: 'pip' }) as never
    );
    try {
      const dataComposer = { repositories: {}, getClient: () => db };
      const outcome = await handleSendToInbox(
        { userId: ME, threadKey: KEY, recipientSlug: 'pip', content: 'hello, you' },
        dataComposer as never
      ).then(
        () => null,
        (e: unknown) => e
      );
      expect(outcome).toBeNull();
    } finally {
      vi.mocked(getRequestContext).mockImplementation(() => ({ userId: ME }) as never);
    }
    const messages = db.rows('inbox_thread_messages');
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ sender_kind: 'sb', sender_sb_id: 'sb-pip' });
  });

  it("the inkling's own reply, sent with a server-internal sender, is stored", async () => {
    await call(create, { key: KEY, recipients: ['pip'], content: 'hi' });
    expect(await replyAs(asSb('pip'))).toBeNull();
    expect(db.rows('inbox_thread_messages')).toHaveLength(2);
  });

  it("the inkling's reply wakes nobody: no trigger is dispatched and its cap is untouched", async () => {
    // Control: the owner's message does wake the inkling.
    await call(create, { key: KEY, recipients: ['pip'], content: 'hi' });
    expect(woken()).toEqual(['pip']);
    gateway.dispatchTrigger.mockClear();
    gateway.processTrigger.mockClear();
    const metadataBefore = structuredClone(
      db.rows('agent_identities').find((r) => r.id === 'sb-pip')?.metadata
    );

    expect(await replyAs(asSb('pip'))).toBeNull();
    expect(woken()).toEqual([]);
    const pip = db.rows('agent_identities').find((r) => r.id === 'sb-pip');
    expect(pip?.metadata).toEqual(metadataBefore);
  });
});

/** An SB principal in my workspace, as the server resolves one. */
function asSb(slug: string, userId = ME): Row {
  return { kind: 'sb', sbId: `sb-${slug}`, sbSlug: slug, userId, workspaceId: WS };
}

/** A send by `principal` on `key`, addressed to itself unless `recipients` are given. */
async function replyAs(
  principal: Row,
  opts: { key?: string; recipients?: string[]; messageType?: string } = {}
): Promise<unknown> {
  const dataComposer = { repositories: {}, getClient: () => db };
  const to = opts.recipients
    ? { recipients: opts.recipients }
    : { recipientSlug: principal.sbSlug as string };
  return handleSendToInbox(
    {
      userId: ME,
      threadKey: opts.key ?? KEY,
      ...to,
      content: 'from the inkling',
      ...(opts.messageType ? { messageType: opts.messageType } : {}),
    },
    dataComposer as never,
    { sender: { principal: principal as never, workspaceId: WS } }
  ).then(
    () => null,
    (e: unknown) => e
  );
}

/** A conversation as stored, with exactly these members. */
function seedThread(
  members: Array<{ sb_id: string | null; user_id: string | null }>,
  key = KEY
): void {
  const thread = db.seed('inbox_threads', { thread_key: key, workspace_id: WS });
  for (const member of members) {
    db.seed('inbox_thread_participants', { thread_id: thread.id, workspace_id: WS, ...member });
  }
}

describe('an inkling replies only in a conversation it already shares with its owner, and nobody else', () => {
  it('may not start a conversation', async () => {
    expect(await replyAs(asSb('pip'))).toBeInstanceOf(InklingThreadRefusedError);
    expect(written()).toEqual(NOTHING);
  });

  it("may not bring another SB in, even one of its owner's own", async () => {
    await call(create, { key: KEY, recipients: ['pip'], content: 'hi' });
    const before = written();
    sb('tam', OWNER_TEST_INKLING);
    for (const recipients of [
      ['pip', 'fern'],
      ['pip', 'tam'],
    ]) {
      expect(await replyAs(asSb('pip'), { recipients }), recipients.join()).toBeInstanceOf(
        InklingThreadRefusedError
      );
    }
    expect(written()).toEqual(before);
  });

  it("may not write into a conversation it isn't a member of, even its owner's", async () => {
    seedThread([{ sb_id: null, user_id: ME }]);
    expect(await replyAs(asSb('pip'))).toBeInstanceOf(InklingThreadRefusedError);
    expect(db.rows('inbox_thread_messages')).toHaveLength(0);
    expect(db.rows('inbox_thread_participants')).toHaveLength(1);
  });

  it("another of the owner's inklings may not write into this one's conversation", async () => {
    await call(create, { key: KEY, recipients: ['pip'], content: 'hi' });
    sb('tam', OWNER_TEST_INKLING);
    const before = written();
    expect(await replyAs(asSb('tam'))).toBeInstanceOf(InklingThreadRefusedError);
    expect(written()).toEqual(before);
  });

  it('may not reply without its owner in the conversation, or with another person in it', async () => {
    const cases = {
      'chat:pip-alone': [{ sb_id: 'sb-pip', user_id: null }],
      'chat:pip-owner-and-someone': [
        { sb_id: 'sb-pip', user_id: null },
        { sb_id: null, user_id: ME },
        { sb_id: null, user_id: SOMEONE },
      ],
    };
    for (const [key, members] of Object.entries(cases)) {
      seedThread(members, key);
      expect(await replyAs(asSb('pip'), { key }), key).toBeInstanceOf(InklingThreadRefusedError);
    }
    expect(db.rows('inbox_thread_messages')).toHaveLength(0);
  });

  it('the gate itself names the sender: an SB left out of the participants is not the inkling', async () => {
    // handleSendToInbox always lists an SB sender among the participants;
    // the gate does not lean on that.
    seedThread([
      { sb_id: 'sb-pip', user_id: null },
      { sb_id: null, user_id: ME },
    ]);
    const thread = db.rows('inbox_threads')[0];
    const pip = asSb('pip') as never;
    const ask = (sender: Row) =>
      assertInklingThreadAllowed(db as never, {
        sender: sender as never,
        participantSbs: [pip],
        existingThreadId: thread.id as string,
      }).then(
        () => null,
        (e: unknown) => e
      );
    expect(await ask(asSb('pip'))).toBeNull();
    expect(await ask(asSb('fern'))).toBeInstanceOf(InklingThreadRefusedError);
  });

  it('may not reply with the owner test off', async () => {
    await call(create, { key: KEY, recipients: ['pip'], content: 'hi' });
    const before = written();
    vi.stubEnv('INKLING_OWNER_TEST_USER_ID', '');
    const refused = await replyAs(asSb('pip'));
    expect(refused).toBeInstanceOf(InklingThreadRefusedError);
    expect((refused as InklingThreadRefusedError).code).toBe('inklings_disabled');
    expect(written()).toEqual(before);
  });

  it("an inkling not born under the owner test, or another account's, may not reply", async () => {
    sb('old', { client: 'inkling-mobile', named: false });
    sb('elsewhere', OWNER_TEST_INKLING, SOMEONE);
    for (const [slug, owner] of [
      ['old', ME],
      ['elsewhere', SOMEONE],
    ] as const) {
      const key = `chat:${slug}`;
      seedThread(
        [
          { sb_id: `sb-${slug}`, user_id: null },
          { sb_id: null, user_id: owner },
        ],
        key
      );
      expect(await replyAs(asSb(slug, owner), { key }), slug).toBeInstanceOf(
        InklingThreadRefusedError
      );
    }
    expect(db.rows('inbox_thread_messages')).toHaveLength(0);
  });
});

describe('a conversation with no inkling', () => {
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

describe('with more than one account in the owner test, each reaches only its own inklings', () => {
  beforeEach(() => {
    // The list alone, with the single-account variable unset.
    vi.stubEnv('INKLING_OWNER_TEST_USER_ID', '');
    vi.stubEnv('INKLING_OWNER_TEST_USER_IDS', `${ME},${SOMEONE}`);
    sb('moss', OWNER_TEST_INKLING, SOMEONE);
  });

  it('each listed account may start a conversation with its own inkling, and its inkling may reply', async () => {
    expect((await call(create, { key: KEY, recipients: ['pip'], content: 'hi' })).status).toBe(200);
    const theirs = 'chat:conversation-moss';
    expect(
      (await call(create, { key: theirs, recipients: ['moss'], content: 'hi' }, SOMEONE)).status
    ).toBe(200);
    expect(await replyAs(asSb('moss', SOMEONE), { key: theirs })).toBeNull();
    expect(await replyAs(asSb('pip'))).toBeNull();
    expect(db.rows('inbox_thread_messages')).toHaveLength(4);
  });

  it("a listed account may not start a conversation with, or write into, another listed account's inkling", async () => {
    const intruding = await call(create, { key: KEY, recipients: ['pip'], content: 'hi' }, SOMEONE);
    expect(intruding).toMatchObject({ status: 403, body: { code: 'inkling_thread_refused' } });
    const reverse = await call(create, { key: 'chat:moss', recipients: ['moss'], content: 'hi' });
    expect(reverse).toMatchObject({ status: 403, body: { code: 'inkling_thread_refused' } });
    expect(written()).toEqual(NOTHING);

    await call(create, { key: KEY, recipients: ['pip'], content: 'hi' });
    const before = written();
    const replying = await call(reply, { key: KEY, content: 'me too' }, SOMEONE);
    expect(replying.status).not.toBe(200);
    expect(written()).toEqual(before);
  });

  it('an account left off the list is refused, and an empty list closes the test', async () => {
    vi.stubEnv('INKLING_OWNER_TEST_USER_IDS', SOMEONE);
    const res = await call(create, { key: KEY, recipients: ['pip'], content: 'hi' });
    expect(res).toMatchObject({ status: 403, body: { code: 'inkling_thread_refused' } });
    vi.stubEnv('INKLING_OWNER_TEST_USER_IDS', ' , ');
    const off = await call(create, { key: KEY, recipients: ['pip'], content: 'hi' });
    expect(off).toMatchObject({ status: 403, body: { code: 'inklings_disabled' } });
    expect(written()).toEqual(NOTHING);
  });
});

describe("owner-present groups of the owner's own inklings, up to three", () => {
  beforeEach(() => {
    sb('tam', OWNER_TEST_INKLING);
    sb('wisp', OWNER_TEST_INKLING);
    sb('kit', OWNER_TEST_INKLING);
  });

  it('the owner may start one with two or three of their inklings, and write in it', async () => {
    const two = await call(create, { key: KEY, recipients: ['pip', 'tam'], content: 'hi' });
    expect(two.status).toBe(200);
    expect((await call(reply, { key: KEY, content: 'and again' })).status).toBe(200);
    const three = await call(create, {
      key: 'chat:three',
      recipients: ['pip', 'tam', 'wisp'],
      content: 'hi',
    });
    expect(three.status).toBe(200);
    expect(db.rows('inbox_thread_messages')).toHaveLength(3);
  });

  it('each member inkling may reply, and its reply wakes nobody', async () => {
    await call(create, { key: KEY, recipients: ['pip', 'tam'], content: 'hi' });
    // Control: the owner's message woke every member.
    expect(woken()).toEqual(['pip', 'tam']);
    gateway.dispatchTrigger.mockClear();
    gateway.processTrigger.mockClear();
    for (const slug of ['pip', 'tam']) {
      expect(await replyAs(asSb(slug)), slug).toBeNull();
    }
    expect(db.rows('inbox_thread_messages')).toHaveLength(3);
    expect(woken()).toEqual([]);
  });

  it('a member inkling addressing its siblings, or asking for action, still wakes nobody', async () => {
    await call(create, { key: KEY, recipients: ['pip', 'tam'], content: 'hi' });
    gateway.dispatchTrigger.mockClear();
    gateway.processTrigger.mockClear();
    expect(await replyAs(asSb('pip'), { recipients: ['pip', 'tam'] })).toBeNull();
    expect(await replyAs(asSb('pip'), { messageType: 'task_request' })).toBeNull();
    expect(await replyAs(asSb('tam'), { messageType: 'session_resume' })).toBeNull();
    expect(woken()).toEqual([]);
  });

  it("in a one-to-one too, an inkling's actionable message to itself wakes nobody (#738's disclosed edge)", async () => {
    await call(create, { key: KEY, recipients: ['pip'], content: 'hi' });
    gateway.dispatchTrigger.mockClear();
    gateway.processTrigger.mockClear();
    for (const messageType of ['task_request', 'session_resume']) {
      expect(await replyAs(asSb('pip'), { messageType }), messageType).toBeNull();
    }
    expect(woken()).toEqual([]);
  });

  it("an ordinary SB's reply in a person's group thread still wakes whom it names (unchanged)", async () => {
    // Must-not-change control (Myra 495a3ba8): only an inkling sender is
    // quiet, never an SB sender as such, and never a thread's shape.
    sb('sage');
    sb('myra');
    const team = 'chat:team';
    const started = await call(create, {
      key: team,
      recipients: ['fern', 'sage', 'myra'],
      content: 'hi',
    });
    expect(started.status).toBe(200);
    gateway.dispatchTrigger.mockClear();
    gateway.processTrigger.mockClear();
    expect(await replyAs(asSb('fern'), { key: team, recipients: ['sage', 'myra'] })).toBeNull();
    expect(woken()).toEqual(['myra', 'sage']);
  });

  it('more than three is refused whole', async () => {
    const res = await call(create, {
      key: KEY,
      recipients: ['pip', 'tam', 'wisp', 'kit'],
      content: 'hi',
    });
    expect(res).toMatchObject({ status: 403, body: { code: 'inkling_thread_refused' } });
    expect(written()).toEqual(NOTHING);
  });

  it("a non-inkling SB, or another account's inkling, is never in a group", async () => {
    vi.stubEnv('INKLING_OWNER_TEST_USER_IDS', SOMEONE);
    sb('moss', OWNER_TEST_INKLING, SOMEONE);
    for (const recipients of [
      ['pip', 'tam', 'fern'],
      ['pip', 'moss'],
    ]) {
      const res = await call(create, {
        key: `chat:${recipients.join('-')}`,
        recipients,
        content: 'hi',
      });
      expect(res, recipients.join()).toMatchObject({
        status: 403,
        body: { code: 'inkling_thread_refused' },
      });
    }
    expect(written()).toEqual(NOTHING);
  });

  it('a member inkling may not reply without the owner present, or bring a sibling in', async () => {
    seedThread([
      { sb_id: 'sb-pip', user_id: null },
      { sb_id: 'sb-tam', user_id: null },
    ]);
    expect(await replyAs(asSb('pip'))).toBeInstanceOf(InklingThreadRefusedError);

    await call(create, { key: 'chat:pair', recipients: ['pip', 'tam'], content: 'hi' });
    const before = written();
    expect(
      await replyAs(asSb('pip'), { key: 'chat:pair', recipients: ['pip', 'wisp'] })
    ).toBeInstanceOf(InklingThreadRefusedError);
    expect(await replyAs(asSb('wisp'), { key: 'chat:pair' })).toBeInstanceOf(
      InklingThreadRefusedError
    );
    expect(written()).toEqual(before);
  });
});
