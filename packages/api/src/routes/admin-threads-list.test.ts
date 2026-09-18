/**
 * GET /threads — the browse feed the phone and the dashboard both read.
 *
 * This tier exists for the WIRING, not the merge rules (those are pinned in
 * services/thread-key/thread-spines.test.ts against the pure function). The
 * failure it is here to catch is silent: if the route stops selecting a
 * column or stops passing it into the merge, every spine still returns 200
 * with a well-formed body and the field is simply `undefined` — which reads
 * as "no summary anywhere" and "nothing is ever live". Nothing throws, no
 * type complains at the boundary, and both clients quietly show less.
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

// The slug registry is a DB read of its own; identity parsing is not what
// this file measures, so it returns an empty lookup rather than being stubbed
// out entirely (a throw here would disable provisional identities silently).
vi.mock('../services/thread-key/thread-key.service', () => ({
  ThreadKeyService: class {
    async projectSlugLookup() {
      return new Set<string>();
    }
  },
}));

const mockSupabaseFrom = vi.fn();
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ auth: {}, from: mockSupabaseFrom })),
}));

const mockGetClient = vi.fn(() => ({ from: mockSupabaseFrom }));
vi.mock('../data/composer', () => ({
  getDataComposer: vi.fn(async () => ({ repositories: {}, getClient: mockGetClient })),
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

vi.mock('../utils/request-context', () => ({
  runWithRequestContext: (_context: Record<string, unknown>, fn: () => void) => fn(),
}));

import router from './admin';

type Handler = (req: Request, res: Response) => Promise<void>;

function getListHandler(): Handler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === '/threads' && entry.route?.methods?.get
  );
  if (!layer) throw new Error('GET /threads not found in router stack');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

interface MockResponse extends Response {
  _status: number;
  _json: unknown;
}

function createRes(): MockResponse {
  const res: Record<string, unknown> = {
    _status: 200,
    _json: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(payload: unknown) {
      res._json = payload;
      return res;
    },
  };
  return res as unknown as MockResponse;
}

/**
 * A PostgREST-shaped chain: every builder method returns itself and the whole
 * thing is awaitable, so it satisfies each query's own sequence of calls
 * (.eq/.or/.not/.neq/.order/.limit/.in/.range) without this test having to
 * model which one ends the chain.
 *
 * `select` PROJECTS, which is the point. A fake that hands back whole rows
 * whatever was asked for cannot fail when the route stops selecting a column
 * — and dropping a column from a SELECT list is the likeliest way to break
 * this route, since the list is written out twice. Verified by mutation: with
 * projection, removing `summary` from either SELECT turns this file red;
 * without it, both mutants survived.
 */
function projector(columns: string): (row: Record<string, unknown>) => Record<string, unknown> {
  const names = columns
    .split(',')
    .map((c) => c.trim())
    // Embedded resources ("inbox_threads!inner(user_id)") are a join spec, not
    // a column of this row; the route never reads them off the row itself.
    .filter((c) => c.length > 0 && !c.includes('(') && !c.includes('!'));
  return (row) => Object.fromEntries(names.filter((n) => n in row).map((n) => [n, row[n]]));
}

function table(rows: Array<Record<string, unknown>>) {
  let project: (row: Record<string, unknown>) => Record<string, unknown> = (row) => row;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows.map(project), count: rows.length, error: null }).then(resolve),
  };
  chain.select = vi.fn((columns?: string) => {
    if (typeof columns === 'string') project = projector(columns);
    return chain;
  });
  for (const method of ['eq', 'or', 'not', 'neq', 'order', 'limit', 'in', 'range']) {
    chain[method] = vi.fn(() => chain);
  }
  return chain;
}

const MINUTE = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE).toISOString();

interface Spine {
  key: string;
  thread: { title: string | null; summary: string | null } | null;
  sessions: Array<{ id: string; sbSlug: string | null; live: boolean }>;
}

const list = getListHandler();

beforeEach(() => {
  vi.clearAllMocks();
  mockGetClient.mockReturnValue({ from: mockSupabaseFrom });
});

function respondWith(tables: Record<string, Array<Record<string, unknown>>>) {
  mockSupabaseFrom.mockImplementation((name: string) => table(tables[name] ?? []));
}

async function listSpines(
  tables: Record<string, Array<Record<string, unknown>>>
): Promise<Spine[]> {
  respondWith(tables);
  const res = createRes();
  await list(
    { headers: {}, cookies: {}, params: {}, query: {}, pcpUserId: 'user-1' } as unknown as Request,
    res
  );
  expect(res._status).toBe(200);
  return (res._json as { spines: Spine[] }).spines;
}

const threadRow = (over: Record<string, unknown> = {}) => ({
  id: 'thread-1',
  thread_key: 'pcp:pr:632',
  key_project: 'pcp',
  key_type: 'pr',
  key_id: '632',
  title: 'Rotating refresh grants',
  summary: 'Grants rotate, slide on use, and expire for real.',
  status: 'open',
  created_by_agent_id: 'wren',
  updated_at: ago(3),
  closed_at: null,
  ...over,
});

const sessionRow = (over: Record<string, unknown> = {}) => ({
  id: 'session-1',
  agent_id: 'wren',
  lifecycle: 'running',
  status: 'active',
  current_phase: 'implementing',
  thread_key: 'pcp:pr:632',
  active_thread_key: null,
  updated_at: ago(2),
  studio_id: 'studio-1',
  ...over,
});

describe('GET /threads', () => {
  it('carries the thread summary through to the client', async () => {
    const [spine] = await listSpines({ inbox_threads: [threadRow()] });
    expect(spine.thread?.summary).toBe('Grants rotate, slide on use, and expire for real.');
    expect(spine.thread?.title).toBe('Rotating refresh grants');
  });

  it('answers liveness per session instead of leaving the client to guess', async () => {
    const spines = await listSpines({
      inbox_threads: [threadRow(), threadRow({ id: 'thread-2', thread_key: 'pcp:pr:1' })],
      sessions: [
        sessionRow(),
        sessionRow({ id: 'session-2', thread_key: 'pcp:pr:1', updated_at: ago(60 * 24 * 30) }),
      ],
    });
    const liveByKey = Object.fromEntries(spines.map((s) => [s.key, s.sessions.map((x) => x.live)]));
    expect(liveByKey).toEqual({ 'pcp:pr:632': [true], 'pcp:pr:1': [false] });
  });

  /**
   * The shape that made the badge useless in production: a lifecycle stuck at
   * `running` on a session last written to months ago. Six of these on one
   * agent read as six live threads.
   */
  it('does not call a months-stale `running` session live', async () => {
    const [spine] = await listSpines({
      inbox_threads: [threadRow()],
      sessions: [sessionRow({ updated_at: '2026-03-03T19:04:25Z' })],
    });
    expect(spine.sessions[0].live).toBe(false);
  });

  it('believes a `complete` phase over a lifecycle nobody moved', async () => {
    const [spine] = await listSpines({
      inbox_threads: [threadRow()],
      sessions: [sessionRow({ current_phase: 'complete', updated_at: ago(0) })],
    });
    expect(spine.sessions[0].live).toBe(false);
  });
});
