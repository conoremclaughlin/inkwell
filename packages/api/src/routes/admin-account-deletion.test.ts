/**
 * POST /account/deletion: a person asks, from inside the app, for their
 * account to be deleted (App Store Review Guideline 5.1.1(v);
 * ink://specs/account-deletion v6 §4).
 *
 * What's pinned here:
 *
 *  - an account that can't be deleted from the app is refused before
 *    anything is recorded: one that owns a space with other members (the
 *    spaces are listed), and an operator account;
 *  - otherwise the request is recorded once per account, with the sign-in it
 *    belongs to and a hash of its email, the worker is nudged, and the answer
 *    is "queued" with the first request's time;
 *  - an account not yet bound to its sign-in is bound by email, and refused
 *    when no sign-in has that email.
 *
 * What the worker does with the request is tested against a real database
 * (services/account-deletion/worker.integration.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createHash } from 'crypto';

const mockSupabaseFrom = vi.fn();
const mockListUsers = vi.fn();
const mockIneligibility = vi.fn();
const mockNudge = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      getUser: vi.fn(),
      admin: { listUsers: mockListUsers },
    },
    from: mockSupabaseFrom,
  })),
}));

vi.mock('../services/account-deletion/eligibility', () => ({
  deletionIneligibility: (...args: unknown[]) => mockIneligibility(...args),
}));
vi.mock('../services/account-deletion/runtime', () => ({
  nudgeDeletionWorker: () => mockNudge(),
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
}

function createRes(): MockResponse {
  const res: Record<string, unknown> = {
    _status: 200,
    _json: null,
    // A real response is an event emitter; the account lease listens for 'close'.
    once() {
      return this;
    },
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

const EMAIL = 'ada@example.com';
const AUTH_UID = 'auth-ada';
const sha = (email: string) => createHash('sha256').update(email, 'utf8').digest('hex');

/**
 * The two tables the route reads and writes. `existing` is a request already
 * on file; `account` is the users row; anything else touched is a failure.
 */
