/**
 * Thread-write ACL through the REAL admin auth middleware, the real
 * WorkspacesRepository and the real routes — only the DB and the send/reopen
 * side effects are mocked. The route suites inject `pcpWorkspaceRole`; this
 * one lets the middleware set it from the membership row, which is the only
 * way to catch a middleware that stamps every direct member 'member' (Lumen,
 * #619 — whose probe harness this follows).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { WorkspacesRepository } from '../data/repositories/workspaces.repository';

type MembershipRow = { id: string; user_id: string; workspace_id: string; role: string };

const state = vi.hoisted(() => ({
  /** The caller's workspace_members row; null = none; 'error' = the read fails. */
  membership: null as MembershipRow | null | 'error',
  /** x-ink-workspace-id on the request; undefined = the personal-workspace path. */
  header: 'ws-1' as string | undefined,
  participant: true,
  from: vi.fn(),
  send: vi.fn(),
  reopen: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: {}, from: state.from }),
}));
vi.mock('../data/composer', () => ({
  getDataComposer: async () => ({
    repositories: { workspaces: new WorkspacesRepository({ from: state.from } as never) },
    getClient: () => ({ from: state.from }),
  }),
}));
vi.mock('../auth/pcp-tokens', () => ({
  verifyPcpAccessToken: () => ({ sub: 'user-1', email: 'fixture@example.test' }),
  signPcpAccessToken: vi.fn(),
  createRefreshToken: vi.fn(),
  exchangeRefreshToken: vi.fn(),
}));
vi.mock('../mcp/tools/inbox-handlers', () => ({
  handleSendToInbox: (...args: unknown[]) => state.send(...args),
}));
vi.mock('../mcp/tools/thread-handlers', () => ({
  isParticipant: async () => state.participant,
  reopenThreadRow: (...args: unknown[]) => state.reopen(...args),
  getParticipants: async () => [{ sbId: 'sb-1', agentId: 'wren', userId: null }],
  participantSlugs: () => ['wren'],
}));
vi.mock('../services/authorization', () => ({
  // Nobody is trusted here: a caller without a membership row is refused.
  getAuthorizationService: () => ({ listTrustedUsers: async () => [] }),
}));
vi.mock('../services/oauth', () => ({ getOAuthService: () => ({}) }));
vi.mock('../config/env', () => ({
  env: {
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'test-secret',
    SUPABASE_PUBLISHABLE_KEY: 'test-publishable',
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-characters-long',
    NODE_ENV: 'test',
    MCP_HTTP_PORT: 3001,
  },
  isDevelopment: () => true,
}));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/request-context', () => ({
  runWithRequestContext: (_context: unknown, fn: () => void) => fn(),
}));

import router from './admin';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stack = (router as any).stack;
const auth = stack.find((entry: { name?: string }) => entry.name === 'adminAuthMiddleware').handle;

function request(path: string): Request {
  return {
    path,
    method: 'POST',
    headers: { authorization: 'Bearer fixture' },
    cookies: {},
    params: {},
    header: (name: string) => (name === 'x-ink-workspace-id' ? state.header : undefined),
    body: { key: 'pr:619', content: 'hello', recipients: ['wren'] },
  } as unknown as Request;
}

function response() {
  return {
    _status: 200,
    _json: null as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(data: unknown) {
      this._json = data;
      return this;
    },
    cookie() {
      return this;
    },
  };
}

