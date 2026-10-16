/** Real HTTP router and allowlist; invented identities, DB and dispatch. No model. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  send: vi.fn(),
  from: vi.fn(),
  lookup: vi.fn(),
  record: vi.fn(),
  check: vi.fn(),
}));
vi.mock('../data/composer', () => ({
  getDataComposer: async () => ({ getClient: () => ({ from: mocks.from }) }),
}));
vi.mock('../services/inklings/inkling-service', () => ({
  InklingService: class {
    list = mocks.list;
  },
}));
vi.mock('../mcp/tools/inbox-handlers', () => ({ handleSendToInbox: mocks.send }));
vi.mock('../services/send-receipt', () => ({
  lookUpClientMessage: mocks.lookup,
  recordDelivery: mocks.record,
  deliveryFromSendResult: (sent: { routed?: boolean }) => ({
    status: sent.routed ? 'routed' : 'unknown',
  }),
  isClientMessageConflict: (error: unknown) =>
    error instanceof Error && error.message === 'fixture conflict',
}));
vi.mock('../services/browser-companion-grant.service', () => ({
  BrowserCompanionGrantService: class {
    checkGrant = mocks.check;
  },
  normalizePairingCode: (v: string) => v,
}));
vi.mock('../auth/browser-client-tokens', () => ({
  readBearerToken: (value?: string) => value?.replace(/^Bearer /, ''),
  verifyBrowserClientToken: (value: string) => (value === 'fixture-client' ? claims : null),
}));
vi.mock('../utils/logger', () => ({ logger: { error: vi.fn() } }));
import { createBrowserCompanionRouter } from './browser-companion';
import { browserChatKey } from './browser-chat';
const claims = {
  sub: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  grantId: '33333333-3333-4333-8333-333333333333',
  installationId: '44444444-4444-4444-8444-444444444444',
};
const inkling = {
  id: '55555555-5555-4555-8555-555555555555',
  sbSlug: 'fixture-inkling',
  displayName: 'Moss',
};
const operationId = '66666666-6666-4666-8666-666666666666';
let rows: Record<string, unknown>;
let queries: Array<{ table: string; filters: Array<[string, unknown]> }>;
let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/browser-companion', createBrowserCompanionRouter({} as never));
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('No listener.');
  base = `http://127.0.0.1:${addr.port}/api/browser-companion`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([inkling]);
  mocks.check.mockResolvedValue({ ok: true });
  mocks.lookup.mockResolvedValue({ kind: 'none' });
  mocks.send.mockResolvedValue({
    content: [
      { type: 'text', text: JSON.stringify({ messageId: 'fixture-message', routed: true }) },
    ],
  });
  rows = {
    inbox_threads: null,
    inbox_thread_participants: [{ sb_id: inkling.id, user_id: null }],
    inbox_thread_messages: [],
  };
  queries = [];
  mocks.from.mockImplementation((table: string) => {
    const query = { table, filters: [] as Array<[string, unknown]> };
    queries.push(query);
    const chain = {
      select: () => chain,
      eq: (name: string, value: unknown) => {
        query.filters.push([name, value]);
        return chain;
      },
      order: () => chain,
      limit: async () => ({ data: rows[table], error: null }),
      maybeSingle: async () => ({ data: rows[table], error: null }),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: rows[table], error: null }).then(resolve),
    };
    return chain;
  });
});
async function call(path: string, body?: unknown, token = 'fixture-client') {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
const send = (extra: Record<string, unknown> = {}) =>
  call('/chat/message', {
    inklingId: inkling.id,
    operationId,
    body: 'Hello from a synthetic panel.',
    ...extra,
  });
const history = () => call(`/chat/messages?inklingId=${inkling.id}`);
const existing = () => {
  rows.inbox_threads = { id: 'thread-fixture', created_by_user_id: claims.sub };
};

describe('installation-scoped hosted chat', () => {
  it.each([
    '/chat/inklings',
    `/chat/messages?inklingId=${inkling.id}`,
    `/chat/receipt?inklingId=${inkling.id}&operationId=${operationId}`,
  ])('requires browser credentials and a live grant on %s', async (path) => {
    expect((await call(path, undefined, 'admin-not-browser')).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
    mocks.check.mockResolvedValue({ ok: false, reason: 'revoked' });
    expect((await call(path)).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('requires a live grant on sends too', async () => {
    mocks.check.mockResolvedValue({ ok: false });
    expect((await send()).status).toBe(403);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('lists only the grant owner and workspace; omits slugs and metadata', async () => {
    expect((await call('/chat/inklings')).body).toEqual({
      inklings: [{ id: inkling.id, name: 'Moss' }],
    });
    expect(mocks.list).toHaveBeenCalledWith({
      userId: claims.sub,
      workspaceId: claims.workspaceId,
    });
  });
  it('does not create a conversation on read', async () => {
    expect((await history()).body).toEqual({
      threadKey: browserChatKey(claims.grantId, inkling.id),
      inkling: { id: inkling.id, name: 'Moss' },
      messages: [],
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(queries[0]?.filters).toEqual([
      ['workspace_id', claims.workspaceId],
      ['thread_key', browserChatKey(claims.grantId, inkling.id)],
    ]);
  });
  it('refuses unknown or foreign inklings without dispatch or thread reads', async () => {
    mocks.list.mockResolvedValue([]);
    expect((await history()).status).toBe(403);
    expect((await send()).status).toBe(403);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it.each(['workspaceId', 'userId', 'threadKey', 'sbSlug', 'runtime', 'pageBinding'])(
    'refuses a client-selected %s',
    async (key) => {
      expect((await send({ [key]: 'invented' })).status).toBe(400);
      expect(mocks.send).not.toHaveBeenCalled();
    }
  );
  it('refuses oversized/blank content and malformed IDs before DB access', async () => {
    for (const patch of [
      { body: ' ' },
      { body: 'a'.repeat(4001) },
      { inklingId: '../admin' },
      { operationId: 'not-an-id' },
    ])
      expect((await send(patch)).status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('uses the existing human inbox dispatch with the server-derived target', async () => {
    expect((await send()).body).toEqual({ operationId, status: 'queued', replayed: false });
    const [input, , internal] = mocks.send.mock.calls[0]!;
    expect(input).toMatchObject({
      recipientSlug: inkling.sbSlug,
      userId: claims.sub,
      threadKey: browserChatKey(claims.grantId, inkling.id),
      metadata: { clientMessageId: operationId },
    });
    expect(internal.sender).toEqual({
      principal: { kind: 'user', userId: claims.sub },
      workspaceId: claims.workspaceId,
    });
    expect(input).not.toHaveProperty('recipientSessionId');
  });
  it('reconciles a stored operation without waking twice', async () => {
    existing();
    mocks.lookup.mockResolvedValue({ kind: 'replay' });
    expect((await send()).body).toEqual({ operationId, status: 'stored', replayed: true });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('refuses changed words on the same operation', async () => {
    existing();
    mocks.lookup.mockResolvedValue({ kind: 'conflict' });
    expect((await send()).status).toBe(409);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('marks unproven routing as stored, never completed', async () => {
    mocks.send.mockResolvedValue({
      content: [{ type: 'text', text: '{"messageId":"fixture-message"}' }],
    });
    expect((await send()).body.status).toBe('stored');
  });
  it('does not leak errors or assert rejection after a failed dispatch', async () => {
    mocks.send.mockRejectedValue(new Error('private fixture detail'));
    expect(await send()).toEqual({ status: 503, body: { error: 'message_outcome_unknown' } });
  });
  it('refuses existing conversations owned by someone else', async () => {
    rows.inbox_threads = { id: 'thread-fixture', created_by_user_id: 'another-user' };
    expect((await history()).status).toBe(403);
    expect((await send()).status).toBe(403);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('refuses existing conversations with additional recipients', async () => {
    existing();
    rows.inbox_thread_participants = [{ sb_id: 'another-inkling', user_id: null }];
    expect((await history()).status).toBe(403);
    expect((await send()).status).toBe(403);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('returns bounded plain-text history with operation echoes, never metadata', async () => {
    existing();
    rows.inbox_thread_messages = [
      {
        id: 'message-id',
        sender_kind: 'user',
        sender_user_id: claims.sub,
        content: '<script>not HTML</script>',
        metadata: { clientMessageId: operationId, secret: 'invented-private' },
      },
    ];
    expect((await history()).body.messages).toEqual([
      { id: operationId, author: 'You', body: '<script>not HTML</script>', status: 'stored' },
    ]);
  });
  it('checks an exact receipt outside the history window; absence stays unknown', async () => {
    const path = `/chat/receipt?inklingId=${inkling.id}&operationId=${operationId}`;
    expect((await call(path)).body.status).toBe('unknown');
    existing();
    rows.inbox_thread_messages = { id: 'found' };
    expect((await call(path)).body.status).toBe('stored');
    expect(queries.at(-1)?.filters).toContainEqual(['metadata->>clientMessageId', operationId]);
    expect(queries.at(-1)?.filters).toContainEqual(['sender_user_id', claims.sub]);
  });
});
