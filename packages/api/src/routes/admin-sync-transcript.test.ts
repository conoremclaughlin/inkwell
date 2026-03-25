import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import path from 'path';

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
  isDevelopment: () => true,
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

const mockFsReaddir = vi.fn();
const mockFsReadFile = vi.fn();
const mockFsStat = vi.fn();

vi.mock('fs', () => ({
  promises: {
    readdir: (...args: unknown[]) => mockFsReaddir(...args),
    readFile: (...args: unknown[]) => mockFsReadFile(...args),
    stat: (...args: unknown[]) => mockFsStat(...args),
  },
}));

import router from './admin';

const TEST_USER_ID = 'user-test-123';
const TEST_WORKSPACE_ID = 'workspace-test-456';

function createQueryChain(resolvedData: unknown[] | null = [], error: unknown = null) {
  const chain: Record<string, any> = {};
  chain.select = vi.fn(() => chain);
  chain.insert = vi.fn(() => chain);
  chain.upsert = vi.fn(() => chain);
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
  chain.then = (resolve: (val: any) => any) => resolve({ data: resolvedData, error });
  return chain;
}

function findRouteHandler(
  method: 'post',
  routePath: string
): ((req: Request, res: Response) => Promise<void>) | null {
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === routePath && entry.route?.methods?.[method]
  );
  if (!layer) return null;
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
}

function createMockRes(): MockResponse {
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

describe('POST /sessions/:id/sync-transcript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyPcpAccessToken.mockReturnValue({
      type: 'pcp_admin',
      sub: TEST_USER_ID,
      email: 'test@example.com',
      scope: 'admin',
    });
    mockEnsurePersonalWorkspace.mockResolvedValue({ id: TEST_WORKSPACE_ID });
  });

  it('upserts a synced transcript archive and returns sync metadata', async () => {
    const handler = findRouteHandler('post', '/sessions/:id/sync-transcript');
    expect(handler).not.toBeNull();

    const transcriptFile = path.join(
      process.cwd(),
      '.pcp',
      'runtime',
      'repl',
      'session-1-1700000000000.jsonl'
    );
    const archiveChain = createQueryChain([]);

    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === 'agent_identities') {
        return createQueryChain([
          { id: 'identity-1', agent_id: 'lumen', name: 'Lumen', role: 'SB' },
        ]);
      }

      if (table === 'sessions') {
        return createQueryChain([
          {
            id: 'session-1',
            identity_id: 'identity-1',
            agent_id: 'lumen',
            backend: 'pcp',
            backend_session_id: 'backend-1',
            claude_session_id: null,
          },
        ]);
      }

      if (table === 'session_transcript_archives') {
        return archiveChain;
      }

      return createQueryChain([]);
    });

    mockFsReaddir.mockImplementation(async (dir: string) => {
      if (dir.endsWith(path.join('.pcp', 'runtime', 'repl'))) {
        return [
          {
            name: 'session-1-1700000000000.jsonl',
            isFile: () => true,
            isDirectory: () => false,
          },
        ];
      }
      throw new Error(`ENOENT: ${dir}`);
    });

    mockFsStat.mockImplementation(async (filePath: string) => {
      if (filePath === transcriptFile) {
        return {
          isFile: () => true,
          mtimeMs: 1700000000000,
        };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    mockFsReadFile.mockImplementation(async (filePath: string) => {
      if (filePath === transcriptFile) {
        return [
          JSON.stringify({
            type: 'user',
            content: 'hello from local transcript',
            timestamp: '2026-03-11T15:00:00.000Z',
          }),
          JSON.stringify({
            type: 'assistant',
            content: 'hello from synced archive',
            timestamp: '2026-03-11T15:00:05.000Z',
          }),
          '',
        ].join('\n');
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    const req = createAuthenticatedReq({
      params: { id: 'session-1' },
      body: {},
    });
    const res = createMockRes();
    await handler!(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ok: true,
      sessionId: 'session-1',
      backend: 'pcp',
      backendSessionId: 'backend-1',
      format: 'jsonl',
      sourcePath: transcriptFile,
      resolvedBy: 'pcp-runtime',
      lineCount: 2,
    });

    expect(archiveChain.upsert).toHaveBeenCalledTimes(1);
    const [archiveRow, options] = archiveChain.upsert.mock.calls[0];
    expect(options).toEqual({ onConflict: 'session_id' });
    expect(archiveRow).toMatchObject({
      user_id: TEST_USER_ID,
      session_id: 'session-1',
      backend: 'pcp',
      backend_session_id: 'backend-1',
      source_path: transcriptFile,
      line_count: 2,
    });
    expect(archiveRow.payload).toMatchObject({
      version: 1,
      backend: 'pcp',
      backendSessionId: 'backend-1',
      format: 'jsonl',
      sourcePath: transcriptFile,
      events: [
        {
          type: 'user',
          content: 'hello from local transcript',
          timestamp: '2026-03-11T15:00:00.000Z',
        },
        {
          type: 'assistant',
          content: 'hello from synced archive',
          timestamp: '2026-03-11T15:00:05.000Z',
        },
      ],
    });
  });
});
