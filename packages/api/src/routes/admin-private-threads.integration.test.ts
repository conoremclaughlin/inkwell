/**
 * An inkling conversation is its participants' alone
 * (ink://specs/inkling-multi-person-groups, D3), against the REAL admin
 * middleware and a real database.
 *
 * One team space with an owner, a member and a viewer, and one of the
 * owner's inklings. The owner's 1:1 with the inkling and a member's 1:1 with
 * it are both participant-only: nobody else reads either, by list, preview,
 * count, timeline or a carrier's spine, and a workspace role confers nothing,
 * the space owner's included. So is a group chat the owner made with the
 * member: its people read it, marked shared, and nobody else does. An
 * ordinary thread in the same space stays readable by everyone in it, and so
 * does a public conversation (conversation_mode 'public'), which an admin
 * not in it joins by posting. A person outside the space reads none of it.
 *
 * Run via: yarn test:integration:db:local src/routes/admin-private-threads.integration.test.ts
 *
 * Every person here is invented, at example.com.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Client } from 'pg';
import router, { issueMobileTokens } from './admin';

let db: Client;

async function connect(): Promise<Client> {
  const url = process.env.INTEGRATION_DB_URL;
  if (!url) throw new Error('INTEGRATION_DB_URL is required: run through the managed harness');
  const { Client: PgClient } = await import('pg');
  const client = new PgClient({ connectionString: url });
  await client.connect();
  return client;
}

type Middleware = (req: Request, res: Response, next: NextFunction) => Promise<void>;
type Handler = (req: Request, res: Response) => Promise<void>;

function middleware(): Middleware {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find((entry: any) => entry.name === 'adminAuthMiddleware');
  if (!layer) throw new Error('adminAuthMiddleware not found in router stack');
  return layer.handle;
}

type Method = 'get' | 'post' | 'put';

function route(method: Method, path: string): Handler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

interface Person {
  label: string;
  userId: string;
  token: string;
}

/** One request through the real middleware and then the route, as this person in the space. */
async function call(
  person: Person,
  method: Method,
  routePath: string,
  options: {
    query?: Record<string, string>;
    params?: Record<string, string>;
    body?: Record<string, unknown>;
    /** False for a person the middleware is expected to refuse. */
    reaches?: boolean;
  } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${person.token}`,
    'x-ink-workspace-id': spaceId,
  };
  const params = options.params ?? {};
  const path = routePath.replace(/:([A-Za-z]+)/g, (_, name: string) => params[name]);
  const req = {
    method: method.toUpperCase(),
    path,
    headers,
    cookies: {},
    params,
    query: options.query ?? {},
    body: options.body ?? {},
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
  const sent = { status: 200, body: undefined as unknown };
  const closes: Array<() => void> = [];
  const res = {
    once(event: string, fn: () => void) {
      if (event === 'close') closes.push(fn);
      return this;
    },
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
    set() {
      return this;
    },
    cookie() {
      return this;
    },
  } as unknown as Response;
  let handled: Promise<void> | undefined;
  await middleware()(req, res, () => {
    handled = route(method, routePath)(req, res);
  });
  await handled;
  for (const close of closes) close();
  if (options.reaches === false) {
    expect(handled, `${person.label} was stopped before ${path}`).toBeUndefined();
  } else {
    expect(handled, `${person.label} reached ${path}`).toBeDefined();
  }
  return { status: sent.status, body: sent.body as Record<string, unknown> };
}

const get = (
  person: Person,
  routePath: string,
  options: { query?: Record<string, string>; params?: Record<string, string> } = {}
) => call(person, 'get', routePath, options);

const run = randomUUID().slice(0, 8);
let spaceId: string;
let inklingSbId: string;
/** The owner's inkling in the public conversation: an owner-test inkling, so the gates admit posts. */
let reedSbId: string;
/** One of the owner's SBs that isn't an inkling and isn't in any conversation here. */
let ownersSbId: string;
const taskGroupIds: string[] = [];
let owner: Person;
let member: Person;
let viewer: Person;
let admin: Person;
/** A person with an account but no place in the space. */
let outsider: Person;
const threadIdByKey = new Map<string, string>();
const threadIds: string[] = [];
const sessionIds: string[] = [];

const keys = {
  ownerChat: `chat:conversation-owner-${run}`,
  memberChat: `chat:conversation-member-${run}`,
  open: `chat:open-${run}`,
  markFalse: `chat:mark-false-${run}`,
  markString: `chat:mark-string-${run}`,
  group: `chat:group-${run}`,
  public: `chat:public-${run}`,
};
const canary = {
  ownerChat: `owner-chat-canary-${run}`,
  memberChat: `member-chat-canary-${run}`,
  open: `open-thread-words-${run}`,
  group: `group-chat-canary-${run}`,
  public: `public-thread-words-${run}`,
};

async function person(
  label: string,
  role: 'owner' | 'admin' | 'member' | 'viewer' | null
): Promise<Person> {
  const email = `${label}-${run}@example.com`;
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO users (email, auth_uid) VALUES ($1, gen_random_uuid()) RETURNING id',
    [email]
  );
  const userId = rows[0].id;
  if (role === 'owner') {
    const { rows: space } = await db.query<{ id: string }>(
      "INSERT INTO workspaces (user_id, name, slug, type) VALUES ($1, 'Choir', $2, 'team') RETURNING id",
      [userId, `choir-${run}`]
    );
    spaceId = space[0].id;
  }
  if (role) {
    await db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [spaceId, userId, role]
    );
  }
  const { getDataComposer } = await import('../data/composer');
  const supabase = (await getDataComposer()).getClient();
  const tokens = await issueMobileTokens(supabase as never, userId, email);
  return { label, userId, token: tokens.accessToken };
}

let clock = Date.now();
/** A strictly later instant on every call, so a timeline's order is fixed. */
const tick = () => new Date((clock += 1000)).toISOString();

async function thread(
  key: string,
  metadata: Record<string, unknown>,
  people: string[],
  words: string,
  options: { mode?: 'public' | 'private'; sbId?: string } = {}
): Promise<string> {
  const sbId = options.sbId ?? inklingSbId;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO inbox_threads (thread_key, workspace_id, created_by_kind, created_by_user_id, title, metadata, conversation_mode)
     VALUES ($1, $2, 'user', $3, $4, $5, $6) RETURNING id`,
    [key, spaceId, people[0], `fixture ${key}`, JSON.stringify(metadata), options.mode ?? null]
  );
  const threadId = rows[0].id;
  threadIds.push(threadId);
  threadIdByKey.set(key, threadId);
  for (const userId of people) {
    await db.query(
      'INSERT INTO inbox_thread_participants (thread_id, workspace_id, user_id) VALUES ($1, $2, $3)',
      [threadId, spaceId, userId]
    );
  }
  await db.query(
    'INSERT INTO inbox_thread_participants (thread_id, workspace_id, sb_id) VALUES ($1, $2, $3)',
    [threadId, spaceId, sbId]
  );
  await db.query(
    `INSERT INTO inbox_thread_messages (thread_id, sender_kind, sender_user_id, content, created_at)
     VALUES ($1, 'user', $2, $3, $4)`,
    [threadId, people[0], `hello ${words}`, tick()]
  );
  await db.query(
    `INSERT INTO inbox_thread_messages (thread_id, sender_kind, sender_sb_id, sender_agent_id, content, created_at)
     VALUES ($1, 'sb', $2, $3, $4, $5)`,
    [threadId, sbId, sbId === inklingSbId ? `moss-${run}` : `reed-${run}`, `reply ${words}`, tick()]
  );
  return threadId;
}

