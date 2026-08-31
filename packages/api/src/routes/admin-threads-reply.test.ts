/**
 * POST /threads/reply — the human's way into a thread over HTTP.
 *
 * The route is a thin adapter over handleSendToInbox (the MCP tool's
 * handler), so what's worth pinning is the adaptation itself:
 *
 *  - it refuses to invent threads (404 on unknown key) — replying is "into
 *    the conversation I'm following", never a silent create;
 *  - recipients are the thread's OWN participants, and triggerAll wakes them —
 *    a reply nobody is woken for may never be seen;
 *  - metadata.sentBy = 'user' rides along, because the admin context has no
 *    agentId and 'unknown' alone can't be told apart from a real unknown.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mockHandleSendToInbox = vi.fn();
const mockGetParticipants = vi.fn();

vi.mock('../mcp/tools/inbox-handlers', () => ({
  handleSendToInbox: (...args: unknown[]) => mockHandleSendToInbox(...args),
}));
vi.mock('../mcp/tools/thread-handlers', () => ({
  getParticipants: (...args: unknown[]) => mockGetParticipants(...args),
}));

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

function getReplyHandler(): Handler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === '/threads/reply' && entry.route?.methods?.post
  );
  if (!layer) throw new Error('POST /threads/reply not found in router stack');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createReq(body: Record<string, unknown>): Request {
  // pcpUserId is what adminAuthMiddleware attaches; the handler is driven
  // directly here, so it is injected.
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

/** inbox_threads chain: select().eq().eq().maybeSingle() → thread row. */
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

const reply = getReplyHandler();

beforeEach(() => {
  vi.clearAllMocks();
  mockGetClient.mockReturnValue({ from: mockSupabaseFrom });
});

describe('POST /threads/reply', () => {
  it('rejects a missing key or empty content', async () => {
    let res = createRes();
    await reply(createReq({ content: 'hi' }), res);
    expect(res._status).toBe(400);

    res = createRes();
    await reply(createReq({ key: 'pr:545', content: '   ' }), res);
    expect(res._status).toBe(400);

    expect(mockHandleSendToInbox).not.toHaveBeenCalled();
  });

  it('404s on a thread key that does not exist — no silent thread creation', async () => {
    mockThreadLookup(null);

    const res = createRes();
    await reply(createReq({ key: 'pr:99999', content: 'hello?' }), res);

    expect(res._status).toBe(404);
    expect(mockHandleSendToInbox).not.toHaveBeenCalled();
  });

  it('409s when the thread has no participants to wake', async () => {
    mockThreadLookup({ id: 'thread-1', thread_key: 'pr:545', status: 'open' });
    mockGetParticipants.mockResolvedValue([]);

    const res = createRes();
    await reply(createReq({ key: 'pr:545', content: 'anyone?' }), res);

    expect(res._status).toBe(409);
    expect(mockHandleSendToInbox).not.toHaveBeenCalled();
  });

  it('sends via handleSendToInbox with participants as recipients and triggerAll', async () => {
    mockThreadLookup({ id: 'thread-1', thread_key: 'pr:545', status: 'open' });
    mockGetParticipants.mockResolvedValue(['wren', 'lumen']);
    mockHandleSendToInbox.mockResolvedValue(
      sendToInboxResult({ success: true, messageId: 'msg-9', threadId: 'thread-1' })
    );

    const res = createRes();
    await reply(createReq({ key: 'pr:545', content: 'ship it', priority: 'high' }), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ success: true, messageId: 'msg-9', threadId: 'thread-1' });

    expect(mockHandleSendToInbox).toHaveBeenCalledTimes(1);
    const args = mockHandleSendToInbox.mock.calls[0][0] as Record<string, unknown>;
    expect(args).toMatchObject({
      userId: 'user-1',
      threadKey: 'pr:545',
      content: 'ship it',
      recipients: ['wren', 'lumen'],
      triggerAll: true,
      priority: 'high',
    });
    // No senderAgentId: the human IS the sender; the handler's non-agent
    // path depends on this being absent.
    expect(args.senderAgentId).toBeUndefined();
    expect(args.metadata).toMatchObject({ sentBy: 'user' });
  });

  it('reports success when the message stored even if every trigger failed', async () => {
    // The inbox handler folds trigger outcomes into its `success`; a user
    // whose reply IS in the thread must not be told the send failed just
    // because a wake bounced. Observed live: fresh user, both participants'
    // triggers failed, message stored — handler said success:false.
    mockThreadLookup({ id: 'thread-1', thread_key: 'pr:545', status: 'open' });
    mockGetParticipants.mockResolvedValue(['wren']);
    mockHandleSendToInbox.mockResolvedValue(
      sendToInboxResult({ success: false, messageId: 'msg-10', threadId: 'thread-1' })
    );

    const res = createRes();
    await reply(createReq({ key: 'pr:545', content: 'stored but not woken' }), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ success: true, messageId: 'msg-10' });
  });

  it('surfaces the handler failure instead of claiming success', async () => {
    mockThreadLookup({ id: 'thread-1', thread_key: 'pr:545', status: 'open' });
    mockGetParticipants.mockResolvedValue(['wren']);
    mockHandleSendToInbox.mockRejectedValue(new Error('insert failed'));

    const res = createRes();
    await reply(createReq({ key: 'pr:545', content: 'hello' }), res);

    expect(res._status).toBe(500);
  });
});
