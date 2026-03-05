/**
 * Admin Endpoint Handler Regression Tests
 *
 * Tests that key GET endpoints return 200 (not 500) when the auth middleware
 * has already resolved successfully. These tests catch regressions like:
 * - Querying columns that don't exist on a table
 * - Handler-level crashes from null/undefined access
 * - Import or initialization failures in handler code
 *
 * The auth middleware is already tested in admin-auth.test.ts.
 * Here we bypass auth and test the route handlers directly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Mocks — same structure as admin-auth.test.ts
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

// Supabase mock — returns empty results for any table by default
const mockSupabaseFrom = vi.fn();
const mockGetUser = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
  })),
}));

// Data layer mocks
const mockFindById = vi.fn();
const mockFindRawById = vi.fn();
const mockEnsurePersonalWorkspace = vi.fn();
const mockListMembershipsByUser = vi.fn();
const mockListTrustedUsers = vi.fn();

vi.mock('../data/composer', () => ({
  getDataComposer: vi.fn(async () => ({
    repositories: {
      workspaces: {
        findById: mockFindById,
        findRawById: mockFindRawById,
        ensurePersonalWorkspace: mockEnsurePersonalWorkspace,
        listMembershipsByUser: mockListMembershipsByUser,
      },
    },
  })),
}));

vi.mock('../services/authorization', () => ({
  getAuthorizationService: vi.fn(() => ({
    listTrustedUsers: mockListTrustedUsers,
  })),
}));

const mockGetConnectedAccounts = vi.fn();
const mockGetSupportedProviders = vi.fn();
const mockIsProviderConfigured = vi.fn();

vi.mock('../services/oauth', () => ({
  getOAuthService: vi.fn(() => ({
    getConnectedAccounts: mockGetConnectedAccounts,
    getSupportedProviders: mockGetSupportedProviders,
    isProviderConfigured: mockIsProviderConfigured,
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
}));

vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../utils/request-context', () => ({
  runWithRequestContext: (_context: Record<string, unknown>, fn: () => void) => {
    fn();
  },
}));

// ---------------------------------------------------------------------------
// Import router after mocks
// ---------------------------------------------------------------------------

import router from './admin';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_USER_ID = 'user-test-123';
const TEST_WORKSPACE_ID = 'workspace-test-456';

/** Create a chainable Supabase query mock that resolves to given data */
function createQueryChain(resolvedData: unknown[] | null = [], error: unknown = null) {
  const chain: Record<string, any> = {};
  chain.select = vi.fn(() => chain);
  chain.insert = vi.fn(() => chain);
  chain.update = vi.fn(() => chain);
  chain.delete = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.neq = vi.fn(() => chain);
  chain.in = vi.fn(() => chain);
  chain.is = vi.fn(() => chain);
  chain.not = vi.fn(() => chain);
  chain.or = vi.fn(() => chain);
  chain.gte = vi.fn(() => chain);
  chain.lte = vi.fn(() => chain);
  chain.order = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.range = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data: resolvedData?.[0] ?? null, error }));
  chain.single = vi.fn(() =>
    Promise.resolve({
      data: resolvedData?.[0] ?? null,
      error: resolvedData?.[0] ? null : { code: 'PGRST116', message: 'not found' },
    })
  );
  // Default: resolve the chain as a list query (used by .then() or await)
  chain.then = (resolve: (val: any) => any) => resolve({ data: resolvedData, error });
  return chain;
}

/** Set up the default Supabase mock that returns empty arrays for all tables */
function setupDefaultSupabaseMock() {
  mockSupabaseFrom.mockImplementation(() => createQueryChain([]));
}

/** Find a route handler in the Express router stack by method and path */
function findRouteHandler(
  method: 'get' | 'post' | 'put' | 'delete' | 'patch',
  path: string
): ((req: Request, res: Response) => Promise<void>) | null {
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) return null;
  // Express stores handlers in route.stack — find the async handler
  const handler = layer.route.stack.find((s: any) => s.handle && s.handle.length <= 3);
  return handler?.handle ?? null;
}

/** Create a mock request with auth context already set (as if middleware passed) */
function createAuthenticatedReq(overrides: Record<string, unknown> = {}): Request {
  return {
    headers: { authorization: 'Bearer test-token' },
    cookies: {},
    params: {},
    body: {},
    query: {},
    path: '/test',
    user: { email: 'test@example.com' },
    pcpUserId: TEST_USER_ID,
    pcpWorkspaceId: TEST_WORKSPACE_ID,
    pcpWorkspaceRole: 'member',
    header: vi.fn(() => undefined),
    ...overrides,
  } as unknown as Request;
}

