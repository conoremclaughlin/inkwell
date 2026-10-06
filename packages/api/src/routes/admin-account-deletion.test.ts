/**
 * POST /account/deletion: a person asks, from inside the app, for their
 * account to be deleted (App Store Review Guideline 5.1.1(v)).
 *
 * What's pinned here:
 *
 *  - the request is recorded once per account, by the authenticated user's
 *    id, and asking again answers with the first request's time;
 *  - recording is all it does: no session is ended, no cookie cleared and no
 *    other table touched. Fulfilling the request is a separate step.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mockSupabaseFrom = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { signInWithPassword: vi.fn(), signUp: vi.fn(), getUser: vi.fn() },
    from: mockSupabaseFrom,
  })),
}));

vi.mock('../auth/ink-tokens', () => ({
  signInkAccessToken: vi.fn(),
  createRefreshToken: vi.fn(),
  exchangeRefreshToken: vi.fn(),
  verifyInkAccessToken: vi.fn(),
}));
vi.mock('../data/composer', () => ({
  getDataComposer: vi.fn(async () => ({ repositories: {}, getClient: vi.fn() })),
}));
vi.mock('../services/authorization', () => ({ getAuthorizationService: vi.fn(() => ({})) }));
vi.mock('../services/oauth', () => ({ getOAuthService: vi.fn(() => ({})) }));
vi.mock('../mcp/tools/inbox-handlers', () => ({ handleSendToInbox: vi.fn() }));
vi.mock('../mcp/tools/thread-handlers', () => ({ getParticipants: vi.fn() }));
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

function getRouteHandler(method: 'post', path: string): Handler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const requestDeletion = getRouteHandler('post', '/account/deletion');

/** An authenticated request, as adminAuthMiddleware leaves it. */
function authedReq(userId = 'ink-user-1'): Request {
  return {
    body: {},
    headers: {},
    cookies: {},
    inkUserId: userId,
    inkWorkspaceId: 'workspace-1',
    inkWorkspaceRole: 'owner',
  } as unknown as Request;
}

interface MockResponse extends Response {
  _status: number;
  _json: unknown;
  _cleared: string[];
}

function createRes(): MockResponse {
  const res: Record<string, unknown> = {
    _status: 200,
    _json: null,
    _cleared: [],
    status(code: number) {
      res._status = code;
      return res;
    },
    json(payload: unknown) {
      res._json = payload;
      return res;
    },
    clearCookie(name: string) {
      (res._cleared as string[]).push(name);
      return res;
    },
  };
  return res as unknown as MockResponse;
}

/** The requests table's chain; any other table is a failure. */
function mockRequests({
  recorded = { requested_at: '2026-10-05T08:00:00.000Z', completed_at: null } as unknown,
  upsertError = null as unknown,
  readError = null as unknown,
} = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const requests: Record<string, any> = {};
  requests.upsert = vi.fn(() => Promise.resolve({ error: upsertError }));
  requests.select = vi.fn(() => requests);
  requests.eq = vi.fn(() => requests);
  requests.single = vi.fn(() => Promise.resolve({ data: recorded, error: readError }));
  mockSupabaseFrom.mockImplementation((table: string) => {
    if (table === 'account_deletion_requests') return requests;
    throw new Error(`Unexpected table ${table}`);
  });
  return requests;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /account/deletion', () => {
  it('records the request by user id and answers with its status and time', async () => {
    const requests = mockRequests();
    const res = createRes();

    await requestDeletion(authedReq('ink-user-1'), res);

    expect(res._status).toBe(202);
    expect(res._json).toEqual({
      deletion: { status: 'pending', requestedAt: '2026-10-05T08:00:00.000Z' },
    });
    expect(requests.upsert).toHaveBeenCalledWith(
      { user_id: 'ink-user-1' },
      { onConflict: 'user_id', ignoreDuplicates: true }
    );
    expect(requests.eq).toHaveBeenCalledWith('user_id', 'ink-user-1');
  });

  it('only records: no session ended, no cookie cleared, no other table touched', async () => {
    mockRequests();
    const res = createRes();

    await requestDeletion(authedReq(), res);

    expect(res._status).toBe(202);
    expect(res._cleared).toEqual([]);
    const tables = mockSupabaseFrom.mock.calls.map(([table]) => table);
    expect(new Set(tables)).toEqual(new Set(['account_deletion_requests']));
  });

  it('answers a repeat with the first request, and a fulfilled one as completed', async () => {
    mockRequests({
      recorded: {
        requested_at: '2026-10-01T08:00:00.000Z',
        completed_at: '2026-10-03T08:00:00.000Z',
      },
    });
    const res = createRes();

    await requestDeletion(authedReq(), res);

    expect(res._status).toBe(202);
    expect(res._json).toEqual({
      deletion: { status: 'completed', requestedAt: '2026-10-01T08:00:00.000Z' },
    });
  });

  it('fails, recording nothing it can show, when the write or the read-back fails', async () => {
    for (const failure of [
      { upsertError: { message: 'write failed' } },
      { readError: { message: 'read failed' } },
      { recorded: null },
    ]) {
      mockRequests(failure);
      const res = createRes();
      await requestDeletion(authedReq(), res);
      expect(res._status).toBe(500);
      expect(res._json).not.toHaveProperty('deletion');
    }
  });
});
