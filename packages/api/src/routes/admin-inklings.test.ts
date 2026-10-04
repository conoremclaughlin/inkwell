/**
 * /api/admin/inklings: the Inkling app's awakening and naming (contract v3).
 *
 * The handlers are driven directly with the context adminAuthMiddleware
 * attaches, over the real InklingService and an in-memory database that
 * evaluates its filters (src/test/fake-postgrest.ts). Pinned here: the role
 * gate, body validation, the status each outcome answers with, and that
 * nothing here sends a message or wakes anyone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createInklingDb, seedOwnSb } from '../test/fake-inkling-db';
import type { FakePostgrest } from '../test/fake-postgrest';

const mockHandleSendToInbox = vi.fn();
vi.mock('../mcp/tools/inbox-handlers', () => ({
  handleSendToInbox: (...args: unknown[]) => mockHandleSendToInbox(...args),
}));
vi.mock('../mcp/tools/thread-handlers', () => ({ getParticipants: vi.fn() }));
vi.mock('../auth/ink-tokens', () => ({
  signInkAccessToken: vi.fn(),
  createRefreshToken: vi.fn(),
  exchangeRefreshToken: vi.fn(),
  verifyInkAccessToken: vi.fn(),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => {
    throw new Error('the inkling routes must use the composer client');
  }),
}));

let db: FakePostgrest;
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
import { trackInklingTurn } from '../services/inklings/inkling-turns';

type Handler = (req: Request, res: Response) => Promise<void>;

function handler(method: 'get' | 'post', path: string): Handler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`${method.toUpperCase()} ${path} not found in router stack`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const ME = '11111111-1111-4111-8111-111111111111';
const MY_WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_WORKSPACE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SOMEONE_ELSE = '22222222-2222-4222-8222-222222222222';
const REQUEST = '0b6f3c1e-5d1a-4a8e-9c1b-6f0e2d3c4b5a';

interface Ctx {
  role?: string;
  userId?: string;
  workspaceId?: string;
  params?: Record<string, string>;
}

function createReq(body: unknown, ctx: Ctx = {}): Request {
  return {
    body,
    headers: {},
    cookies: {},
    params: ctx.params ?? {},
    inkUserId: ctx.userId ?? ME,
    inkWorkspaceId: ctx.workspaceId ?? MY_WORKSPACE,
    inkWorkspaceRole: ctx.role ?? 'owner',
  } as unknown as Request;
}

interface MockResponse extends Response {
  _status: number;
  _json: Record<string, unknown>;
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

const list = handler('get', '/inklings');
const awaken = handler('post', '/inklings/awaken');
const name = handler('post', '/inklings/:id/name');

async function call(h: Handler, body: unknown, ctx?: Ctx): Promise<MockResponse> {
  const res = createRes();
  await h(createReq(body, ctx), res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  db = createInklingDb();
  // The owner test, open to ME: the server's gate is this env, read per request.
  vi.stubEnv('INKLING_OWNER_TEST_USER_ID', ME);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /inklings/awaken', () => {
  it('201 with a new inkling, then 200 with the same one for the same request id', async () => {
    const first = await call(awaken, { clientRequestId: REQUEST });
    expect(first._status).toBe(201);
    expect(first._json).toEqual({
      inkling: {
        id: expect.any(String),
        sbSlug: expect.any(String),
        displayName: null,
        createdAt: expect.any(String),
        nameable: true,
      },
      replayed: false,
    });

    const again = await call(awaken, { clientRequestId: REQUEST });
    expect(again._status).toBe(200);
    expect(again._json).toEqual({ inkling: first._json.inkling, replayed: true });
    expect(db.rows('agent_identities')).toHaveLength(1);
  });

  it('409 when the request id was already used in another workspace', async () => {
    await call(awaken, { clientRequestId: REQUEST });
    const res = await call(awaken, { clientRequestId: REQUEST }, { workspaceId: OTHER_WORKSPACE });
    expect(res._status).toBe(409);
    expect(db.rows('agent_identities')).toHaveLength(1);
  });

  it('400 without a UUID request id', async () => {
    for (const body of [{}, { clientRequestId: 'retry-1' }, { clientRequestId: 7 }, null]) {
      const res = await call(awaken, body);
      expect(res._status, JSON.stringify(body)).toBe(400);
    }
    expect(db.log).toEqual([]);
  });

  it('a viewer or trusted non-member gets 403, and nothing is read or written', async () => {
    for (const role of ['viewer', 'trusted']) {
      const res = await call(awaken, { clientRequestId: REQUEST }, { role });
      expect(res._status).toBe(403);
      expect(res._json).toMatchObject({ role });
    }
    expect(db.log).toEqual([]);
    // A member may write threads, but the owner test is the workspace owner's alone.
    const member = await call(awaken, { clientRequestId: REQUEST }, { role: 'member' });
    expect(member._status).toBe(403);
    expect(member._json).toMatchObject({ code: 'inklings_disabled' });
    expect(db.log).toEqual([]);
    const owner = await call(awaken, { clientRequestId: REQUEST });
    expect(owner._status).toBe(201);
  });

  it('wakes nobody: no message is sent and no thread table is touched', async () => {
    await call(awaken, { clientRequestId: REQUEST });
    expect(mockHandleSendToInbox).not.toHaveBeenCalled();
    expect(db.log.some((e) => e.table.startsWith('inbox_'))).toBe(false);
  });
});

describe('GET /inklings', () => {
  it('lists only inklings born through this flow, oldest first, and a viewer may read', async () => {
    seedOwnSb(db, { userId: ME, workspaceId: MY_WORKSPACE }, 'myra');
    const a = await call(awaken, { clientRequestId: REQUEST });
    const b = await call(awaken, { clientRequestId: '3c9d2a7e-8f41-4b6c-9a2d-1e0f5b4c3d2a' });

    const res = await call(list, undefined, { role: 'viewer' });
    expect(res._status).toBe(200);
    const idle = { state: 'idle', since: null };
    expect(res._json).toEqual({
      inklings: [
        { ...(a._json.inkling as object), activity: idle },
        { ...(b._json.inkling as object), activity: idle },
      ],
    });
  });

  it('is scoped to the resolved workspace', async () => {
    await call(awaken, { clientRequestId: REQUEST });
    const res = await call(list, undefined, { workspaceId: OTHER_WORKSPACE });
    expect(res._json).toEqual({ inklings: [] });
  });

  it("carries each inkling's own turn activity: working, stopping after Stop, idle when done", async () => {
    const cancel = handler('post', '/inklings/:id/cancel');
    const a = (await call(awaken, { clientRequestId: REQUEST }))._json.inkling as { id: string };
    const b = (await call(awaken, { clientRequestId: '3c9d2a7e-8f41-4b6c-9a2d-1e0f5b4c3d2a' }))
      ._json.inkling as { id: string };
    const activityOf = async (): Promise<Record<string, unknown>> => {
      const res = await call(list, undefined, { role: 'viewer' });
      const inklings = res._json.inklings as Array<{ id: string; activity: unknown }>;
      return Object.fromEntries(inklings.map((i) => [i.id, i.activity]));
    };

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-04T09:00:00.000Z'));
      const turn = trackInklingTurn(a.id);
      vi.setSystemTime(new Date('2026-10-04T09:02:00.000Z'));

      expect(await activityOf()).toEqual({
        [a.id]: { state: 'working', since: '2026-10-04T09:00:00.000Z' },
        [b.id]: { state: 'idle', since: null },
      });

      expect((await call(cancel, {}, { params: { id: a.id } }))._json).toEqual({
        cancelled: true,
      });
      expect(await activityOf()).toEqual({
        [a.id]: { state: 'stopping', since: '2026-10-04T09:00:00.000Z' },
        [b.id]: { state: 'idle', since: null },
      });

      turn.done();
      expect(await activityOf()).toEqual({
        [a.id]: { state: 'idle', since: null },
        [b.id]: { state: 'idle', since: null },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never reports another person's inkling, working or not", async () => {
    vi.stubEnv('INKLING_OWNER_TEST_USER_ID', SOMEONE_ELSE);
    const theirs = (
      await call(
        awaken,
        { clientRequestId: REQUEST },
        { userId: SOMEONE_ELSE, workspaceId: OTHER_WORKSPACE }
      )
    )._json.inkling as { id: string };
    vi.stubEnv('INKLING_OWNER_TEST_USER_ID', ME);
    const turn = trackInklingTurn(theirs.id);
    try {
      for (const workspaceId of [MY_WORKSPACE, OTHER_WORKSPACE]) {
        const res = await call(list, undefined, { workspaceId });
        expect(res._json, workspaceId).toEqual({ inklings: [] });
      }
    } finally {
      turn.done();
    }
  });
});

describe('POST /inklings/:id/cancel', () => {
  const cancel = handler('post', '/inklings/:id/cancel');

  it("stops its owner's live turn: 200 { cancelled }; a viewer gets 403; the test off is 403", async () => {
    const awakenedRes = await call(awaken, { clientRequestId: REQUEST });
    const id = (awakenedRes._json.inkling as { id: string }).id;
    const turn = trackInklingTurn(id);

    const viewer = await call(cancel, {}, { params: { id }, role: 'viewer' });
    expect(viewer._status).toBe(403);
    expect(turn.signal.aborted).toBe(false);

    const res = await call(cancel, {}, { params: { id } });
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ cancelled: true });
    expect(turn.signal.aborted).toBe(true);
    turn.done();

    vi.stubEnv('INKLING_OWNER_TEST_USER_ID', '');
    const off = await call(cancel, {}, { params: { id } });
    expect(off._status).toBe(403);
    expect(off._json).toMatchObject({ code: 'inklings_disabled' });
  });
});

describe('POST /inklings/:id/name', () => {
  async function awakened(): Promise<{ id: string; sbSlug: string }> {
    const res = await call(awaken, { clientRequestId: REQUEST });
    return res._json.inkling as { id: string; sbSlug: string };
  }

  it('200 with the named inkling; the same name again answers the same', async () => {
    const inkling = await awakened();
    const first = await call(name, { displayName: '  小墨 ' }, { params: { id: inkling.id } });
    expect(first._status).toBe(200);
    expect(first._json).toEqual({
      inkling: expect.objectContaining({
        id: inkling.id,
        sbSlug: inkling.sbSlug,
        displayName: '小墨',
      }),
    });

    const again = await call(name, { displayName: '小墨' }, { params: { id: inkling.id } });
    expect(again._status).toBe(200);
    expect(again._json).toEqual(first._json);
  });

  it('400 for a name the contract refuses: 33 code points, control characters, empty', async () => {
    const inkling = await awakened();
    for (const displayName of ['墨'.repeat(33), 'Pi\u0007p', '   ', undefined]) {
      const res = await call(name, { displayName }, { params: { id: inkling.id } });
      expect(res._status, JSON.stringify(displayName)).toBe(400);
    }
    const ok = await call(name, { displayName: '墨'.repeat(32) }, { params: { id: inkling.id } });
    expect(ok._status).toBe(200);
  });

  it("409 for the account's own SB, which the app can never rename", async () => {
    const myra = seedOwnSb(db, { userId: ME, workspaceId: MY_WORKSPACE }, 'myra');
    const res = await call(
      name,
      { displayName: 'Not Myra' },
      { params: { id: myra.id as string } }
    );
    expect(res._status).toBe(409);
  });

  it("404 for another person's inkling, an unknown id, or a malformed one", async () => {
    // Their inkling, awakened while the owner test was theirs.
    vi.stubEnv('INKLING_OWNER_TEST_USER_ID', SOMEONE_ELSE);
    const theirs = await call(
      awaken,
      { clientRequestId: REQUEST },
      { userId: SOMEONE_ELSE, workspaceId: OTHER_WORKSPACE }
    );
    vi.stubEnv('INKLING_OWNER_TEST_USER_ID', ME);
    const theirId = (theirs._json.inkling as { id: string }).id;
    for (const id of [theirId, '99999999-9999-4999-8999-999999999999', 'nope']) {
      const res = await call(name, { displayName: 'Pip' }, { params: { id } });
      expect(res._status, id).toBe(404);
    }
  });

  it('a viewer gets 403', async () => {
    const inkling = await awakened();
    const res = await call(
      name,
      { displayName: 'Pip' },
      { params: { id: inkling.id }, role: 'viewer' }
    );
    expect(res._status).toBe(403);
  });
});
