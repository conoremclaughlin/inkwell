/**
 * Tests for MCP Streamable HTTP transport session management.
 *
 * Spins up a real HTTP server with mocked internals (DataComposer, mini-apps,
 * tools) and validates multi-client session lifecycle via fetch.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('../config/env', () => ({
  env: {
    MCP_TRANSPORT: 'http',
    MCP_HTTP_PORT: 0, // will be overridden
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'test-key',
    SUPABASE_ANON_KEY: 'test-anon-key',
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
  setSessionContext: vi.fn(),
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

/** POST to the MCP endpoint, optionally with a session ID header. */
async function mcpPost(
  baseUrl: string,
  body: unknown,
  sessionId?: string,
): Promise<{ status: number; headers: Headers; body: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
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

describe('MCP StreamableHTTP Transport', () => {
  let server: MCPServer;
  let baseUrl: string;

  // Minimal DataComposer stub
  const mockDataComposer = {
    getClient: () => ({
      from: () => ({
        select: () => ({
          limit: () => ({ error: null }),
          eq: () => ({ single: () => ({ data: null, error: null }) }),
        }),
      }),
    }),
  } as any;

  beforeAll(async () => {
    server = new MCPServer(mockDataComposer);

    // Start on a random port
    const { env } = await import('../config/env');
    (env as any).MCP_HTTP_PORT = 0;
    (env as any).MCP_TRANSPORT = 'http';
    await server.start();

    const port = server.getPort();
    expect(port).toBeTruthy();
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await server.shutdown();
  });

  // =========================================================================
  // Session creation
  // =========================================================================

  it('should create a session on initialize and return mcp-session-id', async () => {
    const res = await mcpPost(baseUrl, INITIALIZE_REQUEST);

    expect(res.status).toBe(200);
    const sessionId = res.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    expect(sessionId).toMatch(/^pcp-/);

    const result = parseSSEResult(res.body) as any;
    expect(result.result.serverInfo.name).toBe('personal-context-protocol');
    expect(result.result.protocolVersion).toBe('2025-03-26');
  });

  // =========================================================================
  // Session persistence
  // =========================================================================

  it('should route follow-up requests to the correct session', async () => {
    // Initialize
    const initRes = await mcpPost(baseUrl, INITIALIZE_REQUEST);
    const sessionId = initRes.headers.get('mcp-session-id')!;

    // Follow-up with session ID — should succeed (not 404)
    const listRes = await mcpPost(baseUrl, makeToolsListRequest(2), sessionId);
    expect(listRes.status).toBe(200);
  });

  // =========================================================================
  // Multi-client isolation
  // =========================================================================

  it('should support multiple independent client sessions', async () => {
    // Create two clients
    const res1 = await mcpPost(baseUrl, INITIALIZE_REQUEST);
    const res2 = await mcpPost(baseUrl, { ...INITIALIZE_REQUEST, id: 10 });

    const sid1 = res1.headers.get('mcp-session-id')!;
    const sid2 = res2.headers.get('mcp-session-id')!;

    expect(sid1).not.toBe(sid2);

    // Both sessions work independently
    const list1 = await mcpPost(baseUrl, makeToolsListRequest(3), sid1);
    const list2 = await mcpPost(baseUrl, makeToolsListRequest(4), sid2);

    expect(list1.status).toBe(200);
    expect(list2.status).toBe(200);
  });

  // =========================================================================
  // Unknown session
  // =========================================================================

  it('should return 404 for unknown session ID', async () => {
    const res = await mcpPost(
      baseUrl,
      makeToolsListRequest(5),
      'pcp-nonexistent-session-id',
    );
    expect(res.status).toBe(404);

    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain('Session not found');
  });

  // =========================================================================
  // Session count tracking
  // =========================================================================

  it('should track active session count', async () => {
    const before = server.getActiveSessionCount();

    const res = await mcpPost(baseUrl, INITIALIZE_REQUEST);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();

    expect(server.getActiveSessionCount()).toBeGreaterThan(before);
  });

  // =========================================================================
  // DELETE session termination
  // =========================================================================

  it('should terminate a session via DELETE', async () => {
    // Create a session
    const initRes = await mcpPost(baseUrl, INITIALIZE_REQUEST);
    const sessionId = initRes.headers.get('mcp-session-id')!;
    const countBefore = server.getActiveSessionCount();

    // Delete it
    const deleteRes = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId },
    });
    expect(deleteRes.status).toBe(200);

    // Session should be gone
    expect(server.getActiveSessionCount()).toBeLessThan(countBefore);

    // Follow-up should 404
    const followUp = await mcpPost(baseUrl, makeToolsListRequest(6), sessionId);
    expect(followUp.status).toBe(404);
  });

  // =========================================================================
  // GET without session
  // =========================================================================

  it('should return 400 on GET without session ID', async () => {
    const res = await fetch(`${baseUrl}/mcp`);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('mcp-session-id');
  });

  // =========================================================================
  // Health check
  // =========================================================================

  it('should report active sessions in health check', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('healthy');
    expect(body.checks.mcp.details.activeSessions).toBeGreaterThanOrEqual(0);
    expect(body.checks.mcp.details.toolsVersion).toBeDefined();
  });
});
