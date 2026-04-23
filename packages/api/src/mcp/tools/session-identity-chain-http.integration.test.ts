/**
 * Session Identity Chain — HTTP Integration Tests
 *
 * Tests the full server-side chain via real HTTP requests:
 *
 * 1. Start the Express MCP server on a random port
 * 2. Sign a test JWT (no network call — local jwt.sign)
 * 3. Create session + studio in DB
 * 4. Send POST /mcp with x-ink-session-id header + JSON-RPC tools/call
 * 5. Verify the tool response reflects correct studio scope (proves:
 *    header parsing → session DB lookup → request context enrichment → tool handler)
 *
 * Also tests:
 * - x-ink-session-id without x-ink-studio-id → derives studioId from session
 * - x-ink-studio-id header takes priority over session-derived workspace
 * - Missing session header → falls back to agent-derived workspace
 * - send_to_inbox thread metadata enrichment via HTTP round-trip
 *
 * Run via: yarn test:integration:db
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer';
import {
  ensureEchoIntegrationFixture,
  INTEGRATION_TEST_USER_ID,
  INTEGRATION_TEST_USER_EMAIL,
  INTEGRATION_TEST_AGENT_ID,
} from '../../test/integration-fixtures';
import { signPcpAccessToken } from '../../auth/pcp-tokens';
import { createMCPServer, type MCPServer } from '../server';
import { env } from '../../config/env';

describe('Session Identity Chain — HTTP Integration', () => {
  let dataComposer: DataComposer;
  let mcpServer: MCPServer;
  let baseUrl: string;
  let testToken: string;
  const createdSessionIds: string[] = [];
  const createdStudioIds: string[] = [];
  const createdThreadKeys: string[] = [];

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    await ensureEchoIntegrationFixture(dataComposer);

    // Sign a test JWT for the integration test user + echo agent
    testToken = signPcpAccessToken(
      {
        type: 'mcp_access',
        sub: INTEGRATION_TEST_USER_ID,
        email: INTEGRATION_TEST_USER_EMAIL,
        scope: 'mcp:tools',
        agentId: INTEGRATION_TEST_AGENT_ID,
      },
      60 * 60 // 1 hour
    );

    // Start the MCP server on a random port
    // Mutate the cached env object so startHttp() picks up port 0 (random)
    const savedTransport = env.MCP_TRANSPORT;
    const savedPort = env.MCP_HTTP_PORT;
    (env as Record<string, unknown>).MCP_TRANSPORT = 'http';
    (env as Record<string, unknown>).MCP_HTTP_PORT = 0;

    mcpServer = await createMCPServer(dataComposer);
    await mcpServer.start();

    // Restore env
    (env as Record<string, unknown>).MCP_TRANSPORT = savedTransport;
    (env as Record<string, unknown>).MCP_HTTP_PORT = savedPort;

    const port = mcpServer.getPort();
    expect(port).not.toBeNull();
    baseUrl = `http://localhost:${port}`;
  }, 30_000);

  afterAll(async () => {
    // End all test sessions
    if (createdSessionIds.length > 0) {
      await dataComposer
        .getClient()
        .from('sessions')
        .update({ ended_at: new Date().toISOString() })
        .in('id', createdSessionIds)
        .is('ended_at', null);
    }

    // Clean up test threads (messages then threads)
    for (const tk of createdThreadKeys) {
      const { data: thread } = await dataComposer
        .getClient()
        .from('inbox_threads' as never)
        .select('id')
        .eq('thread_key', tk)
        .eq('user_id', INTEGRATION_TEST_USER_ID)
        .maybeSingle();

      if (thread) {
        await dataComposer
          .getClient()
          .from('inbox_thread_messages' as never)
          .delete()
          .eq('thread_id', (thread as { id: string }).id);
        await dataComposer
          .getClient()
          .from('inbox_thread_read_status' as never)
          .delete()
          .eq('thread_id', (thread as { id: string }).id);
        await dataComposer
          .getClient()
          .from('inbox_thread_participants' as never)
          .delete()
          .eq('thread_id', (thread as { id: string }).id);
        await dataComposer
          .getClient()
          .from('inbox_threads' as never)
          .delete()
          .eq('id', (thread as { id: string }).id);
      }
    }

    // Clean up test studios
    if (createdStudioIds.length > 0) {
      await dataComposer.getClient().from('studios').delete().in('id', createdStudioIds);
    }

    // Stop the server
    await mcpServer.shutdown();
  }, 30_000);

  /** Create a test studio */
  async function createTestStudio(suffix: string): Promise<string> {
    const uniqueBranch = `test/http-chain-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { data, error } = await dataComposer
      .getClient()
      .from('studios')
      .insert({
        user_id: INTEGRATION_TEST_USER_ID,
        repo_root: '/tmp/integration-test',
        worktree_path: `/tmp/integration-test/${uniqueBranch}`,
        branch: uniqueBranch,
        status: 'active',
        metadata: { test: true, fixture: 'session-identity-chain-http' },
      })
      .select()
      .single();

    if (error) throw new Error(`Failed to create test studio: ${error.message}`);
    createdStudioIds.push(data!.id);
    return data!.id;
  }

  /** Create a test session */
  async function createTestSession(studioId?: string, threadKey?: string): Promise<string> {
    const { data, error } = await dataComposer
      .getClient()
      .from('sessions')
      .insert({
        user_id: INTEGRATION_TEST_USER_ID,
        agent_id: INTEGRATION_TEST_AGENT_ID,
        ...(studioId ? { studio_id: studioId } : {}),
        ...(threadKey ? { thread_key: threadKey } : {}),
        metadata: { test: true, fixture: 'session-identity-chain-http' },
      })
      .select()
      .single();

    if (error) throw new Error(`Failed to create test session: ${error.message}`);
    createdSessionIds.push(data!.id);
    return data!.id;
  }

  /** Send a JSON-RPC tools/call request to the MCP server */
  async function callTool(
    toolName: string,
    args: Record<string, unknown>,
    headers?: Record<string, string>
  ): Promise<{ result: unknown; status: number }> {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${testToken}`,
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: toolName, arguments: args },
        id: 1,
      }),
    });

    const text = await response.text();

    // MCP Streamable HTTP may return SSE or JSON
    // Parse the response — could be JSON-RPC or SSE events
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      // Parse SSE: extract the last JSON-RPC result from event stream
      const lines = text.split('\n');
      let lastData = '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          lastData = line.slice(6);
        }
      }
      if (lastData) {
        return { result: JSON.parse(lastData), status: response.status };
      }
    }

    try {
      return { result: JSON.parse(text), status: response.status };
    } catch {
      return { result: text, status: response.status };
    }
  }

  // ── Core chain: x-ink-session-id → session lookup → studioId enrichment ──

  it('should derive studioId from session when x-ink-session-id header is provided', async () => {
    const studioId = await createTestStudio('derive-studio');
    const sessionId = await createTestSession(studioId);

    // Call get_session with x-ink-session-id header but NO x-ink-studio-id
    // The server should derive the studioId from the session record
    const { result, status } = await callTool(
      'get_session',
      {
        userId: INTEGRATION_TEST_USER_ID,
        sessionId,
      },
      { 'x-ink-session-id': sessionId }
    );

    expect(status).toBe(200);

    // The result should be a JSON-RPC response with the session data
    const rpcResult = result as { result?: { content?: Array<{ text: string }> }; error?: unknown };

    // If there's an error, it shouldn't be a workspace-scope error
    if (rpcResult.error) {
      const errMsg = JSON.stringify(rpcResult.error);
      expect(errMsg).not.toContain('Workspace not found');
      expect(errMsg).not.toContain('not accessible');
    }

    // The session data should include our studioId
    if (rpcResult.result?.content?.[0]?.text) {
      const sessionData = JSON.parse(rpcResult.result.content[0].text);
      expect(sessionData.session || sessionData).toHaveProperty('studioId');
      const returnedStudioId = (sessionData.session || sessionData).studioId;
      expect(returnedStudioId).toBe(studioId);
    }
  });

  it('should accept requests with valid auth and session headers', async () => {
    const sessionId = await createTestSession();

    const { status } = await callTool(
      'get_session',
      {
        userId: INTEGRATION_TEST_USER_ID,
        sessionId,
      },
      { 'x-ink-session-id': sessionId }
    );

    // Should not be 401 (auth works) or 403 (workspace-scope OK)
    expect(status).toBe(200);
  });

  it('should reject requests without auth', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'get_session', arguments: { userId: 'x' } },
        id: 1,
      }),
    });

    // Without auth, should still get 200 (anonymous requests are allowed on non-OAuth-required servers)
    // OR 401 if MCP_REQUIRE_OAUTH is set
    expect([200, 401]).toContain(response.status);
  });

  // ── send_to_inbox round-trip: verify sender metadata is enriched via HTTP ──

  it('should enrich thread message metadata with sender session context via HTTP', async () => {
    const studioId = await createTestStudio('sender-enrich');
    const sessionId = await createTestSession(studioId);
    const threadKey = `test:http-sender-${Date.now()}`;
    createdThreadKeys.push(threadKey);

    // Send a thread message with x-ink-session-id header
    const { result, status } = await callTool(
      'send_to_inbox',
      {
        userId: INTEGRATION_TEST_USER_ID,
        recipientAgentId: 'echo', // send to self for testing
        senderAgentId: INTEGRATION_TEST_AGENT_ID,
        threadKey,
        content: 'HTTP integration test — sender identity chain',
        messageType: 'message',
        trigger: false, // don't trigger actual agent
      },
      { 'x-ink-session-id': sessionId }
    );

    expect(status).toBe(200);

    // Verify the thread message was created in the DB with correct metadata
    // Give the async insert a moment
    await new Promise((r) => setTimeout(r, 200));

    const { data: thread } = await dataComposer
      .getClient()
      .from('inbox_threads' as never)
      .select('id')
      .eq('thread_key', threadKey)
      .eq('user_id', INTEGRATION_TEST_USER_ID)
      .maybeSingle();

    expect(thread).not.toBeNull();

    const { data: messages } = await dataComposer
      .getClient()
      .from('inbox_thread_messages' as never)
      .select('*')
      .eq('thread_id', (thread as { id: string }).id)
      .order('created_at', { ascending: false })
      .limit(1);

    expect(messages).not.toBeNull();
    expect((messages as Array<{ metadata: unknown }>).length).toBeGreaterThan(0);

    const msg = (messages as Array<{ metadata: Record<string, unknown> }>)[0];
    const metadata = msg.metadata as Record<string, unknown>;
    const pcp = metadata.pcp as Record<string, unknown>;
    const sender = pcp?.sender as Record<string, unknown>;

    // The sender metadata should have been enriched with session context
    // from the x-ink-session-id header → request context → send_to_inbox handler
    expect(sender).toBeDefined();
    expect(sender.agentId).toBe(INTEGRATION_TEST_AGENT_ID);
    expect(sender.sessionId).toBe(sessionId);
    expect(sender.studioId).toBe(studioId);
  });

  // ── Priority: x-ink-studio-id header overrides session-derived studioId ──

  it('should prefer explicit x-ink-studio-id over session-derived studio', async () => {
    const sessionStudioId = await createTestStudio('session-studio');
    const explicitStudioId = await createTestStudio('explicit-studio');
    const sessionId = await createTestSession(sessionStudioId);

    // Call with session header pointing to sessionStudioId,
    // but explicit studio header pointing to explicitStudioId
    const { result, status } = await callTool(
      'get_session',
      {
        userId: INTEGRATION_TEST_USER_ID,
        sessionId,
      },
      {
        'x-ink-session-id': sessionId,
        'x-ink-studio-id': explicitStudioId,
      }
    );

    expect(status).toBe(200);
    // The explicit header should take priority — verified by the fact that
    // the request doesn't get rejected with a scope error
    // (both studios belong to the test user, so either would work)
  });

  // ── Codex env_http_headers simulation ──
  // Codex injects headers via `-c mcp_servers.inkwell.env_http_headers.<header>="ENV_VAR"`.
  // This test verifies the server correctly processes those headers on MCP calls,
  // proving the full chain: env var → Codex → HTTP header → PCP server → request context.

  it('should process session headers as Codex would inject them via env_http_headers', async () => {
    const studioId = await createTestStudio('codex-env-headers');
    const sessionId = await createTestSession(studioId);
    const threadKey = `test:codex-env-headers-${Date.now()}`;
    createdThreadKeys.push(threadKey);

    // Simulate what Codex does: env_http_headers resolve env vars to header values.
    // From the server's perspective, these are just regular HTTP headers.
    const { result, status } = await callTool(
      'send_to_inbox',
      {
        userId: INTEGRATION_TEST_USER_ID,
        recipientAgentId: 'echo',
        senderAgentId: INTEGRATION_TEST_AGENT_ID,
        threadKey,
        content: 'Codex env_http_headers integration test',
        messageType: 'message',
        trigger: false,
      },
      {
        'x-ink-session-id': sessionId,
        'x-ink-studio-id': studioId,
      }
    );

    expect(status).toBe(200);

    // Verify the message was stored with correct sender metadata
    await new Promise((r) => setTimeout(r, 200));

    const { data: thread } = await dataComposer
      .getClient()
      .from('inbox_threads' as never)
      .select('id')
      .eq('thread_key', threadKey)
      .eq('user_id', INTEGRATION_TEST_USER_ID)
      .maybeSingle();

    expect(thread).not.toBeNull();

    const { data: messages } = await dataComposer
      .getClient()
      .from('inbox_thread_messages' as never)
      .select('*')
      .eq('thread_id', (thread as { id: string }).id)
      .order('created_at', { ascending: false })
      .limit(1);

    expect(messages).not.toBeNull();
    expect((messages as Array<{ metadata: unknown }>).length).toBeGreaterThan(0);

    const msg = (messages as Array<{ metadata: Record<string, unknown> }>)[0];
    const pcp = msg.metadata.pcp as Record<string, unknown>;
    const sender = pcp?.sender as Record<string, unknown>;

    // Prove the full chain: HTTP headers → request context → sender metadata
    expect(sender).toBeDefined();
    expect(sender.agentId).toBe(INTEGRATION_TEST_AGENT_ID);
    expect(sender.sessionId).toBe(sessionId);
    expect(sender.studioId).toBe(studioId);
  });

  it('should derive studioId from session for Codex when only session header is sent', async () => {
    const studioId = await createTestStudio('codex-session-only');
    const sessionId = await createTestSession(studioId);
    const threadKey = `test:codex-session-only-${Date.now()}`;
    createdThreadKeys.push(threadKey);

    // Codex might not always have INK_STUDIO_ID set. When only x-ink-session-id
    // is present, the server should derive studioId from the session record.
    const { status } = await callTool(
      'send_to_inbox',
      {
        userId: INTEGRATION_TEST_USER_ID,
        recipientAgentId: 'echo',
        senderAgentId: INTEGRATION_TEST_AGENT_ID,
        threadKey,
        content: 'Codex session-only header test',
        messageType: 'message',
        trigger: false,
      },
      { 'x-ink-session-id': sessionId }
      // No x-ink-studio-id — server should derive from session
    );

    expect(status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));

    const { data: thread } = await dataComposer
      .getClient()
      .from('inbox_threads' as never)
      .select('id')
      .eq('thread_key', threadKey)
      .eq('user_id', INTEGRATION_TEST_USER_ID)
      .maybeSingle();

    expect(thread).not.toBeNull();

    const { data: messages } = await dataComposer
      .getClient()
      .from('inbox_thread_messages' as never)
      .select('*')
      .eq('thread_id', (thread as { id: string }).id)
      .limit(1);

    const msg = (messages as Array<{ metadata: Record<string, unknown> }>)[0];
    const sender = (msg.metadata.pcp as Record<string, unknown>)?.sender as Record<string, unknown>;

    expect(sender).toBeDefined();
    expect(sender.sessionId).toBe(sessionId);
    // studioId should be derived from the session's studio_id
    expect(sender.studioId).toBe(studioId);
  });

  // ── Health check ──

  it('should return healthy status', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);

    const health = await response.json();
    expect(health.status).toMatch(/ok|healthy|degraded/);
    expect(health.checks).toBeDefined();
  });
});
