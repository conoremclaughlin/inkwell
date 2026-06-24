/**
 * Admin approval-requests endpoint tests
 *
 * Covers POST /api/admin/approval-requests (create) and
 * GET /api/admin/approval-requests/:requestId/status (poll).
 *
 * Ownership and auto-expiry behavior matter here — the hook is a security
 * gate, so the server must refuse to return other users' requests and must
 * flip past-deadline pending rows to 'expired'.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockVerifyPcpAccessToken = vi.fn();
const mockExchangeRefreshToken = vi.fn();
const mockSignPcpAccessToken = vi.fn();
const mockCreateRefreshToken = vi.fn();

vi.mock('../auth/pcp-tokens', () => ({
  verifyPcpAccessToken: (...args: unknown[]) => mockVerifyPcpAccessToken(...args),
  exchangeRefreshToken: (...args: unknown[]) => mockExchangeRefreshToken(...args),
  signPcpAccessToken: (...args: unknown[]) => mockSignPcpAccessToken(...args),
  createRefreshToken: (...args: unknown[]) => mockCreateRefreshToken(...args),
}));

const mockSupabaseFrom = vi.fn();
const mockGetUser = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
  })),
}));

const mockNotifyPlatform = vi.fn().mockResolvedValue(undefined);
vi.mock('../channels/approval-interceptor', () => ({
  notifyPlatformOfApprovalRequest: (...args: unknown[]) => mockNotifyPlatform(...args),
}));

vi.mock('../data/composer', () => ({
  getDataComposer: vi.fn(async () => ({
    repositories: {
      workspaces: {
        findById: vi.fn(),
        findRawById: vi.fn(),
        ensurePersonalWorkspace: vi.fn().mockResolvedValue({ id: 'ws-1' }),
        listMembershipsByUser: vi.fn().mockResolvedValue([]),
      },
    },
  })),
}));

vi.mock('../config/env', () => ({
  env: {
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'test-secret',
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-characters-long',
    NODE_ENV: 'development',
    MCP_HTTP_PORT: 3001,
  },
  isDevelopment: () => false,
  isProduction: () => false,
  isTest: () => true,
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/request-context', () => ({
  runWithRequestContext: (_ctx: Record<string, unknown>, fn: () => void) => {
    fn();
  },
}));

// ---------------------------------------------------------------------------
// Import router after mocks
// ---------------------------------------------------------------------------

import router from './admin';

const USER_ID = 'user-auth-123';

// ---------------------------------------------------------------------------
// Express helpers
// ---------------------------------------------------------------------------

function findRouteHandler(
  method: 'get' | 'post' | 'put' | 'delete' | 'patch',
  path: string
): ((req: Request, res: Response) => Promise<void>) | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = layer.route.stack.find((s: any) => s.handle && s.handle.length <= 3);
  return handler?.handle ?? null;
}

function createAuthenticatedReq(overrides: Record<string, unknown> = {}): Request {
  return {
    headers: { authorization: 'Bearer test-token' },
    cookies: {},
    params: {},
    body: {},
    query: {},
    path: '/test',
    user: { email: 'test@example.com' },
    pcpUserId: USER_ID,
    pcpWorkspaceId: 'ws-1',
    pcpWorkspaceRole: 'member',
    header: vi.fn(() => undefined),
    ...overrides,
  } as unknown as Request;
}

interface MockResponse {
  _status: number;
  _json: unknown;
  status(code: number): MockResponse;
  json(payload: unknown): MockResponse;
  setHeader(name: string, value: unknown): MockResponse;
  send(payload: unknown): MockResponse;
  cookie(name: string, value: string, options: Record<string, unknown>): MockResponse;
}

function createMockRes(): MockResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = {
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
    setHeader() {
      return res;
    },
    send() {
      return res;
    },
    cookie() {
      return res;
    },
  };
  return res as MockResponse;
}

// ---------------------------------------------------------------------------
// Supabase chain helpers — simulate the specific call shapes the handler uses
// ---------------------------------------------------------------------------

interface InsertResult {
  data: { id: string; status: string; expires_at: string } | null;
  error: unknown;
}

function installInsertMock(result: InsertResult) {
  const insertChain = {
    select: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue(result),
    }),
  };
  mockSupabaseFrom.mockImplementation((table: string) => {
    if (table === 'approval_requests') {
      return {
        insert: vi.fn().mockReturnValue(insertChain),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
  return insertChain;
}

interface SelectResult {
  data: {
    id: string;
    status: string;
    action: string | null;
    granted_tools: string[] | null;
    granted_by: string | null;
    expires_at: string;
    resolved_at: string | null;
    created_at: string;
  } | null;
  error: unknown;
}

function installSelectMock(result: SelectResult, updateSpy?: ReturnType<typeof vi.fn>) {
  mockSupabaseFrom.mockImplementation((table: string) => {
    if (table !== 'approval_requests') {
      throw new Error(`unexpected table ${table}`);
    }
    return {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue(result),
          }),
        }),
      }),
      update: vi.fn().mockImplementation((updates: Record<string, unknown>) => {
        updateSpy?.(updates);
        return {
          eq: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }),
    };
  });
}

function futureIso(minutes = 5): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function pastIso(minutes = 5): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /approval-requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyPcpAccessToken.mockReturnValue({
      type: 'pcp_admin',
      sub: USER_ID,
      email: 'test@example.com',
      scope: 'admin',
    });
  });

  it('returns 400 when tool is missing', async () => {
    const handler = findRouteHandler('post', '/approval-requests');
    expect(handler).not.toBeNull();

    const req = createAuthenticatedReq({ body: {} });
    const res = createMockRes();
    await handler!(req as Request, res as unknown as Response);

    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'tool is required' });
  });

  it('inserts a pending request scoped to the authed user and returns 201', async () => {
    const insertChain = installInsertMock({
      data: {
        id: 'req-abc',
        status: 'pending',
        expires_at: futureIso(),
      },
      error: null,
    });

    const STUDIO_UUID = '11111111-2222-3333-4444-555555555555';
    const SESSION_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const handler = findRouteHandler('post', '/approval-requests');
    const req = createAuthenticatedReq({
      body: {
        tool: 'Bash',
        args: 'docker push registry/app',
        reason: 'deploy',
        studioId: STUDIO_UUID,
        sessionId: SESSION_UUID,
        timeoutSeconds: 300,
      },
    });
    const res = createMockRes();
    await handler!(req as Request, res as unknown as Response);

    expect(res._status).toBe(201);
    expect(res._json).toMatchObject({
      requestId: 'req-abc',
      status: 'pending',
    });

    // Inspect the insert payload
    const insertFn = mockSupabaseFrom.mock.results[0].value.insert as ReturnType<typeof vi.fn>;
    expect(insertFn).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: USER_ID,
        tool: 'Bash',
        args: 'docker push registry/app',
        reason: 'deploy',
        studio_id: STUDIO_UUID,
        session_id: SESSION_UUID,
        timeout_seconds: 300,
        requesting_agent_id: 'unknown', // no x-ink-context header in this test
      })
    );
    expect(insertChain.select).toHaveBeenCalled();
  });

  it('coerces non-UUID studio_id/session_id to null (e.g. "main" from root repo)', async () => {
    installInsertMock({
      data: { id: 'req-main', status: 'pending', expires_at: futureIso() },
      error: null,
    });

    const handler = findRouteHandler('post', '/approval-requests');
    const req = createAuthenticatedReq({
      body: { tool: 'Bash', args: 'ls', studioId: 'main', sessionId: 'not-a-uuid' },
    });
    const res = createMockRes();
    await handler!(req as Request, res as unknown as Response);

    expect(res._status).toBe(201);
    const insertFn = mockSupabaseFrom.mock.results[0].value.insert as ReturnType<typeof vi.fn>;
    expect(insertFn).toHaveBeenCalledWith(
      expect.objectContaining({ studio_id: null, session_id: null })
    );
  });

  it('resolves requestingAgentId from the x-ink-context header', async () => {
    installInsertMock({
      data: { id: 'req-xyz', status: 'pending', expires_at: futureIso() },
      error: null,
    });

    const contextToken = Buffer.from(JSON.stringify({ agentId: 'wren' })).toString('base64url');
    const handler = findRouteHandler('post', '/approval-requests');
    const req = createAuthenticatedReq({
      body: { tool: 'Bash', args: 'ls' },
      headers: { authorization: 'Bearer t', 'x-ink-context': contextToken },
    });
    const res = createMockRes();
    await handler!(req as Request, res as unknown as Response);

    const insertFn = mockSupabaseFrom.mock.results[0].value.insert as ReturnType<typeof vi.fn>;
    expect(insertFn).toHaveBeenCalledWith(expect.objectContaining({ requesting_agent_id: 'wren' }));
  });

  it('falls back to "unknown" when x-ink-context is malformed', async () => {
    installInsertMock({
      data: { id: 'req-bad', status: 'pending', expires_at: futureIso() },
      error: null,
    });

    const handler = findRouteHandler('post', '/approval-requests');
    const req = createAuthenticatedReq({
      body: { tool: 'Bash', args: 'ls' },
      headers: { authorization: 'Bearer t', 'x-ink-context': 'not-base64-json' },
    });
    const res = createMockRes();
    await handler!(req as Request, res as unknown as Response);

    const insertFn = mockSupabaseFrom.mock.results[0].value.insert as ReturnType<typeof vi.fn>;
    expect(insertFn).toHaveBeenCalledWith(
      expect.objectContaining({ requesting_agent_id: 'unknown' })
    );
  });

  it('triggers platform notification after successful insert (non-blocking)', async () => {
    installInsertMock({
      data: { id: 'req-notify', status: 'pending', expires_at: futureIso() },
      error: null,
    });

    const handler = findRouteHandler('post', '/approval-requests');
    const req = createAuthenticatedReq({
      body: { tool: 'Bash', args: 'docker push', reason: 'deploy' },
    });
    const res = createMockRes();
    await handler!(req as Request, res as unknown as Response);

    // Allow the fire-and-forget promise to settle
    await new Promise((r) => setImmediate(r));
    expect(mockNotifyPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'req-notify',
        userId: USER_ID,
        tool: 'Bash',
        args: 'docker push',
      })
    );
  });

  it('computes expires_at from timeoutSeconds (default 300)', async () => {
    installInsertMock({
      data: { id: 'req-t', status: 'pending', expires_at: futureIso() },
      error: null,
    });

    const handler = findRouteHandler('post', '/approval-requests');
    const req = createAuthenticatedReq({ body: { tool: 'Bash', args: 'ls' } }); // no timeoutSeconds
    const before = Date.now();
    const res = createMockRes();
    await handler!(req as Request, res as unknown as Response);
    const after = Date.now();

    const insertFn = mockSupabaseFrom.mock.results[0].value.insert as ReturnType<typeof vi.fn>;
    const payload = insertFn.mock.calls[0][0] as { expires_at: string; timeout_seconds: number };
    expect(payload.timeout_seconds).toBe(300);
    const expiresMs = new Date(payload.expires_at).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 300_000 - 5);
    expect(expiresMs).toBeLessThanOrEqual(after + 300_000 + 5);
  });

  it('returns 500 when the insert errors', async () => {
    installInsertMock({ data: null, error: { message: 'db write failed' } });

    const handler = findRouteHandler('post', '/approval-requests');
    const req = createAuthenticatedReq({ body: { tool: 'Bash', args: 'ls' } });
    const res = createMockRes();
    await handler!(req as Request, res as unknown as Response);

    expect(res._status).toBe(500);
    expect(mockNotifyPlatform).not.toHaveBeenCalled();
  });
});

describe('GET /approval-requests/:requestId/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyPcpAccessToken.mockReturnValue({
      type: 'pcp_admin',
      sub: USER_ID,
      email: 'test@example.com',
      scope: 'admin',
    });
  });

  it('returns 404 when the row does not exist or does not belong to the caller', async () => {
    installSelectMock({ data: null, error: { code: 'PGRST116', message: 'not found' } });

    const handler = findRouteHandler('get', '/approval-requests/:requestId/status');
    const req = createAuthenticatedReq({ params: { requestId: 'nope' } });
    const res = createMockRes();
    await handler!(req as Request, res as unknown as Response);

    expect(res._status).toBe(404);
    expect(res._json).toEqual({ error: 'Approval request not found' });
  });

  it('returns the raw status row when not expired', async () => {
    installSelectMock({
      data: {
        id: 'req-live',
        status: 'pending',
        action: null,
        granted_tools: null,
        granted_by: null,
        expires_at: futureIso(),
        resolved_at: null,
        created_at: new Date().toISOString(),
      },
      error: null,
    });

    const handler = findRouteHandler('get', '/approval-requests/:requestId/status');
    const req = createAuthenticatedReq({ params: { requestId: 'req-live' } });
    const res = createMockRes();
    await handler!(req as Request, res as unknown as Response);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      requestId: 'req-live',
      status: 'pending',
      action: null,
      grantedTools: null,
      grantedBy: null,
    });
  });

  it('auto-expires a pending row past its deadline and returns status=expired', async () => {
    const updateSpy = vi.fn();
    installSelectMock(
      {
        data: {
          id: 'req-stale',
          status: 'pending',
          action: null,
          granted_tools: null,
          granted_by: null,
          expires_at: pastIso(10),
          resolved_at: null,
          created_at: new Date().toISOString(),
        },
        error: null,
      },
      updateSpy
    );

    const handler = findRouteHandler('get', '/approval-requests/:requestId/status');
    const req = createAuthenticatedReq({ params: { requestId: 'req-stale' } });
    const res = createMockRes();
    await handler!(req as Request, res as unknown as Response);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'expired' });
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
  });

  it('does not auto-expire a row that is already resolved (granted)', async () => {
    const updateSpy = vi.fn();
    installSelectMock(
      {
        data: {
          id: 'req-done',
          status: 'granted',
          action: 'grant',
          granted_tools: ['Bash(docker push)'],
          granted_by: 'platform:telegram:chat-1',
          expires_at: pastIso(10), // past deadline, but already resolved
          resolved_at: pastIso(9),
          created_at: new Date().toISOString(),
        },
        error: null,
      },
      updateSpy
    );

    const handler = findRouteHandler('get', '/approval-requests/:requestId/status');
    const req = createAuthenticatedReq({ params: { requestId: 'req-done' } });
    const res = createMockRes();
    await handler!(req as Request, res as unknown as Response);

    expect(res._json).toMatchObject({
      status: 'granted',
      action: 'grant',
      grantedTools: ['Bash(docker push)'],
      grantedBy: 'platform:telegram:chat-1',
    });
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