beforeAll(async () => {
  db = await connect();
  owner = await person('ada', 'owner');
  member = await person('ben', 'member');
  viewer = await person('cai', 'viewer');
  admin = await person('dee', 'admin');
  outsider = await person('eli', null);

  const { rows: inkling } = await db.query<{ id: string }>(
    `INSERT INTO agent_identities (user_id, workspace_id, agent_id, name, role, backend, metadata)
     VALUES ($1, $2, $3, 'Moss', 'Integration inkling', 'claude', $4) RETURNING id`,
    [
      owner.userId,
      spaceId,
      `moss-${run}`,
      JSON.stringify({ client: 'inkling', ownerTest: true, fixture: true }),
    ]
  );
  inklingSbId = inkling[0].id;
  const { rows: ownersSb } = await db.query<{ id: string }>(
    `INSERT INTO agent_identities (user_id, workspace_id, agent_id, name, role, backend, metadata)
     VALUES ($1, $2, $3, 'Ivy', 'Integration SB', 'claude', '{"fixture": true}') RETURNING id`,
    [owner.userId, spaceId, `ivy-${run}`]
  );
  ownersSbId = ownersSb[0].id;
  const { rows: reed } = await db.query<{ id: string }>(
    `INSERT INTO agent_identities (user_id, workspace_id, agent_id, name, role, backend, metadata)
     VALUES ($1, $2, $3, 'Reed', 'Integration inkling', 'claude', $4) RETURNING id`,
    [
      owner.userId,
      spaceId,
      `reed-${run}`,
      JSON.stringify({ client: 'inkling-mobile', ownerTest: true, fixture: true }),
    ]
  );
  reedSbId = reed[0].id;

  // The space is new, so these seven are every thread in it.
  await thread(keys.ownerChat, { inklingConversation: true }, [owner.userId], canary.ownerChat);
  await thread(keys.memberChat, { inklingConversation: true }, [member.userId], canary.memberChat);
  await thread(keys.open, {}, [owner.userId], canary.open);
  await thread(keys.markFalse, { inklingConversation: false }, [owner.userId], 'mark false');
  await thread(keys.markString, { inklingConversation: 'true' }, [owner.userId], 'mark string');
  // A group chat the owner made with the member, marked in its creating insert.
  await thread(
    keys.group,
    { inklingConversation: true, inklingShared: true },
    [owner.userId, member.userId],
    canary.group
  );
  // A public conversation the member started with Reed, the owner's
  // inkling. The owner is not in it.
  await thread(keys.public, { inklingConversation: true }, [member.userId], canary.public, {
    mode: 'public',
    sbId: reedSbId,
  });

  // The inkling's session on the owner's 1:1: a carrier that names its key.
  const { rows: session } = await db.query<{ id: string }>(
    `INSERT INTO sessions (user_id, agent_id, sb_id, thread_key, active_thread_key, lifecycle, metadata)
     VALUES ($1, $2, $3, $4, $4, 'idle', '{"fixture": true}') RETURNING id`,
    [owner.userId, `moss-${run}`, inklingSbId, keys.ownerChat]
  );
  sessionIds.push(session[0].id);
}, 60_000);

