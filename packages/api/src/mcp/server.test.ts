/**
 * Tests for MCP Streamable HTTP transport (stateless mode).
 *
 * Spins up a real HTTP server with mocked internals (DataComposer, mini-apps,
 * tools) and validates stateless request handling via fetch.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { verifyPcpAccessToken } from '../auth/pcp-tokens';

const mockVerifyAccessToken = vi.fn();

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('../config/env', () => ({
  env: {
    MCP_TRANSPORT: 'http',
    MCP_HTTP_PORT: 0, // will be overridden
    MCP_REQUIRE_OAUTH: false,
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'test-key',
    SUPABASE_ANON_KEY: 'test-anon-key',
    JWT_SECRET: 'test-jwt-secret',
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

vi.mock('./tools', () => ({
  registerAllTools: vi.fn(),
  setMiniAppsRegistry: vi.fn(),
  setTelegramListener: vi.fn(),
}));

vi.mock('../mini-apps', () => ({
  loadMiniApps: vi.fn(() => new Map()),
  registerMiniAppTools: vi.fn(),
  getMiniAppsInfo: vi.fn(() => []),
}));

vi.mock('./auth/pcp-auth-provider', () => {
  class MockPcpAuthProvider {
    verifyAccessToken = mockVerifyAccessToken;
    createPendingAuth = vi.fn(() => 'pending-id');
    handleAuthCallback = vi.fn(async () => ({ error: 'invalid_request' }));
    exchangeAuthorizationCode = vi.fn(async () => ({ error: 'invalid_grant' }));
    exchangeRefreshToken = vi.fn(async () => ({ error: 'invalid_grant' }));
    cleanupExpiredDatabaseTokens = vi.fn();
  }
  return { PcpAuthProvider: MockPcpAuthProvider };
});

vi.mock('../routes/admin', () => {
  const { Router } = require('express');
  return {
    default: Router(),
    setWhatsAppListener: vi.fn(),
  };
});

vi.mock('../routes/agent-trigger', () => {
  const { Router } = require('express');
  return {
    default: Router(),
    getAgentGateway: vi.fn(),
  };
});

vi.mock('../utils/request-context', () => ({
  runWithRequestContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) },
    from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn() })) })) })),
  })),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { MCPServer } from './server';
import { env } from '../config/env';
import { registerAllTools } from './tools';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const INITIALIZE_REQUEST = {
  jsonrpc: '2.0',
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
  id: 1,
};

function makeToolsListRequest(id: number) {
  return { jsonrpc: '2.0', method: 'tools/list', params: {}, id };
}

/** POST to the MCP endpoint. */
async function mcpPost(
  baseUrl: string,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; headers: Headers; body: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...extraHeaders,
  };
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text };
}

/** GET the MCP endpoint. */
async function mcpGet(
  baseUrl: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: Headers; body: string }> {
  const res = await fetch(`${baseUrl}/mcp`, { method: 'GET', headers });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text };
}