function mockTables({
  existing = null as unknown,
  account = { email: EMAIL, auth_uid: AUTH_UID } as unknown,
  recorded = { requested_at: '2026-10-07T20:00:00.000Z' } as unknown,
  upsertError = null as unknown,
  readError = null as unknown,
} = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const requests: Record<string, any> = {};
  requests.select = vi.fn(() => requests);
  requests.eq = vi.fn(() => requests);
  requests.maybeSingle = vi.fn(() => Promise.resolve({ data: existing, error: null }));
  requests.upsert = vi.fn(() => Promise.resolve({ error: upsertError }));
  requests.single = vi.fn(() => Promise.resolve({ data: recorded, error: readError }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const users: Record<string, any> = {};
  users.select = vi.fn(() => users);
  users.eq = vi.fn(() => users);
  users.is = vi.fn(() => users);
  users.update = vi.fn(() => users);
  users.single = vi.fn(() => Promise.resolve({ data: account, error: null }));
  users.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
  mockSupabaseFrom.mockImplementation((table: string) => {
    if (table === 'account_deletion_requests') return requests;
    if (table === 'users') return users;
    throw new Error(`Unexpected table ${table}`);
  });
  return { requests, users };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIneligibility.mockResolvedValue(null);
  mockNudge.mockResolvedValue(undefined);
});

describe('POST /account/deletion', () => {
  it('records the request with its sign-in and email hash, nudges the worker and answers queued', async () => {
    const { requests } = mockTables();
    const res = createRes();

    await requestDeletion(authedReq('ink-user-1'), res);

    expect(res._status).toBe(202);
    expect(res._json).toEqual({
      deletion: { status: 'queued', requestedAt: '2026-10-07T20:00:00.000Z' },
    });
    expect(requests.upsert).toHaveBeenCalledWith(
      { user_id: 'ink-user-1', auth_uid: AUTH_UID, email_sha256: sha(EMAIL) },
      { onConflict: 'user_id', ignoreDuplicates: true }
    );
    expect(mockIneligibility).toHaveBeenCalledWith(expect.anything(), 'ink-user-1');
    expect(mockNudge).toHaveBeenCalledTimes(1);
  });

  it('hashes the email trimmed and lowercased', async () => {
    const { requests } = mockTables({
      account: { email: '  Ada@Example.COM ', auth_uid: AUTH_UID },
    });
    await requestDeletion(authedReq(), createRes());
    expect(requests.upsert.mock.calls[0][0].email_sha256).toBe(sha(EMAIL));
  });

  it('refuses an account that owns a space with other members, listing the spaces, recording nothing', async () => {
    const { requests } = mockTables();
    mockIneligibility.mockResolvedValue({
      reason: 'owns-shared-space',
      spaces: [{ id: 'space-1', name: 'Book club', members: 2 }],
    });
    const res = createRes();

    await requestDeletion(authedReq(), res);

    expect(res._status).toBe(409);
    expect(res._json).toMatchObject({
      reason: 'owns-shared-space',
      spaces: [{ id: 'space-1', name: 'Book club', members: 2 }],
    });
    expect(requests.upsert).not.toHaveBeenCalled();
    expect(mockNudge).not.toHaveBeenCalled();
  });

  it('refuses an operator account, recording nothing', async () => {
    const { requests } = mockTables();
    mockIneligibility.mockResolvedValue({ reason: 'operator-account', detail: 'not an inkling' });
    const res = createRes();

    await requestDeletion(authedReq(), res);

    expect(res._status).toBe(409);
    expect(res._json).toMatchObject({ reason: 'operator-account' });
    expect(requests.upsert).not.toHaveBeenCalled();
  });

  it('answers a repeat with the first request, without asking again whether it may be deleted', async () => {
    const { requests } = mockTables({ existing: { requested_at: '2026-10-07T19:00:00.000Z' } });
    const res = createRes();

    await requestDeletion(authedReq(), res);

    expect(res._status).toBe(202);
    expect(mockIneligibility).not.toHaveBeenCalled();
    expect(requests.upsert).not.toHaveBeenCalled();
    expect(mockNudge).toHaveBeenCalledTimes(1);
  });

  it('binds an account not yet bound to its sign-in by email, then records it', async () => {
    const { requests, users } = mockTables({ account: { email: EMAIL, auth_uid: null } });
    users.select = vi.fn((cols: string) => {
      if (cols === 'auth_uid') {
        // The conditional bind's returned row.
        return Promise.resolve({ data: [{ auth_uid: 'auth-found' }], error: null });
      }
      return users;
    });
    mockListUsers.mockResolvedValue({
      data: {
        users: [
          { id: 'auth-other', email: 'bea@example.com' },
          { id: 'auth-found', email: EMAIL },
        ],
      },
      error: null,
    });
    const res = createRes();

    await requestDeletion(authedReq(), res);

    expect(res._status).toBe(202);
    expect(users.update).toHaveBeenCalledWith({ auth_uid: 'auth-found' });
    expect(users.is).toHaveBeenCalledWith('auth_uid', null);
    expect(requests.upsert.mock.calls[0][0].auth_uid).toBe('auth-found');
  });

  it('refuses when no sign-in has the account’s email', async () => {
    const { requests } = mockTables({ account: { email: EMAIL, auth_uid: null } });
    mockListUsers.mockResolvedValue({ data: { users: [] }, error: null });
    const res = createRes();

    await requestDeletion(authedReq(), res);

    expect(res._status).toBe(409);
    expect(res._json).toMatchObject({ reason: 'sign-in-unknown' });
    expect(requests.upsert).not.toHaveBeenCalled();
  });

  it('fails, showing no deletion, when the write or the read-back fails', async () => {
    for (const failure of [
      { upsertError: { message: 'write failed' } },
      { readError: { message: 'read failed' } },
      { recorded: null },
    ]) {
      mockTables(failure);
      const res = createRes();
      await requestDeletion(authedReq(), res);
      expect(res._status).toBe(500);
      expect(res._json).not.toHaveProperty('deletion');
    }
  });
});
