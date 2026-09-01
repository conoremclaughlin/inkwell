/**
 * POST /threads — start (or continue) a thread with explicit participants.
 *
 * The counterpart of /threads/reply, which refuses to create. Pinned here:
 *  - the key grammar and recipient bounds are checked before anything is sent;
 *  - the human is the sender (no senderAgentId), the title rides as subject,
 *    every recipient is woken;
 *  - `created` reports whether the key was new, so the client can say
 *    "started" vs "added to" honestly;
 *  - a handler result with nothing stored is the caller's 400, not a 200.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mockHandleSendToInbox = vi.fn();

vi.mock('../mcp/tools/inbox-handlers', () => ({
  handleSendToInbox: (...args: unknown[]) => mockHandleSendToInbox(...args),
}));
vi.mock('../mcp/tools/thread-handlers', () => ({ getParticipants: vi.fn() }));

vi.mock('../auth/pcp-tokens', () => ({
  signPcpAccessToken: vi.fn(),
  createRefreshToken: vi.fn(),
  exchangeRefreshToken: vi.fn(),
  verifyPcpAccessToken: vi.fn(),
}));

const mockSupabaseFrom = vi.fn();
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ auth: {}, from: mockSupabaseFrom })),
}));

const mockGetClient = vi.fn(() => ({ from: mockSupabaseFrom }));
vi.mock('../data/composer', () => ({
  getDataComposer: vi.fn(async () => ({ repositories: {}, getClient: mockGetClient })),
}));
vi.mock('../services/authorization', () => ({ getAuthorizationService: vi.fn(() => ({})) }));
vi.mock('../services/oauth', () => ({ getOAuthService: vi.fn(() => ({})) }));

vi.mock('../config/env', () => ({
  env: {
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'test-secret',
    SUPABASE_PUBLISHABLE_KEY: 'test-publishable',
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-characters-long',
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

function getCreateHandler(): Handler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === '/threads' && entry.route?.methods?.post
  );
  if (!layer) throw new Error('POST /threads not found in router stack');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createReq(body: Record<string, unknown>): Request {
  return { body, headers: {}, cookies: {}, params: {}, pcpUserId: 'user-1' } as unknown as Request;
}

interface MockResponse extends Response {
  _status: number;
  _json: unknown;
}

function createRes(): MockResponse {
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

function mockThreadLookup(thread: Record<string, unknown> | null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: Record<string, any> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data: thread, error: null }));
  mockSupabaseFrom.mockImplementation(() => chain);
  return chain;
}

function sendToInboxResult(payload: Record<string, unknown>) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

const create = getCreateHandler();

beforeEach(() => {
  vi.clearAllMocks();
  mockGetClient.mockReturnValue({ from: mockSupabaseFrom });
});

describe('POST /threads', () => {
  it('rejects malformed keys, empty content, and out-of-range recipients', async () => {
    const cases: Array<Record<string, unknown>> = [
      { key: 'no-colon', recipients: ['wren'], content: 'hi' },
      { key: 'pr:', recipients: ['wren'], content: 'hi' },
      { key: 'pr 545', recipients: ['wren'], content: 'hi' },
      { key: 'pr:545', recipients: ['wren'], content: '   ' },
      { key: 'pr:545', recipients: [], content: 'hi' },
      { key: 'pr:545', recipients: Array.from({ length: 17 }, (_, i) => `a${i}`), content: 'hi' },
      { key: 'pr:545', recipients: ['wren'], content: 'hi', priority: 'asap' },
    ];
    for (const body of cases) {
      const res = createRes();
      await create(createReq(body), res);
      expect(res._status, JSON.stringify(body)).toBe(400);
    }
    expect(mockHandleSendToInbox).not.toHaveBeenCalled();
  });

  it('starts a new thread: human sender, title as subject, every recipient woken', async () => {
    mockThreadLookup(null);
    mockHandleSendToInbox.mockResolvedValue(
      sendToInboxResult({ success: true, messageId: 'msg-1', threadId: 'thread-new' })
    );

    const res = createRes();
    await create(
      createReq({
        key: 'chat:wren',
        recipients: ['Wren', 'wren', 'lumen'],
        content: 'morning — where are we on #557?',
        title: 'Wren',
        priority: 'high',
      }),
      res
    );

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      success: true,
      created: true,
      messageId: 'msg-1',
      threadId: 'thread-new',
      threadKey: 'chat:wren',
    });

    const args = mockHandleSendToInbox.mock.calls[0][0] as Record<string, unknown>;
    expect(args).toMatchObject({
      userId: 'user-1',
      threadKey: 'chat:wren',
      content: 'morning — where are we on #557?',
      recipients: ['wren', 'lumen'], // normalised + de-duplicated
      triggerAll: true,
      subject: 'Wren',
      priority: 'high',
    });
    expect(args.senderAgentId).toBeUndefined();
    expect(args.metadata).toMatchObject({ sentBy: 'user' });
  });

  it('continues an existing thread and says so', async () => {
    mockThreadLookup({ id: 'thread-old' });
    mockHandleSendToInbox.mockResolvedValue(
      sendToInboxResult({ success: true, messageId: 'msg-2', threadId: 'thread-old' })
    );

    const res = createRes();
    await create(createReq({ key: 'pr:545', recipients: ['aster'], content: 'add aster' }), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ created: false, threadId: 'thread-old' });
  });

  it('turns a nothing-stored handler result into a 400 with the reason', async () => {
    mockThreadLookup(null);
    mockHandleSendToInbox.mockResolvedValue(
      sendToInboxResult({ success: false, error: 'Unknown recipient: nobody' })
    );

    const res = createRes();
    await create(createReq({ key: 'chat:nobody', recipients: ['nobody'], content: 'hi' }), res);

    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'Unknown recipient: nobody' });
  });

  it('reports success when the message stored even though a wake failed', async () => {
    mockThreadLookup(null);
    mockHandleSendToInbox.mockResolvedValue(
      sendToInboxResult({ success: false, messageId: 'msg-3', threadId: 'thread-3' })
    );

    const res = createRes();
    await create(createReq({ key: 'chat:wren', recipients: ['wren'], content: 'hi' }), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ success: true, created: true, messageId: 'msg-3' });
  });
});
