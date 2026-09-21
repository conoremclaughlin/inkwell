/**
 * POST /threads/reopen — the owner's recovery path over HTTP (spec
 * inkmail-thread-scope §2, §6).
 *
 * The route is a thin adapter over reopenThreadRow, so what is pinned is
 * the adaptation: the thread is looked up under the caller's own user (the
 * pre-cutover meaning of "owner"), an unknown key is a 404 rather than an
 * invented thread, an already-open thread is answered without a write, and
 * a reopen that lost a race is reported as alreadyOpen rather than as a
 * failure — the state the person asked for holds either way.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mockReopenThreadRow = vi.fn();

vi.mock('../mcp/tools/inbox-handlers', () => ({
  handleSendToInbox: vi.fn(),
}));
vi.mock('../mcp/tools/thread-handlers', () => ({
  getParticipants: vi.fn(),
  reopenThreadRow: (...args: unknown[]) => mockReopenThreadRow(...args),
}));

vi.mock('../auth/ink-tokens', () => ({
  signInkAccessToken: vi.fn(),
  createRefreshToken: vi.fn(),
  exchangeRefreshToken: vi.fn(),
  verifyInkAccessToken: vi.fn(),
}));

const mockSupabaseFrom = vi.fn();
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ auth: {}, from: mockSupabaseFrom })),
}));

const composerClient = { from: mockSupabaseFrom };
const mockGetClient = vi.fn(() => composerClient);
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

function getReopenHandler(): Handler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === '/threads/reopen' && entry.route?.methods?.post
  );
  if (!layer) throw new Error('POST /threads/reopen not found in router stack');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createReq(body: Record<string, unknown>): Request {
  return { body, headers: {}, cookies: {}, params: {}, inkUserId: 'user-1' } as unknown as Request;
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

/** inbox_threads chain: select().eq().eq().maybeSingle() → thread row; records the eq filters. */
function mockThreadLookup(thread: Record<string, unknown> | null) {
  const eqCalls: Array<[string, unknown]> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: Record<string, any> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn((col: string, val: unknown) => {
    eqCalls.push([col, val]);
    return chain;
  });
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data: thread, error: null }));
  mockSupabaseFrom.mockImplementation(() => chain);
  return { chain, eqCalls };
}

const reopen = getReopenHandler();

beforeEach(() => {
  vi.clearAllMocks();
  mockGetClient.mockReturnValue(composerClient);
});

describe('POST /threads/reopen', () => {
  it('rejects a missing key', async () => {
    const res = createRes();
    await reopen(createReq({}), res);
    expect(res._status).toBe(400);
    expect(mockReopenThreadRow).not.toHaveBeenCalled();
  });

  it('404s on a thread key that does not exist — no silent thread creation', async () => {
    mockThreadLookup(null);
    const res = createRes();
    await reopen(createReq({ key: 'pr:99999' }), res);
    expect(res._status).toBe(404);
    expect(mockReopenThreadRow).not.toHaveBeenCalled();
  });

  it("looks the thread up under the caller's own user and reopens it as the owner", async () => {
    const { eqCalls } = mockThreadLookup({
      id: 'thread-1',
      thread_key: 'pr:545',
      status: 'closed',
    });
    mockReopenThreadRow.mockResolvedValue({ reopened: true });

    const res = createRes();
    await reopen(createReq({ key: '  pr:545 ' }), res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      success: true,
      threadKey: 'pr:545',
      reopened: true,
      alreadyOpen: false,
    });
    expect(eqCalls).toEqual([
      ['user_id', 'user-1'],
      ['thread_key', 'pr:545'],
    ]);
    expect(mockReopenThreadRow).toHaveBeenCalledTimes(1);
    expect(mockReopenThreadRow).toHaveBeenCalledWith(composerClient, 'thread-1', {
      kind: 'user',
    });
  });

  it('answers an already-open thread without writing anything', async () => {
    mockThreadLookup({ id: 'thread-1', thread_key: 'pr:545', status: 'open' });
    const res = createRes();
    await reopen(createReq({ key: 'pr:545' }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      success: true,
      threadKey: 'pr:545',
      reopened: false,
      alreadyOpen: true,
    });
    expect(mockReopenThreadRow).not.toHaveBeenCalled();
  });

  it('reports a reopen that lost the race as alreadyOpen, not as a failure', async () => {
    mockThreadLookup({ id: 'thread-1', thread_key: 'pr:545', status: 'closed' });
    mockReopenThreadRow.mockResolvedValue({ reopened: false });
    const res = createRes();
    await reopen(createReq({ key: 'pr:545' }), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ success: true, reopened: false, alreadyOpen: true });
  });

  it('surfaces a write failure instead of claiming success', async () => {
    mockThreadLookup({ id: 'thread-1', thread_key: 'pr:545', status: 'closed' });
    mockReopenThreadRow.mockRejectedValue(new Error('update failed'));
    const res = createRes();
    await reopen(createReq({ key: 'pr:545' }), res);
    expect(res._status).toBe(500);
  });
});
