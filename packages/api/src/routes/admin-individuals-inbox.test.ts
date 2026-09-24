/**
 * GET /individuals/:sbSlug/inbox — the group-thread section since the
 * cutover (spec inkmail-thread-scope §3, §5). Threads are found by the
 * agent's identities and the viewer's workspace, never by slug or owner;
 * every author is named for the viewer; a failed read is reported, not
 * swallowed. The legacy agent_inbox half of the route is left empty here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../mcp/tools/inbox-handlers', () => ({ handleSendToInbox: vi.fn() }));
vi.mock('../mcp/tools/thread-handlers', () => ({ getParticipants: vi.fn() }));
vi.mock('../auth/ink-tokens', () => ({
  signInkAccessToken: vi.fn(),
  createRefreshToken: vi.fn(),
  exchangeRefreshToken: vi.fn(),
  verifyInkAccessToken: vi.fn(),
}));

type Row = Record<string, unknown>;
const tables = vi.hoisted(() => ({
  rows: {} as Record<string, Row[]>,
  /** Every filter applied, per table, in order: [table, method, column, value]. */
  filters: [] as Array<[string, string, string, unknown]>,
  failing: null as string | null,
}));

function chainFor(table: string) {
  const all = tables.rows[table] ?? [];
  const preds: Array<(r: Row) => boolean> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q: any = {};
  for (const m of ['select', 'order', 'limit', 'is']) q[m] = () => q;
  q.eq = (col: string, val: unknown) => {
    tables.filters.push([table, 'eq', col, val]);
    preds.push((r) => r[col] === val);
    return q;
  };
  q.in = (col: string, vals: unknown[]) => {
    tables.filters.push([table, 'in', col, vals]);
    preds.push((r) => vals.includes(r[col]));
    return q;
  };
  q.not = (col: string, _op: string, val: unknown) => {
    preds.push((r) => r[col] !== val);
    return q;
  };
  const result = () =>
    tables.failing === table
      ? { data: null, error: { message: `${table} read failed` }, count: 0 }
      : (() => {
          const data = all.filter((r) => preds.every((p) => p(r)));
          return { data, error: null, count: data.length };
        })();
  q.maybeSingle = async () => ({ ...result(), data: result().data?.[0] ?? null });
  q.single = q.maybeSingle;
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
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
const logged = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: logged.warn, error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/request-context', () => ({
  runWithRequestContext: (_context: Record<string, unknown>, fn: () => void) => fn(),
}));

import router from './admin';

