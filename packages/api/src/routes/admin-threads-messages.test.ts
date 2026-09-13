/**
 * GET /threads/messages — the conversation as one viewer sees it.
 *
 * Every author is named on the server (spec inkmail-thread-scope §3): an SB
 * by its slug, a person by their profile, the system as system. Which person
 * is "You" is decided against the PCP user the request resolved to — never
 * left to a client that only knows its auth provider's id (Lumen, #620).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../mcp/tools/inbox-handlers', () => ({ handleSendToInbox: vi.fn() }));
vi.mock('../mcp/tools/thread-handlers', () => ({ getParticipants: vi.fn() }));
vi.mock('../auth/pcp-tokens', () => ({
  signPcpAccessToken: vi.fn(),
  createRefreshToken: vi.fn(),
  exchangeRefreshToken: vi.fn(),
  verifyPcpAccessToken: vi.fn(),
}));

const tables = vi.hoisted(() => ({
  thread: null as Record<string, unknown> | null,
  messages: [] as Array<Record<string, unknown>>,
  users: [] as Array<Record<string, unknown>>,
}));

// A chain that answers by table: rows from the fixtures above, empty
// elsewhere (studio history, identities), so the route runs end to end.
function chainFor(table: string) {
  const rows =
    table === 'inbox_thread_messages' ? tables.messages : table === 'users' ? tables.users : [];
  let filteredIds: unknown[] | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q: any = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'is', 'not']) q[m] = () => q;
  q.in = (_col: string, ids: unknown[]) => {
    filteredIds = ids;
    return q;
  };
  q.maybeSingle = async () => ({
    data: table === 'inbox_threads' ? tables.thread : null,
    error: null,
  });
  q.single = q.maybeSingle;
  q.then = (resolve: (v: unknown) => unknown) => {
    const data = filteredIds ? rows.filter((r) => filteredIds!.includes(r.id)) : rows;
    return Promise.resolve({ data, error: null, count: data.length }).then(resolve);
  };
  return q;
}
const mockSupabaseFrom = vi.fn((table: string) => chainFor(table));
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ auth: {}, from: mockSupabaseFrom })),
}));
vi.mock('../data/composer', () => ({
  getDataComposer: vi.fn(async () => ({
    repositories: {},
    getClient: () => ({ from: mockSupabaseFrom }),
  })),
}));
vi.mock('../services/authorization', () => ({ getAuthorizationService: vi.fn(() => ({})) }));
vi.mock('../services/oauth', () => ({ getOAuthService: vi.fn(() => ({})) }));
vi.mock('../config/env', () => ({
  env: {
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'test-secret',
    SUPABASE_PUBLISHABLE_KEY: 'test-publishable',
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-characters-long',
    NODE_ENV: 'development',
    MCP_HTTP_PORT: 3001,
  },
  isDevelopment: () => true,
}));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/request-context', () => ({
  runWithRequestContext: (_context: Record<string, unknown>, fn: () => void) => fn(),
}));

import router from './admin';

type Handler = (req: Request, res: Response) => Promise<void>;

function getMessagesHandler(): Handler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (entry: any) => entry.route?.path === '/threads/messages' && entry.route?.methods?.get
  );
  if (!layer) throw new Error('GET /threads/messages not found in router stack');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createReq(viewerUserId: string): Request {
  return {
    query: { key: 'pr:620' },
    headers: {},
    cookies: {},
    params: {},
    pcpUserId: viewerUserId,
    pcpWorkspaceId: 'ws-1',
    pcpWorkspaceRole: 'member',
  } as unknown as Request;
}

interface MockResponse extends Response {
  _status: number;
  _json: unknown;
}
function createRes(): MockResponse {
  const res: Record<string, unknown> = { _status: 200, _json: null };
  res.status = (code: number) => {
    res._status = code;
    return res;
  };
  res.json = (payload: unknown) => {
    res._json = payload;
    return res;
  };
  return res as unknown as MockResponse;
}

const messages = getMessagesHandler();

type Named = { senderKind: string; senderName: string; isOwn: boolean };
async function readAs(viewerUserId: string) {
  const res = createRes();
  await messages(createReq(viewerUserId), res);
  expect(res._status).toBe(200);
  const body = res._json as { viewerUserId: string; messages: Named[] };
  return {
    viewerUserId: body.viewerUserId,
    senders: body.messages.map((m) => [m.senderKind, m.senderName, m.isOwn]),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  tables.thread = {
    id: 'thread-1',
    thread_key: 'pr:620',
    title: null,
    status: 'open',
    created_by_kind: 'user',
    created_by_sb_id: null,
    created_by_user_id: 'user-a',
    created_at: '2026-09-13T00:00:00Z',
    closed_at: null,
  };
  // Stored newest-first, as the route fetches them; served oldest-first.
  tables.messages = [
    {
      id: 'm4',
      sender_kind: 'system',
      sender_sb_id: null,
      sender_user_id: null,
      sender_agent_id: null,
      content: 'closed',
      message_type: 'system',
      priority: 'normal',
      metadata: null,
      created_at: '2026-09-13T00:04:00Z',
    },
    {
      id: 'm3',
      sender_kind: 'user',
      sender_sb_id: null,
      sender_user_id: 'user-b',
      sender_agent_id: null,
      content: 'second human',
      message_type: 'message',
      priority: 'normal',
      metadata: null,
      created_at: '2026-09-13T00:03:00Z',
    },
    {
      id: 'm2',
      sender_kind: 'user',
      sender_sb_id: null,
      sender_user_id: 'user-a',
      sender_agent_id: null,
      content: 'first human',
      message_type: 'message',
      priority: 'normal',
      metadata: null,
      created_at: '2026-09-13T00:02:00Z',
    },
    {
      id: 'm1',
      sender_kind: 'sb',
      sender_sb_id: 'sb-1',
      sender_user_id: null,
      sender_agent_id: 'wren',
      content: 'hi',
      message_type: 'message',
      priority: 'normal',
      metadata: null,
      created_at: '2026-09-13T00:01:00Z',
    },
  ];
  tables.users = [
    { id: 'user-a', first_name: 'Conor', last_name: null, username: null, email: 'c@x' },
    { id: 'user-b', first_name: null, last_name: null, username: 'second', email: null },
  ];
});

describe('GET /threads/messages names every author for the viewer', () => {
  it('two people read the same two human messages differently: each is own only to themselves', async () => {
    const asA = await readAs('user-a');
    expect(asA.viewerUserId).toBe('user-a');
    expect(asA.senders).toEqual([
      ['sb', 'wren', false],
      ['user', 'Conor', true],
      ['user', 'second', false],
      ['system', 'system', false],
    ]);

    const asB = await readAs('user-b');
    expect(asB.viewerUserId).toBe('user-b');
    expect(asB.senders).toEqual([
      ['sb', 'wren', false],
      ['user', 'Conor', false],
      ['user', 'second', true],
      ['system', 'system', false],
    ]);
  });

  it('a person with no profile row is still a person, named anonymously and never own to a stranger', async () => {
    tables.users = [];
    const asC = await readAs('user-c');
    expect(asC.senders).toEqual([
      ['sb', 'wren', false],
      ['user', 'a workspace member', false],
      ['user', 'a workspace member', false],
      ['system', 'system', false],
    ]);
  });

  it('resolves names in one batch, only for the people who wrote something', async () => {
    await readAs('user-a');
    const userQueries = mockSupabaseFrom.mock.calls.filter(([t]) => t === 'users');
    expect(userQueries).toHaveLength(1);
  });
});