afterAll(async () => {
  if (db) {
    if (threadIds.length > 0) {
      await db.query('DELETE FROM inbox_thread_messages WHERE thread_id = ANY($1)', [threadIds]);
      await db.query('DELETE FROM inbox_thread_participants WHERE thread_id = ANY($1)', [
        threadIds,
      ]);
      await db.query('DELETE FROM inbox_threads WHERE id = ANY($1)', [threadIds]);
    }
    if (sessionIds.length > 0) {
      await db.query('DELETE FROM sessions WHERE id = ANY($1)', [sessionIds]);
    }
    if (taskGroupIds.length > 0) {
      await db.query('DELETE FROM task_groups WHERE id = ANY($1)', [taskGroupIds]);
    }
    if (inklingSbId) await db.query('DELETE FROM agent_identities WHERE id = $1', [inklingSbId]);
    if (ownersSbId) await db.query('DELETE FROM agent_identities WHERE id = $1', [ownersSbId]);
    if (reedSbId) await db.query('DELETE FROM agent_identities WHERE id = $1', [reedSbId]);
    await db.end();
  }
});

/** The spine keys and the full response text a person's list carries. */
async function list(who: Person) {
  const { status, body } = await get(who, '/threads');
  expect(status, `${who.label} lists threads`).toBe(200);
  const spines = body.spines as Array<{
    key: string;
    thread: { shared?: boolean; conversationMode?: string | null } | null;
  }>;
  return {
    keys: new Set(spines.map((s) => s.key)),
    shared: new Map(spines.map((s) => [s.key, s.thread?.shared])),
    mode: new Map(spines.map((s) => [s.key, s.thread?.conversationMode])),
    text: JSON.stringify(body),
    meta: (body.meta as { threads: { fetched: number; total: number } }).threads,
  };
}

async function timeline(who: Person, key: string) {
  const { status, body } = await get(who, '/threads/messages', { query: { key } });
  expect(status, `${who.label} reads ${key}`).toBe(200);
  return body as {
    thread: { threadKey: string; shared?: boolean; conversationMode?: string | null } | null;
    messages: Array<{ content: string }>;
    studioHistory: unknown[];
  };
}