async function throughAuth(path: string) {
  const req = request(path);
  const res = response();
  const next = vi.fn();
  await auth(req, res, next);
  if (!next.mock.calls.length) return { req: req as unknown as Record<string, unknown>, res };
  const handler = stack
    .find(
      (entry: { route?: { path?: string; methods?: Record<string, boolean> } }) =>
        entry.route?.path === path && entry.route?.methods?.post
    )
    .route.stack.at(-1).handle;
  await handler(req, res as unknown as Response);
  return { req: req as unknown as Record<string, unknown>, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.membership = {
    id: 'membership-1',
    user_id: 'user-1',
    workspace_id: 'ws-1',
    role: 'member',
  };
  state.header = 'ws-1';
  state.participant = true;
  state.reopen.mockResolvedValue({ reopened: true });
  state.send.mockResolvedValue({
    content: [
      {
        type: 'text',
        text: JSON.stringify({ success: true, messageId: 'msg-1', threadId: 'thread-1' }),
      },
    ],
  });
  state.from.mockImplementation((table: string) => {
    const rows: Record<string, unknown> = {
      workspaces: {
        id: 'ws-1',
        user_id: 'user-1',
        type: 'personal',
        name: 'Personal',
        slug: 'personal',
      },
      users: { id: 'user-1', telegram_id: null, whatsapp_id: null },
      inbox_threads: {
        id: 'thread-1',
        thread_key: 'pr:619',
        workspace_id: 'ws-1',
        status: 'closed',
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = {};
    for (const m of ['select', 'eq', 'is', 'order', 'limit', 'update']) q[m] = () => q;
    q.single = q.maybeSingle = async () => {
      if (table === 'workspace_members') {
        if (state.membership === 'error')
          return { data: null, error: { message: 'membership read failed' } };
        return { data: state.membership, error: null };
      }
      if (!(table in rows)) throw new Error(`Unexpected query: ${table}`);
      return { data: rows[table], error: null };
    };
    return q;
  });
});

function withRole(role: string) {
  state.membership = { id: 'membership-1', user_id: 'user-1', workspace_id: 'ws-1', role };
}

describe('thread writes through the real middleware (spec inkmail-thread-scope §1, §6)', () => {
  it.each(['viewer', 'member', 'admin', 'owner'])(
    "the request carries the membership row's role, not a stand-in: %s",
    async (role) => {
      withRole(role);
      const { req } = await throughAuth('/threads/reply');
      expect(req.pcpWorkspaceRole).toBe(role);
    }
  );

  it.each(['/threads', '/threads/reply', '/threads/reopen'])(
    'a real viewer cannot write via %s',
    async (path) => {
      withRole('viewer');
      const { res } = await throughAuth(path);
      expect(res._status).toBe(403);
      expect(res._json).toMatchObject({ role: 'viewer' });
      expect(state.send).not.toHaveBeenCalled();
      expect(state.reopen).not.toHaveBeenCalled();
    }
  );

  it.each(['admin', 'owner'])('a real %s recovers a thread they are not on', async (role) => {
    withRole(role);
    state.participant = false;
    const { res } = await throughAuth('/threads/reopen');
    expect(res._status).toBe(200);
    expect(state.reopen).toHaveBeenCalledTimes(1);
  });

  it('a real member cannot recover a thread they are not on', async () => {
    withRole('member');
    state.participant = false;
    const { res } = await throughAuth('/threads/reopen');
    expect(res._status).toBe(403);
    expect(state.reopen).not.toHaveBeenCalled();
  });

  it('with no workspace header the role comes from the personal workspace membership row', async () => {
    state.header = undefined;
    withRole('owner');
    state.participant = false;
    const { req, res } = await throughAuth('/threads/reopen');
    expect(req.pcpWorkspaceId).toBe('ws-1');
    expect(req.pcpWorkspaceRole).toBe('owner');
    expect(res._status).toBe(200);
  });

  it('with no workspace header and no membership row the request is refused — never stamped member', async () => {
    state.header = undefined;
    state.membership = null;
    const req = request('/threads');
    const res = response();
    const next = vi.fn();
    await auth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
  });

  it('a membership read that fails closes the door: 500, nothing written', async () => {
    state.membership = 'error';
    const { res } = await throughAuth('/threads');
    expect(res._status).toBe(500);
    expect(state.send).not.toHaveBeenCalled();
  });

  it('a workspace header with no membership row and no trusted grant is refused', async () => {
    state.membership = null;
    const req = request('/threads');
    const res = response();
    const next = vi.fn();
    await auth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
  });
});
