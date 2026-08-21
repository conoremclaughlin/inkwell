/**
 * Signed-claim handoff, driven through the REAL entrypoints.
 *
 * Contact isolation depends on a claim surviving a chain: SessionService
 * mapping a session onto token claims, the token being signed and verified,
 * and the MCP HTTP middleware snapshotting the result into AsyncLocalStorage.
 * A break anywhere in it is silent — the runner simply looks owner-scoped and
 * is refused the conversation it was spawned for.
 *
 * The first version of this file called `signRunnerAccessToken` directly and
 * spread `tokenIdentityContext()` by hand. That reassembled the chain inside
 * the test, so it proved the pieces compose when the TEST wires them and
 * nothing about the wiring in production: deleting `contactId: session.contactId`
 * from SessionService, or the whole `Object.assign(ctx, tokenIdentityContext(...))`
 * from the server middleware, both left it green at 9/9 (Lumen, PR #501 round 5).
 *
 * So this version touches neither. It mints the bearer through
 * SessionService's real token minter and spends it against a real MCPServer
 * over real HTTP, with the real tool registry and the real auth provider.
 * Only the database is a stub.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

vi.mock('../../config/env', () => ({
  env: {
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-characters-long',
    MCP_TRANSPORT: 'http',
    MCP_HTTP_PORT: 0,
    MCP_REQUIRE_OAUTH: false,
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'test-key',
    SUPABASE_ANON_KEY: 'test-anon-key',
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../mini-apps', () => ({
  loadMiniApps: vi.fn(() => new Map()),
  registerMiniAppTools: vi.fn(),
  getMiniAppsInfo: vi.fn(() => []),
}));

vi.mock('../../routes/admin', () => {
  const { Router } = require('express');
  return { default: Router(), setWhatsAppListener: vi.fn() };
});

vi.mock('../../channels/agent-gateway', () => ({
  getAgentGateway: vi.fn(() => ({
    registerHandler: vi.fn(),
    setDefaultHandler: vi.fn(),
    getRegisteredAgents: vi.fn(() => []),
  })),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ auth: {}, from: vi.fn() })),
}));

// User lookup is database work; the identity under test rides the token.
vi.mock('../../services/user-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/user-resolver')>();
  return {
    ...actual,
    resolveUserOrThrow: vi
      .fn()
      .mockResolvedValue({ user: { id: 'user-123' }, resolvedBy: 'userId' }),
  };
});

// Deliberately NOT mocked: ./tools (real handlers), ../auth/pcp-auth-provider
// (real verification), ../../utils/request-context (real AsyncLocalStorage),
// ../../auth/pcp-tokens (real signing), and SessionService's token minter.
import { MCPServer } from '../server';
import { SessionService } from '../../services/sessions/session-service';

const USER_ID = 'user-123';
const TARGET_UUID = '95f7f160-6599-449d-9f63-e31ca20a43ce';

const ownerSession = {
  id: 'session-owner',
  userId: USER_ID,
  agentId: 'myra',
  sbId: 'sb-myra',
  startedAt: new Date('2026-08-20T10:00:00Z'),
  metadata: {},
};
const contactA = { ...ownerSession, id: 'session-contact-a', contactId: 'contact-a' };
const contactB = { ...ownerSession, id: 'session-contact-b', contactId: 'contact-b' };

let getSession: ReturnType<typeof vi.fn>;
let updateSession: ReturnType<typeof vi.fn>;
let server: MCPServer;
let baseUrl: string;
let unavailable: Error | null = null;

/** Permissive Supabase stand-in: nothing here is under test. */
function stubClient(): never {
  const make = (): never =>
    new Proxy(function () {} as never, {
      get: (_t, prop) =>
        prop === 'then'
          ? (resolve: (v: unknown) => unknown) =>
              Promise.resolve(resolve({ data: null, error: null }))
          : make(),
      apply: () => make(),
    }) as never;
  return make();
}

const dataComposer = {
  getClient: () => stubClient(),
  repositories: {
    memory: {
      getSession: (...a: unknown[]) => getSession(...a),
      updateSession: (...a: unknown[]) => updateSession(...a),
      findOwnedActiveSessions: vi.fn().mockResolvedValue([]),
      getActiveSession: vi.fn().mockResolvedValue(null),
      getSessionLogs: vi.fn().mockResolvedValue([]),
      remember: vi.fn(),
    },
    workspaces: { findById: vi.fn(async () => null) },
    projects: { findAllByUser: vi.fn(async () => []) },
    tasks: { create: vi.fn() },
    activityStream: { logActivity: vi.fn(async () => ({ id: 'a1' })) },
  },
} as never;

/**
 * A bearer minted by the REAL SessionService mapping. Reaching the private
 * method without the constructor's dependency graph — the mapping is what is
 * under test, not the service's lifecycle.
 */