describe('the list (GET /threads)', () => {
  it("shows a member and a viewer nothing of the owner's 1:1: no spine, no preview, no carrier", async () => {
    for (const who of [member, viewer]) {
      const seen = await list(who);
      expect(seen.keys.has(keys.ownerChat), `${who.label} sees the owner's 1:1`).toBe(false);
      expect(seen.text).not.toContain(canary.ownerChat);
      expect(seen.text).not.toContain(keys.ownerChat);
    }
  });

  it("shows the space owner nothing of a member's 1:1: a role confers nothing", async () => {
    const seen = await list(owner);
    expect(seen.keys.has(keys.memberChat)).toBe(false);
    expect(seen.text).not.toContain(canary.memberChat);
  });

  it('shows each participant their own 1:1, with its preview', async () => {
    const ownerSeen = await list(owner);
    expect(ownerSeen.keys.has(keys.ownerChat)).toBe(true);
    expect(ownerSeen.text).toContain(canary.ownerChat);
    const memberSeen = await list(member);
    expect(memberSeen.keys.has(keys.memberChat)).toBe(true);
    expect(memberSeen.text).toContain(canary.memberChat);
  });

  it('shows everyone in the space an ordinary thread, and a mark that is not JSON true', async () => {
    for (const who of [owner, member, viewer]) {
      const seen = await list(who);
      expect(seen.keys.has(keys.open), `${who.label} sees the open thread`).toBe(true);
      expect(seen.text).toContain(canary.open);
      expect(seen.keys.has(keys.markFalse)).toBe(true);
      expect(seen.keys.has(keys.markString)).toBe(true);
    }
  });

  it('shows a group chat to its people, marked shared, and nothing of it to anyone else', async () => {
    for (const who of [owner, member]) {
      const seen = await list(who);
      expect(seen.keys.has(keys.group), `${who.label} sees the group`).toBe(true);
      expect(seen.shared.get(keys.group), who.label).toBe(true);
      expect(seen.text).toContain(canary.group);
      expect(seen.shared.get(keys.open), `${who.label}: an ordinary thread`).toBe(false);
    }
    expect((await list(owner)).shared.get(keys.ownerChat)).toBe(false);
    for (const who of [viewer, admin]) {
      const seen = await list(who);
      expect(seen.keys.has(keys.group), `${who.label} sees the group`).toBe(false);
      expect(seen.text).not.toContain(canary.group);
      expect(seen.text).not.toContain(keys.group);
    }
  });

  it('shows everyone in the space the public conversation, marked public, with its preview', async () => {
    for (const who of [owner, member, viewer, admin]) {
      const seen = await list(who);
      expect(seen.keys.has(keys.public), `${who.label} sees the public conversation`).toBe(true);
      expect(seen.mode.get(keys.public), who.label).toBe('public');
      expect(seen.text).toContain(canary.public);
    }
    // A group made with people stays private: no mode.
    expect((await list(owner)).mode.get(keys.group)).toBeNull();
  });

  it('counts only what the person may read, and a public conversation its people are in once', async () => {
    // Everyone reads the three open threads and the public conversation,
    // which the member is in. The owner and the member each read their own
    // 1:1 and the group besides. The viewer's window also hydrated the
    // owner's 1:1 for the inkling's session, and dropped it.
    const [ownerSeen, memberSeen, viewerSeen, adminSeen] = await Promise.all([
      list(owner),
      list(member),
      list(viewer),
      list(admin),
    ]);
    expect(viewerSeen.meta).toMatchObject({ total: 4, fetched: 4 });
    expect(adminSeen.meta).toMatchObject({ total: 4, fetched: 4 });
    expect(ownerSeen.meta).toMatchObject({ total: 6, fetched: 6 });
    expect(memberSeen.meta).toMatchObject({ total: 6, fetched: 6 });
  });

  it('shows a person outside the space nothing: the middleware stops them', async () => {
    for (const [routePath, query] of [
      ['/threads', {}],
      ['/threads/messages', { key: keys.public }],
    ] as const) {
      const refused = await call(outsider, 'get', routePath, { query, reaches: false });
      expect(refused.status, routePath).toBe(403);
      expect(JSON.stringify(refused.body)).not.toContain(canary.public);
    }
  });
});

describe('the timeline (GET /threads/messages)', () => {
  it("answers a member and a viewer for the owner's 1:1 as for a key nobody has used", async () => {
    const unused = await timeline(viewer, `chat:conversation-unused-${run}`);
    for (const who of [member, viewer]) {
      const seen = await timeline(who, keys.ownerChat);
      expect(seen).toEqual(unused);
      expect(seen).toEqual({ thread: null, messages: [], studioHistory: [] });
    }
  });

  it("answers the space owner for a member's 1:1 the same way", async () => {
    const seen = await timeline(owner, keys.memberChat);
    expect(seen).toEqual({ thread: null, messages: [], studioHistory: [] });
  });

  it('serves each participant their own 1:1', async () => {
    const ownerSeen = await timeline(owner, keys.ownerChat);
    expect(ownerSeen.thread?.threadKey).toBe(keys.ownerChat);
    expect(ownerSeen.messages.map((m) => m.content)).toEqual([
      `hello ${canary.ownerChat}`,
      `reply ${canary.ownerChat}`,
    ]);
    const memberSeen = await timeline(member, keys.memberChat);
    expect(memberSeen.thread?.threadKey).toBe(keys.memberChat);
    expect(memberSeen.messages).toHaveLength(2);
  });

  it('serves a group chat to its people, marked shared, and to nobody else', async () => {
    for (const who of [owner, member]) {
      const seen = await timeline(who, keys.group);
      expect(seen.thread, who.label).toMatchObject({ threadKey: keys.group, shared: true });
      expect(seen.messages.map((m) => m.content)).toEqual([
        `hello ${canary.group}`,
        `reply ${canary.group}`,
      ]);
    }
    expect((await timeline(owner, keys.ownerChat)).thread?.shared).toBe(false);
    for (const who of [viewer, admin]) {
      expect(await timeline(who, keys.group), who.label).toEqual({
        thread: null,
        messages: [],
        studioHistory: [],
      });
    }
  });

  it('serves the public conversation to everyone in the space, marked public', async () => {
    for (const who of [owner, member, viewer, admin]) {
      const seen = await timeline(who, keys.public);
      expect(seen.thread, who.label).toMatchObject({
        threadKey: keys.public,
        conversationMode: 'public',
      });
      expect(seen.messages.map((m) => m.content)).toEqual([
        `hello ${canary.public}`,
        `reply ${canary.public}`,
      ]);
    }
  });

  it('serves an ordinary thread to everyone in the space, unchanged', async () => {
    for (const who of [owner, member, viewer]) {
      const seen = await timeline(who, keys.open);
      expect(seen.thread?.threadKey, who.label).toBe(keys.open);
      expect(seen.messages.map((m) => m.content)).toEqual([
        `hello ${canary.open}`,
        `reply ${canary.open}`,
      ]);
    }
  });
});