interface MockResponse extends Response {
  _status: number;
  _json: unknown;
  _cookies: Record<string, unknown>;
}

function createMockRes(): MockResponse {
  const res: Record<string, unknown> = {
    _status: 200,
    _json: null,
    _cookies: {},
    status(code: number) {
      res._status = code;
      return res;
    },
    json(payload: unknown) {
      res._json = payload;
      return res;
    },
    cookie(name: string, value: string, options: Record<string, unknown>) {
      (res._cookies as Record<string, unknown>)[name] = { value, options };
      return res;
    },
    setHeader() {
      return res;
    },
    write() {
      return true;
    },
    end() {
      return res;
    },
    flush() {
      return res;
    },
  };
  return res as unknown as MockResponse;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('admin endpoint handlers (no-500 regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Auth setup: Tier 1 always succeeds
    mockVerifyPcpAccessToken.mockReturnValue({
      type: 'pcp_admin',
      sub: TEST_USER_ID,
      email: 'test@example.com',
      scope: 'admin',
    });
    mockEnsurePersonalWorkspace.mockResolvedValue({ id: TEST_WORKSPACE_ID });

    // Default: all Supabase queries return empty arrays (no error)
    setupDefaultSupabaseMock();
  });

  // =========================================================================
  // GET /workspaces — loaded by sidebar on every page
  // =========================================================================

  describe('GET /workspaces', () => {
    it('should return 200 with empty workspaces list', async () => {
      mockListMembershipsByUser.mockResolvedValue([]);

      const handler = findRouteHandler('get', '/workspaces');
      expect(handler).not.toBeNull();

      const req = createAuthenticatedReq();
      const res = createMockRes();
      await handler!(req, res);

      expect(res._status).toBe(200);
      expect(res._json).toHaveProperty('workspaces');
      expect(res._json).toHaveProperty('currentWorkspaceId', TEST_WORKSPACE_ID);
    });

    it('should return 200 with populated workspaces', async () => {
      mockListMembershipsByUser.mockResolvedValue([
        {
          id: TEST_WORKSPACE_ID,
          name: 'Personal',
          slug: 'personal',
          type: 'personal',
          role: 'owner',
          membershipCreatedAt: '2026-01-01T00:00:00Z',
          description: null,
          metadata: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          archivedAt: null,
        },
      ]);

      const handler = findRouteHandler('get', '/workspaces');
      const req = createAuthenticatedReq();
      const res = createMockRes();
      await handler!(req, res);

      expect(res._status).toBe(200);
      const json = res._json as any;
      expect(json.workspaces).toHaveLength(1);
      expect(json.workspaces[0].name).toBe('Personal');
    });
  });

  // =========================================================================
  // GET /reminders — loaded by reminders page
  // =========================================================================

  describe('GET /reminders', () => {
    it('should return 200 with empty reminders (no workspace_id filter)', async () => {
      const handler = findRouteHandler('get', '/reminders');
      expect(handler).not.toBeNull();

      const req = createAuthenticatedReq();
      const res = createMockRes();
      await handler!(req, res);

      expect(res._status).toBe(200);
      expect(res._json).toHaveProperty('reminders');
      expect((res._json as any).reminders).toEqual([]);
    });

    it('should return 200 with populated reminders', async () => {
      mockSupabaseFrom.mockImplementation(() =>
        createQueryChain([
          {
            id: 'rem-1',
            user_id: TEST_USER_ID,
            title: 'Test Reminder',
            description: 'A test',
            cron_expression: '0 9 * * *',
            next_run_at: '2026-02-24T09:00:00Z',
            last_run_at: null,
            delivery_channel: 'telegram',
            status: 'active',
            run_count: 0,
            users: { email: 'test@example.com', first_name: 'Test' },
          },
        ])
      );

      const handler = findRouteHandler('get', '/reminders');
      const req = createAuthenticatedReq();
      const res = createMockRes();
      await handler!(req, res);

      expect(res._status).toBe(200);
      const json = res._json as any;
      expect(json.reminders).toHaveLength(1);
      expect(json.reminders[0].title).toBe('Test Reminder');
    });
  });

  // =========================================================================
  // GET /trusted-users — loaded by trusted users page
  // =========================================================================

  describe('GET /trusted-users', () => {
    it('should return 200 with empty trusted users list', async () => {
      const handler = findRouteHandler('get', '/trusted-users');
      expect(handler).not.toBeNull();

      const req = createAuthenticatedReq();
      const res = createMockRes();
      await handler!(req, res);

      expect(res._status).toBe(200);
      expect(res._json).toHaveProperty('users');
      expect((res._json as any).users).toEqual([]);
    });
  });

  // =========================================================================
  // GET /groups — loaded by groups page
  // =========================================================================

  describe('GET /groups', () => {
    it('should return 200 with empty groups list', async () => {
      const handler = findRouteHandler('get', '/groups');
      expect(handler).not.toBeNull();

      const req = createAuthenticatedReq();
      const res = createMockRes();
      await handler!(req, res);

      expect(res._status).toBe(200);
      expect(res._json).toHaveProperty('groups');
      expect((res._json as any).groups).toEqual([]);
    });
  });

  // =========================================================================
  // GET /challenge-codes — loaded by challenge codes page
  // =========================================================================

  describe('GET /challenge-codes', () => {
    it('should return 200 with empty codes list', async () => {
      const handler = findRouteHandler('get', '/challenge-codes');
      expect(handler).not.toBeNull();

      const req = createAuthenticatedReq();
      const res = createMockRes();
      await handler!(req, res);

      expect(res._status).toBe(200);
      expect(res._json).toHaveProperty('codes');
      expect((res._json as any).codes).toEqual([]);
    });
  });

  // =========================================================================
  // GET /individuals — loaded by individuals page
  // =========================================================================

  describe('GET /individuals', () => {
    it('should return 200 with empty individuals list', async () => {
      const handler = findRouteHandler('get', '/individuals');
      expect(handler).not.toBeNull();

      const req = createAuthenticatedReq();
      const res = createMockRes();
      await handler!(req, res);

      expect(res._status).toBe(200);
      expect(res._json).toHaveProperty('individuals');
      expect((res._json as any).individuals).toEqual([]);
    });
  });

  // =========================================================================
  // GET /user-identity — loaded by user identity page
  // =========================================================================

  describe('GET /user-identity', () => {
    it('should return 200 when no user identity exists', async () => {
      const handler = findRouteHandler('get', '/user-identity');
      expect(handler).not.toBeNull();

      const req = createAuthenticatedReq();
      const res = createMockRes();
      await handler!(req, res);

      // Should return 200 even when identity doesn't exist (PGRST116)
      expect(res._status).toBe(200);
    });

    it('should include alias and legacy shared doc fields when identity exists', async () => {
      const handler = findRouteHandler('get', '/user-identity');
      expect(handler).not.toBeNull();

      mockSupabaseFrom.mockImplementation((table: string) => {
        if (table === 'user_identity') {
          return createQueryChain([
            {
              id: 'identity-1',
              user_id: TEST_USER_ID,
              user_profile_md: '# USER',
              shared_values_md: '# VALUES',
              process_md: '# PROCESS',
              version: 4,
              created_at: '2026-02-01T00:00:00.000Z',
              updated_at: '2026-02-25T00:00:00.000Z',
            },
          ]);
        }
        if (table === 'workspaces') {
          return createQueryChain([
            { shared_values: '# VALUES (workspace)', process: '# PROCESS (workspace)' },
          ]);
        }
        return createQueryChain([]);
      });

      const req = createAuthenticatedReq();
      const res = createMockRes();
      await handler!(req, res);

      expect(res._status).toBe(200);
      const payload = (res._json as any).userIdentity;
      expect(payload.userProfile).toBe('# USER');
      expect(payload.sharedValues).toBe('# VALUES (workspace)');
      expect(payload.process).toBe('# PROCESS (workspace)');
      expect(payload.userProfileMd).toBe('# USER');
      expect(payload.sharedValuesMd).toBe('# VALUES (workspace)');
      expect(payload.processMd).toBe('# PROCESS (workspace)');
    });
  });

  describe('GET /user-identity/history', () => {
    it('should include alias and legacy fields in history entries', async () => {
      const handler = findRouteHandler('get', '/user-identity/history');
      expect(handler).not.toBeNull();

      mockSupabaseFrom.mockImplementation((table: string) => {
        if (table === 'user_identity') {
          return createQueryChain([{ id: 'identity-1' }]);
        }
        if (table === 'user_identity_history') {
          return createQueryChain([
            {
              id: 'hist-1',
              version: 3,
              user_profile_md: '# USER',
              shared_values_md: '# VALUES',
              process_md: '# PROCESS',
              change_type: 'update',
              created_at: '2026-02-20T00:00:00.000Z',
              archived_at: '2026-02-25T00:00:00.000Z',
            },
          ]);
        }
        return createQueryChain([]);
      });

      const req = createAuthenticatedReq();
      const res = createMockRes();
      await handler!(req, res);

      expect(res._status).toBe(200);
      const entry = (res._json as any).history[0];
      expect(entry.userProfile).toBe('# USER');
      expect(entry.sharedValues).toBe('# VALUES');
      expect(entry.process).toBe('# PROCESS');
      expect(entry.userProfileMd).toBe('# USER');
      expect(entry.sharedValuesMd).toBe('# VALUES');
      expect(entry.processMd).toBe('# PROCESS');
    });
  });

  // =========================================================================
  // GET /sessions — loaded by main dashboard page
  // =========================================================================

  describe('GET /sessions', () => {
    it('should return 200 with empty sessions list', async () => {
      const handler = findRouteHandler('get', '/sessions');
      expect(handler).not.toBeNull();

      const req = createAuthenticatedReq({ query: {} });
      const res = createMockRes();
      await handler!(req, res);

      expect(res._status).toBe(200);
      expect(res._json).toHaveProperty('sessions');
      expect((res._json as any).sessions).toEqual([]);
    });

    it('scopes sessions by workspace identities (not sessions.workspace_id)', async () => {
      const handler = findRouteHandler('get', '/sessions');
      expect(handler).not.toBeNull();

      let sessionsQueryCount = 0;
      mockSupabaseFrom.mockImplementation((table: string) => {
        if (table === 'agent_identities') {
          return createQueryChain([
            { id: 'identity-1', agent_id: 'wren', name: 'Wren', role: 'Developer' },
          ]);
        }

        if (table === 'sessions') {
          sessionsQueryCount += 1;
          if (sessionsQueryCount === 1) {
            // Identity-scoped rows
            return createQueryChain([
              {
                id: 'session-identity',
                identity_id: 'identity-1',
                agent_id: 'wren',
                status: 'active',
                current_phase: 'runtime:generating',
                summary: null,
                context: 'Doing work',
                backend: 'claude',
                model: 'sonnet',
                message_count: 12,
                token_count: 1234,
                started_at: '2026-03-04T09:00:00Z',
                updated_at: '2026-03-04T09:10:00Z',
                ended_at: null,
                backend_session_id: 'backend-1',
                claude_session_id: null,
                studio_id: 'studio-1',
                workspace_id: 'studio-1', // Legacy studio alias, not top-level workspace
              },
            ]);
          }

          if (sessionsQueryCount === 2) {
            // Legacy rows without identity_id, still in same workspace via agent_id
            return createQueryChain([
              {
                id: 'session-legacy',
                identity_id: null,
                agent_id: 'wren',
                status: 'active',
                current_phase: 'runtime:idle',
                summary: null,
                context: null,
                backend: 'claude',
                model: null,
                message_count: 2,
                token_count: 100,
                started_at: '2026-03-04T08:00:00Z',
                updated_at: '2026-03-04T08:30:00Z',
                ended_at: null,
                backend_session_id: 'backend-2',
                claude_session_id: null,
                studio_id: null,
                workspace_id: null,
              },
            ]);
          }

          return createQueryChain([]);
        }

        // Studios/preview tables can be empty for this test.
        return createQueryChain([]);
      });

      const req = createAuthenticatedReq({ query: {} });
      const res = createMockRes();
      await handler!(req, res);

      expect(res._status).toBe(200);
      const json = res._json as any;
      expect(json.sessions).toHaveLength(2);
      expect(json.sessions.map((s: any) => s.id)).toEqual(['session-identity', 'session-legacy']);
      expect(json.sessions[0].agentName).toBe('Wren');
      expect(json.stats.total).toBe(2);
    });
  });

  // =========================================================================
  // GET /sessions/:id/logs — loaded by session log viewer page
  // =========================================================================

  describe('GET /sessions/:id/logs', () => {
    it('returns 200 for legacy session rows scoped by agent identity', async () => {
      const handler = findRouteHandler('get', '/sessions/:id/logs');
      expect(handler).not.toBeNull();

      mockSupabaseFrom.mockImplementation((table: string) => {
        if (table === 'agent_identities') {
          return createQueryChain([{ id: 'identity-1', agent_id: 'wren' }]);
        }

        if (table === 'sessions') {
          return createQueryChain([
            {
              id: 'session-legacy',
              identity_id: null,
              agent_id: 'wren',
              status: 'active',
              current_phase: 'runtime:idle',
              started_at: '2026-03-04T08:00:00Z',
              updated_at: '2026-03-04T08:30:00Z',
              ended_at: null,
              backend: 'claude',
              backend_session_id: 'backend-2',
              claude_session_id: null,
            },
          ]);
        }

        return createQueryChain([]);
      });

      const req = createAuthenticatedReq({
        params: { id: 'session-legacy' },
        query: { limit: '20', offset: '0', includeLocal: 'false' },
      });
      const res = createMockRes();
      await handler!(req, res);

      expect(res._status).toBe(200);
      const json = res._json as any;
      expect(json.session.id).toBe('session-legacy');
      expect(json.logs).toEqual([]);
    });

    it('returns 404 when session identity is outside active workspace', async () => {
      const handler = findRouteHandler('get', '/sessions/:id/logs');
      expect(handler).not.toBeNull();

      mockSupabaseFrom.mockImplementation((table: string) => {
        if (table === 'agent_identities') {
          return createQueryChain([{ id: 'identity-1', agent_id: 'wren' }]);
        }

        if (table === 'sessions') {
          return createQueryChain([
            {
              id: 'session-other-workspace',
              identity_id: 'identity-other',
              agent_id: 'wren',
              status: 'active',
              current_phase: 'runtime:idle',
              started_at: '2026-03-04T08:00:00Z',
              updated_at: '2026-03-04T08:30:00Z',
              ended_at: null,
              backend: 'claude',
              backend_session_id: 'backend-2',
              claude_session_id: null,
            },
          ]);
        }

        return createQueryChain([]);
      });

      const req = createAuthenticatedReq({
        params: { id: 'session-other-workspace' },
        query: { limit: '20', offset: '0', includeLocal: 'false' },
      });
      const res = createMockRes();
      await handler!(req, res);

      expect(res._status).toBe(404);
      expect(res._json).toEqual({ error: 'Session not found' });
    });
  });

  // =========================================================================
  // GET /artifacts — loaded by artifacts page
  // =========================================================================

  describe('GET /artifacts', () => {
    it('should return 200 with empty artifacts list', async () => {
      const handler = findRouteHandler('get', '/artifacts');
      expect(handler).not.toBeNull();

      const req = createAuthenticatedReq();
      const res = createMockRes();
      await handler!(req, res);

      expect(res._status).toBe(200);
      expect(res._json).toHaveProperty('artifacts');
      expect((res._json as any).artifacts).toEqual([]);
    });
  });

  // =========================================================================
  // GET /connected-accounts — loaded by connected accounts page
  // =========================================================================

  describe('GET /connected-accounts', () => {
    it('should return 200 with accounts and providers', async () => {
      mockGetConnectedAccounts.mockResolvedValue([]);
      mockGetSupportedProviders.mockReturnValue(['google']);
      mockIsProviderConfigured.mockReturnValue(true);

      const handler = findRouteHandler('get', '/connected-accounts');
      expect(handler).not.toBeNull();

      const req = createAuthenticatedReq();
      const res = createMockRes();
      await handler!(req, res);

      expect(res._status).toBe(200);
      expect(res._json).toHaveProperty('accounts');
      expect(res._json).toHaveProperty('providers');
    });
  });

  // =========================================================================
  // Cross-cutting: handler doesn't crash on null/undefined from Supabase
  // =========================================================================

  describe('null safety', () => {
    it('GET /reminders handles null data from Supabase gracefully', async () => {
      mockSupabaseFrom.mockImplementation(() => createQueryChain(null));

      const handler = findRouteHandler('get', '/reminders');
      const req = createAuthenticatedReq();
      const res = createMockRes();
      await handler!(req, res);

      expect(res._status).toBe(200);
      expect((res._json as any).reminders).toEqual([]);
    });

    it('GET /sessions handles null data from Supabase gracefully', async () => {
      mockSupabaseFrom.mockImplementation(() => createQueryChain(null));

      const handler = findRouteHandler('get', '/sessions');
      const req = createAuthenticatedReq({ query: {} });
      const res = createMockRes();
      await handler!(req, res);

      expect(res._status).toBe(200);
      expect((res._json as any).sessions).toEqual([]);
    });

    it('GET /trusted-users handles null data from Supabase gracefully', async () => {
      mockSupabaseFrom.mockImplementation(() => createQueryChain(null));

      const handler = findRouteHandler('get', '/trusted-users');
      const req = createAuthenticatedReq();
      const res = createMockRes();
      await handler!(req, res);

      expect(res._status).toBe(200);
      expect((res._json as any).users).toEqual([]);
    });
  });
});