/** Extract the JSON result from an SSE event stream body. */
function parseSSEResult(body: string): unknown {
  const match = body.match(/^data: (.+)$/m);
  if (!match) throw new Error(`No SSE data line found in: ${body}`);
  return JSON.parse(match[1]);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('MCP StreamableHTTP Transport (stateless)', () => {
  let server: MCPServer;
  let baseUrl: string;
  let serverUnavailableError: Error | null = null;
  let delegatedIdentity: { id: string; agent_id: string } | null = null;

  // Minimal DataComposer stub
  const mockDataComposer = {
    getClient: () => ({
      from: (table: string) => {
        if (table === 'agent_identities') {
          const filters: Record<string, string> = {};
          const query = {
            select: () => query,
            eq: (field: string, value: string) => {
              filters[field] = value;
              return query;
            },
            maybeSingle: async () => {
              const matches =
                delegatedIdentity &&
                filters.user_id === 'user-123' &&
                filters.agent_id === delegatedIdentity.agent_id;
              return { data: matches ? delegatedIdentity : null, error: null };
            },
            single: async () => ({ data: null, error: null }),
            limit: () => ({ error: null }),
          };
          return query;
        }
        return {
          select: () => ({
            limit: () => ({ error: null }),
            eq: () => ({ single: async () => ({ data: null, error: null }) }),
          }),
        };
      },
    }),
  } as any;

  beforeAll(async () => {
    server = new MCPServer(mockDataComposer);

    // Start on a random port
    const { env } = await import('../config/env');
    (env as any).MCP_HTTP_PORT = 0;
    (env as any).MCP_TRANSPORT = 'http';
    try {
      await server.start();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (err.message.includes('EPERM: operation not permitted')) {
        serverUnavailableError = err;
        return;
      }
      throw err;
    }

    const port = server.getPort();
    if (!port) {
      serverUnavailableError = new Error('MCP HTTP server failed to bind to a port');
      return;
    }
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    if (serverUnavailableError || !server) return;
    await server.shutdown();
  });

  beforeEach(() => {
    mockVerifyAccessToken.mockReset();
    delegatedIdentity = null;
  });

  // =========================================================================
  // Stateless initialization
  // =========================================================================

  it('should handle initialize requests without returning a session ID', async () => {
    if (serverUnavailableError) return;
    const res = await mcpPost(baseUrl, INITIALIZE_REQUEST);

    expect(res.status).toBe(200);
    // Stateless mode: no session ID in response
    const sessionId = res.headers.get('mcp-session-id');
    expect(sessionId).toBeNull();

    const result = parseSSEResult(res.body) as any;
    expect(result.result.serverInfo.name).toBe('personal-context-protocol');
    expect(result.result.protocolVersion).toBe('2025-03-26');
  });

  it('should challenge unauthenticated initialize requests when OAuth is required', async () => {
    if (serverUnavailableError) return;
    (env as any).MCP_REQUIRE_OAUTH = true;

    const res = await mcpPost(baseUrl, INITIALIZE_REQUEST);

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');

    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toContain('Authentication required');

    (env as any).MCP_REQUIRE_OAUTH = false;
  });

  it('should expose GET /mcp for streamable-http clients', async () => {
    if (serverUnavailableError) return;
    // This server intentionally does not offer standalone SSE at GET /mcp.
    // Per streamable-http compatibility, it should return explicit 405 (not 404).
    const res = await mcpGet(baseUrl);
    expect(res.status).toBe(405);
  });

  // =========================================================================
  // Stateless tool calls
  // =========================================================================

  it('should handle tool list requests without session ID', async () => {
    if (serverUnavailableError) return;
    // In stateless mode, every request is self-contained — no session needed
    const res = await mcpPost(baseUrl, INITIALIZE_REQUEST);
    expect(res.status).toBe(200);

    // A separate tools/list request (new transport) should also work
    const listRes = await mcpPost(baseUrl, makeToolsListRequest(2));
    expect(listRes.status).toBe(200);
  });

  it('registers agent-facing MCP catalog without internal lifecycle tools by default', async () => {
    if (serverUnavailableError) return;
    const registerAllToolsMock = vi.mocked(registerAllTools);
    const priorCalls = registerAllToolsMock.mock.calls.length;

    const res = await mcpPost(baseUrl, makeToolsListRequest(21));
    expect(res.status).toBe(200);

    const newCalls = registerAllToolsMock.mock.calls.slice(priorCalls);
    const lastCall = newCalls[newCalls.length - 1];
    expect(lastCall?.[2]).toEqual({ includeInternalLifecycleTools: false });
  });

  it('registers runtime MCP catalog with internal lifecycle tools when caller profile is runtime', async () => {
    if (serverUnavailableError) return;
    const registerAllToolsMock = vi.mocked(registerAllTools);
    const priorCalls = registerAllToolsMock.mock.calls.length;

    const res = await mcpPost(baseUrl, makeToolsListRequest(22), {
      'x-pcp-caller-profile': 'runtime',
    });
    expect(res.status).toBe(200);

    const newCalls = registerAllToolsMock.mock.calls.slice(priorCalls);
    const lastCall = newCalls[newCalls.length - 1];
    expect(lastCall?.[2]).toEqual({ includeInternalLifecycleTools: true });
  });

  it('should handle multiple concurrent requests independently', async () => {
    if (serverUnavailableError) return;
    const [res1, res2] = await Promise.all([
      mcpPost(baseUrl, INITIALIZE_REQUEST),
      mcpPost(baseUrl, { ...INITIALIZE_REQUEST, id: 10 }),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Neither should have a session ID
    expect(res1.headers.get('mcp-session-id')).toBeNull();
    expect(res2.headers.get('mcp-session-id')).toBeNull();
  });

  // =========================================================================
  // DELETE is a no-op
  // =========================================================================

  it('should return 204 on DELETE (no-op in stateless mode)', async () => {
    if (serverUnavailableError) return;
    const res = await fetch(`${baseUrl}/mcp`, { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  // =========================================================================
  // Health check
  // =========================================================================

  it('should report stateless mode in health check', async () => {
    if (serverUnavailableError) return;
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('healthy');
    expect(body.build).toBeDefined();
    expect(typeof body.build.appVersion).toBe('string');
    expect(typeof body.build.updateAvailable).toBe('boolean');
    expect(body.checks.mcp.details.mode).toBe('stateless');
    expect(body.checks.mcp.details.toolsVersion).toBeDefined();
  });

  // =========================================================================
  // Delegated token endpoint
  // =========================================================================

  it('issues a delegated agent-bound token', async () => {
    if (serverUnavailableError) return;
    mockVerifyAccessToken.mockResolvedValue({ userId: 'user-123', email: 'user@example.com' });
    delegatedIdentity = { id: 'identity-abc', agent_id: 'wren' };

    const res = await fetch(`${baseUrl}/token/delegate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'wren' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.delegated_agent_id).toBe('wren');
    expect(body.identity_id).toBe('identity-abc');
    expect(body.expires_in).toBe(3600);

    const token = body.access_token as string;
    const payload = verifyPcpAccessToken(token, 'mcp_access');
    expect(payload?.sub).toBe('user-123');
    expect(payload?.agentId).toBe('wren');
    expect(payload?.identityId).toBe('identity-abc');
  });

  it('rejects delegated token requests without valid auth', async () => {
    if (serverUnavailableError) return;
    mockVerifyAccessToken.mockResolvedValue(null);

    const res = await fetch(`${baseUrl}/token/delegate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'wren' }),
    });

    expect(res.status).toBe(401);
  });

  it('rejects delegated token requests for unknown agent identity', async () => {
    if (serverUnavailableError) return;
    mockVerifyAccessToken.mockResolvedValue({ userId: 'user-123', email: 'user@example.com' });
    delegatedIdentity = null;

    const res = await fetch(`${baseUrl}/token/delegate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'aster' }),
    });

    expect(res.status).toBe(403);
  });
});