describe("an inkling's own inbox (GET /individuals/:sbSlug/inbox)", () => {
  it("shows its owner their own 1:1 and not a member's: owning the inkling is not being in it", async () => {
    const { status, body } = await get(owner, '/individuals/:sbSlug/inbox', {
      params: { sbSlug: `moss-${run}` },
    });
    expect(status).toBe(200);
    const threadKeys = (body.groupThreads as Array<{ threadKey: string }>).map((t) => t.threadKey);
    expect(threadKeys).toContain(keys.ownerChat);
    expect(threadKeys).toContain(keys.open);
    expect(threadKeys).not.toContain(keys.memberChat);
    expect(JSON.stringify(body)).not.toContain(canary.memberChat);
    expect((body.stats as { groupThreadsUnavailable: boolean }).groupThreadsUnavailable).toBe(
      false
    );
  });

  it("shows its owner a public conversation of its inkling's that the owner is not in", async () => {
    const { status, body } = await get(owner, '/individuals/:sbSlug/inbox', {
      params: { sbSlug: `reed-${run}` },
    });
    expect(status).toBe(200);
    const threadKeys = (body.groupThreads as Array<{ threadKey: string }>).map((t) => t.threadKey);
    expect(threadKeys).toEqual([keys.public]);
  });
});

describe('the agent-less inbox (MCP get_inbox without sbSlug)', () => {
  /** get_inbox naming no SB, as an unbound person: a request context with no SB. */
  async function inbox(who: Person) {
    const { handleGetInbox } = await import('../mcp/tools/inbox-handlers');
    const { getDataComposer } = await import('../data/composer');
    const { runWithRequestContext } = await import('../utils/request-context');
    const dataComposer = await getDataComposer();
    const res = await runWithRequestContext({ userId: who.userId }, () =>
      handleGetInbox(
        { userId: who.userId, status: 'unread', limit: 20, markRead: false },
        dataComposer
      )
    );
    const body = JSON.parse((res as { content: Array<{ text: string }> }).content[0].text);
    const threads = body.threadsWithUnread as Array<{ threadKey: string }>;
    return {
      keys: new Set(threads.map((t) => t.threadKey)),
      all: threads.map((t) => t.threadKey),
      text: JSON.stringify(body),
    };
  }

  it("shows a member and a viewer none of the owner's 1:1, and the owner none of a member's", async () => {
    for (const who of [member, viewer]) {
      const seen = await inbox(who);
      expect(seen.keys.has(keys.ownerChat), who.label).toBe(false);
      expect(seen.text).not.toContain(canary.ownerChat);
    }
    // Nor a viewer the group chat they are not in.
    expect((await inbox(viewer)).text).not.toContain(canary.group);
    const ownerSeen = await inbox(owner);
    expect(ownerSeen.keys.has(keys.memberChat)).toBe(false);
    expect(ownerSeen.text).not.toContain(canary.memberChat);
  });

  it('shows each participant their own 1:1, and everyone the ordinary thread', async () => {
    expect((await inbox(owner)).keys.has(keys.ownerChat)).toBe(true);
    expect((await inbox(member)).keys.has(keys.memberChat)).toBe(true);
    for (const who of [owner, member, viewer]) {
      expect((await inbox(who)).keys.has(keys.open), who.label).toBe(true);
    }
  });

  it('shows everyone the public conversation, once to a person in it', async () => {
    for (const who of [owner, member, viewer, admin]) {
      const seen = await inbox(who);
      expect(
        seen.all.filter((key) => key === keys.public),
        who.label
      ).toEqual([keys.public]);
    }
  });
});

