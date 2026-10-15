/**
 * The space-turn session marker, against the real schema
 * (ink://specs/inkling-multi-person-groups, Phase 2 gate 1).
 *
 * The CHECK constraint allows only NULL or 'space-turn', and the MCP
 * server's bearer-less context fallback refuses a marked session. That the
 * marker never changes after insert is enforced in server code, not here
 * (session-turn-scope-writes.test.ts): the migration adds no trigger.
 *
 * Run via: yarn test:integration:db
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDataComposer, type DataComposer } from '../data/composer';
import { ensureEchoIntegrationFixture, ensureSuiteIdentity } from '../test/integration-fixtures';
import { createMCPServer, type MCPServer } from './server';
import { env } from '../config/env';

const SUITE_SLUG = 'turn-scope-suite';

describe('sessions.turn_scope', () => {
  let dataComposer: DataComposer;
  let userId: string;
  let sbId: string;
  let mcpServer: MCPServer;
  let baseUrl: string;
  let savedRequireOAuth: boolean;
  const createdSessionIds: string[] = [];

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    userId = fixture.userId;
    sbId = await ensureSuiteIdentity(dataComposer, fixture, SUITE_SLUG);

    // The fallback's refusal is observable as a 401 only when OAuth is
    // required; pin it for this server rather than depending on the shell.
    savedRequireOAuth = env.MCP_REQUIRE_OAUTH;
    (env as Record<string, unknown>).MCP_REQUIRE_OAUTH = true;
    const savedTransport = env.MCP_TRANSPORT;
    const savedPort = env.MCP_HTTP_PORT;
    (env as Record<string, unknown>).MCP_TRANSPORT = 'http';
    (env as Record<string, unknown>).MCP_HTTP_PORT = 0;
    mcpServer = await createMCPServer(dataComposer);
    await mcpServer.start();
    (env as Record<string, unknown>).MCP_TRANSPORT = savedTransport;
    (env as Record<string, unknown>).MCP_HTTP_PORT = savedPort;
    const port = mcpServer.getPort();
    expect(port).not.toBeNull();
    baseUrl = `http://localhost:${port}`;
  }, 30_000);

  afterAll(async () => {
    if (createdSessionIds.length > 0) {
      // Ending a session changes only ended_at; the marker stays as inserted.
      await dataComposer
        .getClient()
        .from('sessions')
        .update({ ended_at: new Date().toISOString() })
        .in('id', createdSessionIds)
        .is('ended_at', null);
    }
    (env as Record<string, unknown>).MCP_REQUIRE_OAUTH = savedRequireOAuth;
    await mcpServer?.shutdown();
  }, 30_000);

  async function insertSession(turnScope?: string | null) {
    const result = await dataComposer
      .getClient()
      .from('sessions')
      .insert({
        user_id: userId,
        agent_id: SUITE_SLUG,
        sb_id: sbId,
        lifecycle: 'running',
        ...(turnScope !== undefined ? { turn_scope: turnScope } : {}),
        metadata: { test: true, fixture: 'session-turn-scope' },
      })
      .select('id, turn_scope')
      .single();
    if (result.data?.id) createdSessionIds.push(result.data.id);
    return result;
  }

  describe('the CHECK constraint', () => {
    it('inserts a marked session', async () => {
      const { data, error } = await insertSession('space-turn');
      expect(error).toBeNull();
      expect(data!.turn_scope).toBe('space-turn');
    });

    it('refuses any other value at insert', async () => {
      const { error } = await insertSession('space-turns');
      expect(error?.code).toBe('23514');
    });
  });

  describe('the bearer-less context fallback', () => {
    async function initializeWithContext(sessionId: string) {
      const context = Buffer.from(
        JSON.stringify({
          sessionId,
          studioId: 'main',
          sbSlug: SUITE_SLUG,
          cliAttached: false,
          runtime: 'ink',
        })
      ).toString('base64url');
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'x-ink-context': context,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'turn-scope-integration', version: '1.0.0' },
          },
          id: 1,
        }),
      });
      await res.text();
      return res.status;
    }

    it('refuses a live marked session', async () => {
      const { data } = await insertSession('space-turn');
      expect(await initializeWithContext(data!.id)).toBe(401);
    });

    it('admits a live unmarked session (control)', async () => {
      const { data } = await insertSession();
      expect(await initializeWithContext(data!.id)).toBe(200);
    });
  });
});