type Handler = (req: Request, res: Response) => Promise<void>;
function getInboxHandler(): Handler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (entry: any) => entry.route?.path === '/individuals/:sbSlug/inbox' && entry.route?.methods?.get
  );
  if (!layer) throw new Error('GET /individuals/:sbSlug/inbox not found in router stack');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createReq(viewerUserId: string): Request {
  return {
    params: { sbSlug: 'wren' },
    query: {},
    headers: {},
    cookies: {},
    inkUserId: viewerUserId,
    inkWorkspaceId: 'ws-1',
    inkWorkspaceRole: 'member',
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
const inbox = getInboxHandler();

interface GroupThreadOut {
  threadKey: string;
  participants: string[];
  people: Array<{ userId: string; name: string; isOwn: boolean }>;
  unreadCount: number;
  messages: Array<{ senderKind: string; senderName: string; isOwn: boolean; status: string }>;
}
async function readAs(viewerUserId: string) {
  const res = createRes();
  await inbox(createReq(viewerUserId), res);
  expect(res._status).toBe(200);
  return res._json as {
    groupThreads: GroupThreadOut[];
    stats: {
      groupThreadCount: number;
      groupThreadsUnavailable: boolean;
      threadUnreadCount: number;
    };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  tables.filters = [];
  tables.failing = null;
  tables.rows = {
    agent_identities: [
      { id: 'sb-wren', agent_id: 'wren', user_id: 'user-a', workspace_id: 'ws-1' },
      { id: 'sb-lumen', agent_id: 'lumen', user_id: 'user-a', workspace_id: 'ws-1' },
      // Same slug in another workspace: never in scope here.
      { id: 'sb-wren-other', agent_id: 'wren', user_id: 'user-a', workspace_id: 'ws-2' },
    ],
    agent_inbox: [],
    inbox_thread_participants: [
      { thread_id: 't1', sb_id: 'sb-wren', user_id: null, principal_key: 'sb:sb-wren' },
      { thread_id: 't1', sb_id: 'sb-lumen', user_id: null, principal_key: 'sb:sb-lumen' },
      { thread_id: 't1', sb_id: null, user_id: 'user-a', principal_key: 'user:user-a' },
      { thread_id: 't1', sb_id: null, user_id: 'user-b', principal_key: 'user:user-b' },
      // A thread wren's OTHER-workspace identity is on: out of scope.
      { thread_id: 't2', sb_id: 'sb-wren-other', user_id: null, principal_key: 'sb:sb-wren-other' },
    ],
    inbox_threads: [
      {
        id: 't1',
        thread_key: 'pr:621',
        title: 'release',
        status: 'open',
        workspace_id: 'ws-1',
        updated_at: '2026-09-13T00:05:00Z',
      },
      {
        id: 't2',
        thread_key: 'pr:9',
        title: null,
        status: 'open',
        workspace_id: 'ws-2',
        updated_at: '2026-09-13T00:05:00Z',
      },
    ],
    inbox_thread_read_status: [
      { thread_id: 't1', sb_id: 'sb-wren', last_read_at: '2026-09-13T00:02:00Z' },
    ],
    inbox_thread_messages: [
      {
        id: 'm1',
        thread_id: 't1',
        sender_kind: 'sb',
        sender_sb_id: 'sb-lumen',
        sender_user_id: null,
        sender_agent_id: 'lumen',
        content: 'hi',
        message_type: 'message',
        priority: 'normal',
        metadata: null,
        created_at: '2026-09-13T00:01:00Z',
      },
      {
        id: 'm2',
        thread_id: 't1',
        sender_kind: 'user',
        sender_sb_id: null,
        sender_user_id: 'user-a',
        sender_agent_id: null,
        content: 'from a',
        message_type: 'message',
        priority: 'normal',
        metadata: null,
        created_at: '2026-09-13T00:02:00Z',
      },
      {
        id: 'm3',
        thread_id: 't1',
        sender_kind: 'user',
        sender_sb_id: null,
        sender_user_id: 'user-b',
        sender_agent_id: null,
        content: 'from b',
        message_type: 'message',
        priority: 'normal',
        metadata: null,
        created_at: '2026-09-13T00:03:00Z',
      },
      {
        id: 'm4',
        thread_id: 't1',
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
    ],
    users: [
      { id: 'user-a', first_name: 'Conor', last_name: null, username: null, email: null },
      { id: 'user-b', first_name: null, last_name: null, username: 'second', email: null },
    ],
  };
});

describe('GET /individuals/:sbSlug/inbox — group threads since the cutover', () => {
  it("finds threads by the agent's identities in the viewer's workspace, never by slug or owner", async () => {
    const out = await readAs('user-a');
    expect(out.groupThreads.map((t) => t.threadKey)).toEqual(['pr:621']);
    // Participants by identity, threads by workspace, pointers by identity.
    expect(tables.filters).toContainEqual([
      'inbox_thread_participants',
      'in',
      'sb_id',
      ['sb-wren'],
    ]);
    expect(tables.filters).toContainEqual(['inbox_threads', 'eq', 'workspace_id', 'ws-1']);
    expect(tables.filters).toContainEqual(['inbox_thread_read_status', 'in', 'sb_id', ['sb-wren']]);
    const legacy = tables.filters.filter(
      ([table, , col]) =>
        table.startsWith('inbox_thread') && (col === 'agent_id' || col === 'user_id')
    );
    expect(legacy).toEqual([]);
  });

  it('names SB participants by slug, people for the viewer, and every author with isOwn', async () => {
    const [t] = (await readAs('user-a')).groupThreads;
    // The mock does not sort; the database orders by principal_key.
    expect([...t.participants].sort()).toEqual(['lumen', 'wren']);
    expect(t.people).toEqual([
      { userId: 'user-a', name: 'Conor', isOwn: true },
      { userId: 'user-b', name: 'second', isOwn: false },
    ]);
    expect(t.messages.map((m) => [m.senderKind, m.senderName, m.isOwn])).toEqual([
      ['sb', 'lumen', false],
      ['user', 'Conor', true],
      ['user', 'second', false],
      ['system', 'system', false],
    ]);

    // The other person cannot read this inbox at all: the route scopes the
    // agent's identities to the viewer's own (pre-existing rule, unchanged
    // here). The isOwn flip for a second viewer is pinned on /threads/messages.
  });

  it("unread is counted from the identity's read pointer", async () => {
    const out = await readAs('user-a');
    const [t] = out.groupThreads;
    expect(t.messages.map((m) => m.status)).toEqual(['read', 'read', 'unread', 'unread']);
    expect(t.unreadCount).toBe(2);
    expect(out.stats.threadUnreadCount).toBe(2);
  });

  it('a failed thread read is reported in the log and the response, not swallowed', async () => {
    tables.failing = 'inbox_thread_read_status';
    const out = await readAs('user-a');
    expect(out.groupThreads).toEqual([]);
    expect(out.stats.groupThreadsUnavailable).toBe(true);
    expect(logged.warn).toHaveBeenCalledWith(
      expect.stringContaining('Group threads unavailable'),
      expect.objectContaining({ error: 'inbox_thread_read_status read failed' })
    );
  });
});