describe('the agent-less inbox for a token bound to an SB (Lumen, #874 r1 and r2)', () => {
  /**
   * The context a verified token gives: its identity spread in, plus what
   * tokenIdentityContext adds. `slug: false` is a token bound by its
   * canonical id alone.
   */
  async function bound(sbSlug: string, sbId: string, slug = true) {
    const { tokenIdentityContext } = await import('../utils/request-context');
    const identity = { sbId, ...(slug ? { sbSlug } : {}) };
    return { ...identity, ...tokenIdentityContext(identity) };
  }

  async function inbox(context: Record<string, unknown>) {
    const { handleGetInbox } = await import('../mcp/tools/inbox-handlers');
    const { getDataComposer } = await import('../data/composer');
    const { runWithRequestContext } = await import('../utils/request-context');
    const dataComposer = await getDataComposer();
    const res = await runWithRequestContext({ userId: owner.userId, ...context }, () =>
      handleGetInbox(
        { userId: owner.userId, status: 'unread', limit: 20, markRead: false },
        dataComposer
      )
    );
    const body = JSON.parse((res as { content: Array<{ text: string }> }).content[0].text);
    const threads = body.threadsWithUnread as Array<{ threadKey: string }>;
    return {
      keys: new Set(threads.map((t) => t.threadKey)),
      all: threads.map((t) => t.threadKey),
      text: JSON.stringify(body),
    };
  }

  it.each([
    ['by slug and id', true],
    ['by id alone', false],
  ])(
    "reads as the SB, not its person, bound %s: the owner's own SB sees none of the owner's 1:1s",
    async (_label, slug) => {
      const seen = await inbox(await bound(`ivy-${run}`, ownersSbId, slug));
      expect(seen.keys.has(keys.ownerChat)).toBe(false);
      expect(seen.text).not.toContain(canary.ownerChat);
      expect(seen.keys.has(keys.group)).toBe(false);
      expect(seen.text).not.toContain(canary.group);
      expect(seen.keys.has(keys.open)).toBe(true);
      // A public conversation is the space's, so any reader in it sees it.
      expect(seen.keys.has(keys.public)).toBe(true);
    }
  );

  it.each([
    ['by slug and id', true],
    ['by id alone', false],
  ])('shows the public conversation once to its own inkling, bound %s', async (_label, slug) => {
    const seen = await inbox(await bound(`reed-${run}`, reedSbId, slug));
    expect(seen.all.filter((key) => key === keys.public)).toEqual([keys.public]);
  });

  it.each([
    ['by slug and id', true],
    ['by id alone', false],
  ])('shows a bound SB the conversations it is in, bound %s (control)', async (_label, slug) => {
    const seen = await inbox(await bound(`moss-${run}`, inklingSbId, slug));
    expect(seen.keys.has(keys.ownerChat)).toBe(true);
    // The member's 1:1, which the inkling is in and the owner is not.
    expect(seen.keys.has(keys.memberChat)).toBe(true);
  });
});

describe('graph evidence on a conversation key (Lumen, #874 r1)', () => {
  beforeAll(async () => {
    // A graph group is born by conversion: inserted linear at version 0, then
    // converted through convert_task_group_to_graph, as the database requires.
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO task_groups (user_id, sb_id, title, thread_key, status)
       VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
      [owner.userId, inklingSbId, `graph-canary-${run}`, keys.ownerChat]
    );
    taskGroupIds.push(rows[0].id);
    const { rows: converted } = await db.query<{ result: { success: boolean } }>(
      'SELECT public.convert_task_group_to_graph($1, $2, 0, NULL, NULL, true) AS result',
      [owner.userId, rows[0].id]
    );
    expect(converted[0].result).toMatchObject({ success: true });
  });

  const evidence = async (who: Person) => {
    const { status, body } = await get(who, '/threads/graph-evidence', {
      query: { key: keys.ownerChat },
    });
    expect(status).toBe(200);
    return body as { groups: unknown[] };
  };

  it("gives a member nothing for the owner's 1:1, as for a key with no graph", async () => {
    const seen = await evidence(member);
    expect(seen).toEqual({
      groups: [],
      meta: { groups: { fetched: 0, total: 0, truncated: false } },
    });
  });

  it('shows the owner, a participant, its graph (control)', async () => {
    const seen = await evidence(owner);
    expect(seen.groups).toHaveLength(1);
    expect(JSON.stringify(seen)).toContain(`graph-canary-${run}`);
  });
});