function runnerBearer(session: { id: string; sbId?: string; contactId?: string }): string {
  process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters-long';
  const minter = Object.create(SessionService.prototype) as {
    createRunnerAccessToken(
      userId: string,
      agentId: string,
      email: string,
      session: { id: string; sbId?: string; contactId?: string }
    ): string | undefined;
  };
  const token = minter.createRunnerAccessToken(USER_ID, 'myra', 'test@test.com', session);
  if (!token) throw new Error('SessionService declined to mint a runner token');
  return token;
}

/** Call a tool over real HTTP with a real bearer, and read the tool's payload. */
async function callTool(
  token: string,
  args: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'update_session_state', arguments: args },
      id: 1,
    }),
  });
  const text = await res.text();
  const line = text.match(/^data: (.+)$/m);
  const payload = JSON.parse(line ? line[1] : text);
  if (payload.error) throw new Error(`JSON-RPC error: ${JSON.stringify(payload.error)}`);
  return JSON.parse(payload.result.content[0].text);
}

beforeAll(async () => {
  server = new MCPServer(dataComposer);
  try {
    await server.start();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (err.message.includes('EPERM: operation not permitted')) {
      unavailable = err;
      return;
    }
    throw err;
  }
  const port = server.getPort();
  if (!port) {
    unavailable = new Error('MCP HTTP server failed to bind a port');
    return;
  }
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  if (!unavailable && server) await server.shutdown();
});

beforeEach(() => {
  getSession = vi.fn();
  updateSession = vi.fn().mockResolvedValue(ownerSession);
});

/**
 * Report an unbindable environment as SKIPPED, never as passed. An early
 * `return` here would turn "the server never started" into a green suite —
 * the same shape of silent success this whole file exists to rule out.
 */
function requireServer(ctx: { skip: () => void }): void {
  if (unavailable) ctx.skip();
}

describe('contact isolation, end to end through the real MCP HTTP path', () => {
  it('lets a contact runner update its own contact session', async (ctx) => {
    requireServer(ctx);
    getSession.mockResolvedValue(contactA);
    updateSession.mockResolvedValue(contactA);

    const result = await callTool(runnerBearer(contactA), {
      sessionId: TARGET_UUID,
      context: 'own contact',
    });

    expect(result.success).toBe(true);
  });

  it('refuses the same runner another contact under the same identity', async (ctx) => {
    requireServer(ctx);
    getSession.mockResolvedValue(contactB);

    const result = await callTool(runnerBearer(contactA), {
      sessionId: TARGET_UUID,
      context: 'into contact B',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not authorized/i);
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('refuses a contact runner an owner session', async (ctx) => {
    requireServer(ctx);
    getSession.mockResolvedValue(ownerSession);

    const result = await callTool(runnerBearer(contactA), {
      sessionId: TARGET_UUID,
      context: 'contact into owner',
    });

    expect(result.success).toBe(false);
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('lets an owner runner update its owner session', async (ctx) => {
    requireServer(ctx);
    getSession.mockResolvedValue(ownerSession);

    const result = await callTool(runnerBearer(ownerSession), {
      sessionId: TARGET_UUID,
      context: 'owner',
    });

    expect(result.success).toBe(true);
  });

  it('refuses a peer identity even with a valid bearer', async (ctx) => {
    requireServer(ctx);
    getSession.mockResolvedValue({ ...ownerSession, agentId: 'lumen', sbId: 'sb-lumen' });

    const result = await callTool(runnerBearer(ownerSession), {
      sessionId: TARGET_UUID,
      context: 'peer',
    });

    expect(result.success).toBe(false);
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('ignores a forged x-ink-context claiming the other contact', async (ctx) => {
    requireServer(ctx);
    getSession.mockResolvedValue(contactB);

    const forged = Buffer.from(
      JSON.stringify({
        sessionId: 'session-contact-b',
        studioId: 'main',
        agentId: 'myra',
        cliAttached: false,
        runtime: 'claude',
      })
    ).toString('base64url');

    const result = await callTool(
      runnerBearer(contactA),
      { sessionId: TARGET_UUID, context: 'forged header' },
      { 'x-ink-context': forged }
    );

    expect(result.success).toBe(false);
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('locks a contact runner out of its OWN session if the contact claim goes missing', async (ctx) => {
    // The symptom of a break anywhere upstream. Asserting it means a
    // regression in the SessionService mapping, the signer, the verifier or
    // the middleware surfaces here rather than in production.
    requireServer(ctx);
    getSession.mockResolvedValue(contactA);

    const result = await callTool(
      runnerBearer({ id: contactA.id, sbId: contactA.sbId }), // no contactId
      { sessionId: TARGET_UUID, context: 'claim dropped' }
    );

    expect(result.success).toBe(false);
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('resolves an implicit call to the signed session', async (ctx) => {
    requireServer(ctx);
    getSession.mockImplementation(async (id: string) =>
      id === 'session-contact-a' ? contactA : contactB
    );
    updateSession.mockResolvedValue(contactA);

    const result = await callTool(runnerBearer(contactA), { context: 'implicit' });

    expect(result.success).toBe(true);
    expect(updateSession).toHaveBeenCalledWith(
      'session-contact-a',
      expect.objectContaining({ context: 'implicit' })
    );
  });
});
