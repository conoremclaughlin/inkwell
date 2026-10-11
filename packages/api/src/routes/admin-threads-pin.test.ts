/**
 * PUT /threads/pin through the real admin route, with only the database
 * (FakePostgrest) and the server's collaborators faked. The service's exact
 * query is pinned in services/threads/thread-pins.test.ts; this file holds
 * the route to its status codes, its role gate, and the rows it changes:
 * the viewer's own row on that thread and nothing else.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { FakePostgrest, type Row } from '../test/fake-postgrest';

const ME = '11111111-1111-4111-8111-111111111111';
const SOMEONE = '22222222-2222-4222-8222-222222222222';
const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_WS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let db: FakePostgrest;

vi.mock('../mcp/tools/inbox-handlers', () => ({ handleSendToInbox: vi.fn() }));
vi.mock('../mcp/tools/thread-handlers', () => ({ getParticipants: vi.fn() }));
vi.mock('../auth/ink-tokens', () => ({
  signInkAccessToken: vi.fn(),
  createRefreshToken: vi.fn(),
  exchangeRefreshToken: vi.fn(),
  verifyInkAccessToken: vi.fn(),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => db) }));
vi.mock('../data/composer', () => ({
  getDataComposer: vi.fn(async () => ({ repositories: {}, getClient: () => db })),
}));
vi.mock('../services/authorization', () => ({ getAuthorizationService: vi.fn(() => ({})) }));
vi.mock('../services/oauth', () => ({ getOAuthService: vi.fn(() => ({})) }));
vi.mock('../config/env', async () => ({
  env: {
    ...(await import('../test/fake-env')).fakeEnv,
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

function pinHandler(): Handler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === '/threads/pin' && entry.route?.methods?.put
  );
  if (!layer) throw new Error('PUT /threads/pin not found in router stack');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function put(
  body: unknown,
  as: { userId?: string; role?: string; workspaceId?: string } = {}
): Promise<{ status: number; body: Row }> {
  const answer = { status: 200, body: {} as Row };
  const res = {
    status(n: number) {
      answer.status = n;
      return res;
    },
    json(r: Row) {
      answer.body = r;
      return res;
    },
  };
  await pinHandler()(
    {
      body,
      query: {},
      headers: {},
      cookies: {},
      params: {},
      inkUserId: as.userId ?? ME,
      inkWorkspaceId: as.workspaceId ?? WS,
      inkWorkspaceRole: as.role ?? 'owner',
    } as unknown as Request,
    res as unknown as Response
  );
  return answer;
}

let seq = 0;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function thread(key: string, people: string[], sbIds: string[] = [], workspaceId = WS): Row {
  const t = db.seed('inbox_threads', {
    id: uuid(++seq),
    thread_key: key,
    workspace_id: workspaceId,
    status: 'open',
  });
  for (const userId of people) {
    db.seed('inbox_thread_participants', {
      thread_id: t.id,
      user_id: userId,
      sb_id: null,
      pinned: null,
    });
  }
  for (const sbId of sbIds) {
    db.seed('inbox_thread_participants', {
      thread_id: t.id,
      user_id: null,
      sb_id: sbId,
      pinned: null,
    });
  }
  return t;
}

const pinOf = (threadId: unknown, userId: string) =>
  db.rows('inbox_thread_participants').find((r) => r.thread_id === threadId && r.user_id === userId)
    ?.pinned;

let shared: Row;
let otherShared: Row;
let background: Row;

beforeEach(() => {
  db = new FakePostgrest();
  seq = 0;
  shared = thread('chat:pip', [ME, SOMEONE], [uuid(900)]);
  otherShared = thread('thread:team', [ME, SOMEONE]);
  background = thread('thread:background', [SOMEONE], [uuid(901)]);
});

describe('PUT /threads/pin', () => {
  it("sets the viewer's own pin through each state and answers with it", async () => {
    for (const pinned of [true, false, null]) {
      expect(await put({ threadKey: 'chat:pip', pinned })).toEqual({
        status: 200,
        body: { threadKey: 'chat:pip', pinned },
      });
      expect(pinOf(shared.id, ME)).toBe(pinned);
    }
  });

  it("changes no one else's row and no other thread", async () => {
    await put({ threadKey: 'chat:pip', pinned: true });
    expect(pinOf(shared.id, ME)).toBe(true);
    expect(pinOf(shared.id, SOMEONE)).toBeNull();
    expect(pinOf(otherShared.id, ME)).toBeNull();
    const sbRows = db.rows('inbox_thread_participants').filter((r) => r.sb_id !== null);
    expect(sbRows.map((r) => r.pinned)).toEqual([null, null]);
    // One plain UPDATE on the participant table, filtered by thread and person.
    const writes = db.log.filter((entry) => entry.op !== 'select');
    expect(writes).toEqual([
      {
        table: 'inbox_thread_participants',
        op: 'update',
        filters: [`thread_id=${String(shared.id)}`, `user_id=${ME}`],
      },
    ]);
  });

  it('refuses a malformed body with 400 and a stable code, before any read', async () => {
    const cases: Array<[unknown, string]> = [
      [{ pinned: true }, 'invalid_thread_key'],
      [{ threadKey: '  ', pinned: true }, 'invalid_thread_key'],
      [undefined, 'invalid_thread_key'],
      [{ threadKey: 'chat:pip' }, 'invalid_pinned'],
      [{ threadKey: 'chat:pip', pinned: 'true' }, 'invalid_pinned'],
      [{ threadKey: 'chat:pip', pinned: 1 }, 'invalid_pinned'],
    ];
    for (const [body, code] of cases) {
      const answer = await put(body);
      expect(answer.status).toBe(400);
      expect(answer.body.code).toBe(code);
    }
    expect(db.log).toEqual([]);
  });

  it('refuses a role that cannot write threads with 403, writing nothing', async () => {
    const answer = await put({ threadKey: 'chat:pip', pinned: true }, { role: 'trusted' });
    expect(answer.status).toBe(403);
    expect(pinOf(shared.id, ME)).toBeNull();
    expect(db.log).toEqual([]);
  });

  it('refuses a thread the viewer is not in with 403 background_thread', async () => {
    const answer = await put({ threadKey: 'thread:background', pinned: true });
    expect(answer.status).toBe(403);
    expect(answer.body.code).toBe('background_thread');
    expect(db.rows('inbox_thread_participants').every((r) => r.pinned === null)).toBe(true);
    expect(background.id).toBeDefined();
  });

  it('answers 404 thread_not_found for an unknown key or one in another workspace', async () => {
    thread('thread:elsewhere', [ME], [], OTHER_WS);
    for (const threadKey of ['thread:nope', 'thread:elsewhere']) {
      const answer = await put({ threadKey, pinned: true });
      expect(answer.status).toBe(404);
      expect(answer.body.code).toBe('thread_not_found');
    }
    expect(db.rows('inbox_thread_participants').every((r) => r.pinned === null)).toBe(true);
  });
});