describe('the write routes answer a non-participant as for a key nobody has used', () => {
  const unused = `chat:conversation-unused-${run}`;
  const count = async (sql: string, params: unknown[]) =>
    Number((await db.query<{ n: string }>(sql, params)).rows[0].n);
  const messagesIn = (key: string) =>
    count('SELECT count(*) AS n FROM inbox_thread_messages WHERE thread_id = $1', [
      threadIdByKey.get(key),
    ]);

  it("reply: a member gets the missing-thread answer for the owner's 1:1, before `wake` reads its members", async () => {
    const before = await messagesIn(keys.ownerChat);
    const body = { content: 'hello there', wake: ['nobody'] };
    const missing = await call(member, 'post', '/threads/reply', {
      body: { ...body, key: unused },
    });
    const hidden = await call(member, 'post', '/threads/reply', {
      body: { ...body, key: keys.ownerChat },
    });
    expect(missing).toEqual({ status: 404, body: { error: `No thread with key "${unused}"` } });
    expect(hidden).toEqual({
      status: 404,
      body: { error: `No thread with key "${keys.ownerChat}"` },
    });
    expect(await messagesIn(keys.ownerChat)).toBe(before);
  });

  it("reopen: neither the space owner nor an admin recovers a member's closed 1:1, or learns its status", async () => {
    const threadId = threadIdByKey.get(keys.memberChat);
    await db.query(
      `UPDATE inbox_threads SET status = 'closed', closed_at = now(), closed_by_kind = 'user',
       closed_by_user_id = $2 WHERE id = $1`,
      [threadId, member.userId]
    );
    try {
      for (const who of [owner, admin]) {
        expect(
          await call(who, 'post', '/threads/reopen', { body: { key: keys.memberChat } }),
          who.label
        ).toEqual({ status: 404, body: { error: `No thread with key "${keys.memberChat}"` } });
      }
      const { rows } = await db.query<{ status: string }>(
        'SELECT status FROM inbox_threads WHERE id = $1',
        [threadId]
      );
      expect(rows[0].status).toBe('closed');
      // The participant reopens it.
      const own = await call(member, 'post', '/threads/reopen', { body: { key: keys.memberChat } });
      expect(own.status).toBe(200);
      expect(own.body).toMatchObject({ success: true, reopened: true });
    } finally {
      await db.query(
        `UPDATE inbox_threads SET status = 'open', closed_at = NULL, closed_by_kind = NULL,
         closed_by_user_id = NULL WHERE id = $1`,
        [threadId]
      );
    }
  });

  it('reopen: an admin still recovers an ordinary thread they are not on (control)', async () => {
    const threadId = threadIdByKey.get(keys.open);
    await db.query(
      `UPDATE inbox_threads SET status = 'closed', closed_at = now(), closed_by_kind = 'user',
       closed_by_user_id = $2 WHERE id = $1`,
      [threadId, owner.userId]
    );
    const recovered = await call(admin, 'post', '/threads/reopen', { body: { key: keys.open } });
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({ success: true, reopened: true });
  });

  it("pin: a member gets the missing-thread answer for the owner's 1:1; the owner pins it", async () => {
    const hidden = await call(member, 'put', '/threads/pin', {
      body: { threadKey: keys.ownerChat, pinned: true },
    });
    expect(hidden.status).toBe(404);
    expect(hidden.body).toMatchObject({ code: 'thread_not_found' });
    const own = await call(owner, 'put', '/threads/pin', {
      body: { threadKey: keys.ownerChat, pinned: true },
    });
    expect(own).toEqual({ status: 200, body: { threadKey: keys.ownerChat, pinned: true } });
  });

  it("reactions: a member gets the missing-thread answer for the owner's 1:1, whatever the message id", async () => {
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM inbox_thread_messages WHERE thread_id = $1 LIMIT 1',
      [threadIdByKey.get(keys.ownerChat)]
    );
    for (const messageId of [rows[0].id, randomUUID()]) {
      const hidden = await call(member, 'post', '/threads/reactions', {
        body: { threadKey: keys.ownerChat, messageId, emoji: '👍' },
      });
      expect(hidden.status, messageId).toBe(404);
      expect(hidden.body).toMatchObject({ code: 'thread_not_found' });
    }
  });
});

describe('the public conversation: joined by posting', () => {
  const messagesIn = async (key: string) =>
    Number(
      (
        await db.query<{ n: string }>(
          'SELECT count(*) AS n FROM inbox_thread_messages WHERE thread_id = $1',
          [threadIdByKey.get(key)]
        )
      ).rows[0].n
    );

  it('pin and react: an admin not yet in it is told so, not that the thread is missing', async () => {
    const pin = await call(admin, 'put', '/threads/pin', {
      body: { threadKey: keys.public, pinned: true },
    });
    expect(pin.body).toMatchObject({ code: 'background_thread' });
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM inbox_thread_messages WHERE thread_id = $1 LIMIT 1',
      [threadIdByKey.get(keys.public)]
    );
    const reaction = await call(admin, 'post', '/threads/reactions', {
      body: { threadKey: keys.public, messageId: rows[0].id, emoji: '👍' },
    });
    expect(reaction.status).toBe(403);
    expect(reaction.body.code).not.toBe('thread_not_found');
  });

  it('reopen: an admin not yet in it recovers it, as an ordinary thread', async () => {
    await db.query(
      `UPDATE inbox_threads SET status = 'closed', closed_at = now(), closed_by_kind = 'user',
       closed_by_user_id = $2 WHERE id = $1`,
      [threadIdByKey.get(keys.public), owner.userId]
    );
    const recovered = await call(admin, 'post', '/threads/reopen', { body: { key: keys.public } });
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({ success: true, reopened: true });
  });

  it('reply: a viewer reads it but cannot post', async () => {
    const before = await messagesIn(keys.public);
    const refused = await call(viewer, 'post', '/threads/reply', {
      body: { key: keys.public, content: 'may I?' },
    });
    expect(refused.status).toBe(403);
    expect(await messagesIn(keys.public)).toBe(before);
  });

  it('reply: an admin not in it posts, joins it, and the message wakes its inkling', async () => {
    const threadId = threadIdByKey.get(keys.public)!;
    vi.stubEnv('INKLING_OWNER_TEST_USER_IDS', '');
    vi.stubEnv('INKLING_OWNER_TEST_USER_ID', owner.userId);
    try {
      const posted = await call(admin, 'post', '/threads/reply', {
        body: { key: keys.public, content: `joining ${run}` },
      });
      expect(posted.status, JSON.stringify(posted.body)).toBe(200);
      const messageId = posted.body.messageId as string;
      const { rows: joined } = await db.query<{ user_id: string }>(
        'SELECT user_id FROM inbox_thread_participants WHERE thread_id = $1 AND user_id = $2',
        [threadId, admin.userId]
      );
      expect(joined).toHaveLength(1);
      const { rows: stored } = await db.query<{ sender_user_id: string; content: string }>(
        'SELECT sender_user_id, content FROM inbox_thread_messages WHERE id = $1',
        [messageId]
      );
      expect(stored).toEqual([{ sender_user_id: admin.userId, content: `joining ${run}` }]);
      // The turn gate's shared branch reads the stored message: it wakes the inkling.
      const { isOwnersOwnMessage } = await import('../services/inklings/inkling-turn-gate');
      const { getDataComposer } = await import('../data/composer');
      const supabase = (await getDataComposer()).getClient();
      expect(
        await isOwnersOwnMessage(supabase as never, {
          threadMessageId: messageId,
          inklingId: reedSbId,
          ownerUserId: owner.userId,
          workspaceId: spaceId,
        })
      ).toBe('yes');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('link views (artifact backlinks)', () => {
  let artifactId: string;
  const uri = `ink://specs/d3-fixture-${run}`;

  beforeAll(async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO artifacts (uri, title, content, artifact_type, user_id, workspace_id)
       VALUES ($1, 'Invented spec', 'Invented content.', 'spec', $2, $3) RETURNING id`,
      [uri, owner.userId, spaceId]
    );
    artifactId = rows[0].id;
    for (const key of [keys.ownerChat, keys.memberChat, keys.open, keys.public]) {
      await db.query(
        `INSERT INTO thread_links (workspace_id, source_thread_id, target_kind, target_artifact_id,
         relation, linked_by_kind, linked_by_user_id)
         VALUES ($1, $2, 'artifact', $3, 'relates', 'user', $4)`,
        [spaceId, threadIdByKey.get(key), artifactId, owner.userId]
      );
    }
  });

  afterAll(async () => {
    if (artifactId) await db.query('DELETE FROM artifacts WHERE id = $1', [artifactId]);
  });

  it("gives the space owner's full view every thread's link but a member's 1:1", async () => {
    const { artifactBacklinks, linkReaderForUser } = await import('../services/thread-links');
    const { getDataComposer } = await import('../data/composer');
    const supabase = (await getDataComposer()).getClient();
    const backlinks = await artifactBacklinks(
      supabase,
      {
        workspaceId: spaceId,
        callerUserId: owner.userId,
        reader: linkReaderForUser('owner', owner.userId),
      },
      { id: artifactId, uri }
    );
    expect('threads' in backlinks, JSON.stringify(backlinks)).toBe(true);
    const threadKeys = 'threads' in backlinks ? backlinks.threads.map((t) => t.threadKey) : [];
    expect(threadKeys.sort()).toEqual([keys.open, keys.ownerChat, keys.public].sort());
  });

  it("gives a full reader not in the public conversation its link, and neither 1:1's", async () => {
    // The owner's own SB, in no conversation here: the team's full view.
    const { artifactBacklinks } = await import('../services/thread-links');
    const { getDataComposer } = await import('../data/composer');
    const supabase = (await getDataComposer()).getClient();
    const backlinks = await artifactBacklinks(
      supabase,
      {
        workspaceId: spaceId,
        callerUserId: owner.userId,
        reader: { kind: 'full', principal: { kind: 'sb', sbId: ownersSbId } },
      },
      { id: artifactId, uri }
    );
    expect('threads' in backlinks, JSON.stringify(backlinks)).toBe(true);
    const threadKeys = 'threads' in backlinks ? backlinks.threads.map((t) => t.threadKey) : [];
    expect(threadKeys.sort()).toEqual([keys.open, keys.public].sort());
  });
});
