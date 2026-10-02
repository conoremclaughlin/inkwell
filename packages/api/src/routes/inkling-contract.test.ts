/**
 * Contract v3 fixtures, pinned two ways.
 *
 * 1. Against the server: every payload in src/test/fixtures/inkling-contract-v3.json
 *    has the same status and the same shape (field names, presence, value
 *    types) as what the real handlers answer. Change a response and this
 *    fails until the fixture, and so the app, is told.
 * 2. Against the app: the fixture satisfies the Inkling app's adapter as it
 *    stands at inkling 2d1f1030 (packages/mobile/src/inkling/inkwellApi.ts,
 *    types.ts and api.ts), so the app can switch to these routes without
 *    reshaping anything it already reads. The app can pin the same JSON on
 *    its side.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createInklingDb, seedOwnSb } from '../test/fake-inkling-db';
import type { FakePostgrest, Row } from '../test/fake-postgrest';
import {
  MAX_DISPLAY_NAME_CODE_POINTS,
  validateDisplayName,
} from '../services/inklings/inkling-service';

const mockHandleSendToInbox = vi.fn();
vi.mock('../mcp/tools/inbox-handlers', () => ({
  handleSendToInbox: (...args: unknown[]) => mockHandleSendToInbox(...args),
}));
vi.mock('../mcp/tools/thread-handlers', () => ({
  getParticipants: vi.fn(async () => [{ sbId: 'sb-1', sbSlug: participantSlug, userId: null }]),
  participantSlugs: (ps: Array<{ sbId: string | null; sbSlug: string | null }>) =>
    ps.filter((p) => p.sbId).map((p) => p.sbSlug as string),
}));
vi.mock('../auth/ink-tokens', () => ({
  signInkAccessToken: vi.fn(),
  createRefreshToken: vi.fn(),
  exchangeRefreshToken: vi.fn(),
  verifyInkAccessToken: vi.fn(),
}));

let db: FakePostgrest;
let participantSlug = '';
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

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, '../test/fixtures/inkling-contract-v3.json'), 'utf8')
);

type Handler = (req: Request, res: Response) => Promise<void>;
interface Answer {
  status: number;
  body: Record<string, unknown>;
}

function handler(method: 'get' | 'post', routePath: string): Handler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === routePath && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`${method.toUpperCase()} ${routePath} not found in router stack`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const ME = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function call(
  h: Handler,
  body: unknown,
  ctx: { params?: Record<string, string>; workspaceId?: string } = {}
): Promise<Answer> {
  const answer: Answer = { status: 200, body: {} };
  const res = {
    status(code: number) {
      answer.status = code;
      return res;
    },
    json(payload: Record<string, unknown>) {
      answer.body = payload;
      return res;
    },
  };
  await h(
    {
      body,
      headers: {},
      cookies: {},
      params: ctx.params ?? {},
      inkUserId: ME,
      inkWorkspaceId: ctx.workspaceId ?? WORKSPACE,
      inkWorkspaceRole: 'owner',
    } as unknown as Request,
    res as unknown as Response
  );
  return answer;
}

/** Field names, presence and value types; values themselves are illustrative. */
function shapeOf(value: unknown): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length > 0 ? [shapeOf(value[0])] : [];
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, shapeOf((value as Record<string, unknown>)[k])])
    );
  }
  return typeof value;
}

function expectMatchesFixture(actual: Answer, expected: Answer): void {
  expect(actual.status).toBe(expected.status);
  expect(shapeOf(actual.body)).toEqual(shapeOf(expected.body));
}

beforeEach(() => {
  vi.clearAllMocks();
  db = createInklingDb();
  // The send handler's stand-in: store, then report one recipient stamped and woken.
  mockHandleSendToInbox.mockImplementation(
    async (
      args: Record<string, unknown>,
      _dc: unknown,
      internal: { sender: { principal: { userId: string }; workspaceId: string } }
    ) => {
      let thread = db.rows('inbox_threads').find((t) => t.thread_key === args.threadKey);
      thread ??= db.seed('inbox_threads', {
        thread_key: args.threadKey,
        workspace_id: internal.sender.workspaceId,
      });
      const { data, error } = await db
        .from('inbox_thread_messages')
        .insert({
          thread_id: thread.id,
          sender_kind: 'user',
          sender_user_id: internal.sender.principal.userId,
          content: args.content,
          metadata: args.metadata as Row,
        })
        .select('id')
        .single();
      if (error) throw new Error(`Failed to send thread message: ${error.message}`);
      const recipients = (args.recipients as string[] | undefined) ?? [
        args.recipientSlug as string,
      ];
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              messageId: (data as Row).id,
              threadId: thread.id,
              recipients,
              triggered: recipients,
            }),
          },
        ],
      };
    }
  );
});

const list = handler('get', '/inklings');
const awaken = handler('post', '/inklings/awaken');
const name = handler('post', '/inklings/:id/name');
const create = handler('post', '/threads');
const reply = handler('post', '/threads/reply');

describe('the server answers in the fixture shapes', () => {
  it('awaken: created, replayed, and another workspace', async () => {
    const { awaken: f } = fixture.inklings;
    expectMatchesFixture(await call(awaken, f.request), f.created);
    expectMatchesFixture(await call(awaken, f.request), f.replayed);
    expectMatchesFixture(
      await call(awaken, f.request, { workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
      f.otherWorkspace
    );
  });

  it('list', async () => {
    await call(awaken, fixture.inklings.awaken.request);
    expectMatchesFixture(await call(list, undefined), fixture.inklings.list);
  });

  it('name: named, invalid, not nameable, unknown', async () => {
    const f = fixture.inklings.name;
    const awakened = await call(awaken, fixture.inklings.awaken.request);
    const id = (awakened.body.inkling as { id: string }).id;
    expectMatchesFixture(await call(name, f.request, { params: { id } }), f.response);
    expectMatchesFixture(
      await call(name, { displayName: 'x'.repeat(33) }, { params: { id } }),
      f.invalid
    );
    const myra = seedOwnSb(db, { userId: ME, workspaceId: WORKSPACE }, 'myra');
    expectMatchesFixture(
      await call(name, f.request, { params: { id: myra.id as string } }),
      f.notNameable
    );
    expectMatchesFixture(
      await call(name, f.request, { params: { id: '99999999-9999-4999-8999-999999999999' } }),
      f.unknown
    );
  });

  it('create and reply, including a replay and a conflict', async () => {
    const t = fixture.threads;
    participantSlug = t.create.request.recipients[0];
    expectMatchesFixture(await call(create, t.create.request), t.create.response);
    expectMatchesFixture(await call(reply, t.reply.request), t.reply.response);
    expectMatchesFixture(await call(reply, t.reply.request), t.reply.replayed);
    expectMatchesFixture(
      await call(reply, { ...t.reply.request, content: 'an edited draft' }),
      t.reply.conflict
    );
  });

  it('names exactly the delivery statuses the server can answer', () => {
    expect(fixture.threads.deliveryStatuses).toEqual(['routed', 'partial', 'unrouted', 'unknown']);
  });
});

describe("the fixture satisfies the app's adapter (inkling 2d1f1030)", () => {
  // packages/mobile/src/inkling/inkwellApi.ts: what send() and
  // createConversation() read from a thread write.
  function isAppReceipt(body: Record<string, unknown>): boolean {
    return (
      typeof body.messageId === 'string' &&
      (body.warning === undefined || body.warning === null || typeof body.warning === 'string')
    );
  }

  it('every thread write answers with a Receipt the adapter accepts', () => {
    const t = fixture.threads;
    for (const answer of [t.create.response, t.reply.response, t.reply.replayed]) {
      expect(isAppReceipt(answer.body)).toBe(true);
    }
  });

  it('an inkling maps onto the app Inkling (types.ts) without reshaping', () => {
    for (const inkling of fixture.inklings.list.body.inklings) {
      // { id, displayName, createdAt, simulated, order } — the adapter adds
      // the last two; the wire carries the first three as the app types them.
      expect(typeof inkling.id).toBe('string');
      expect(inkling.displayName === null || typeof inkling.displayName === 'string').toBe(true);
      expect(Number.isNaN(Date.parse(inkling.createdAt))).toBe(false);
      // createConversation() resolves recipients from an inkling id to its slug.
      expect(typeof inkling.sbSlug).toBe('string');
    }
  });

  it("the server's name limit is the app's MAX_NAME_LENGTH, counted the app's way", () => {
    const APP_MAX_NAME_LENGTH = 32; // packages/mobile/src/inkling/api.ts
    expect(MAX_DISPLAY_NAME_CODE_POINTS).toBe(APP_MAX_NAME_LENGTH);
    for (const sample of ['小墨', '墨'.repeat(32), '墨'.repeat(33), '🦋'.repeat(32), 'Pip']) {
      // simulatedApi.ts name(): trim, then [...name].length > MAX_NAME_LENGTH.
      const appAccepts = [...sample.trim()].length <= APP_MAX_NAME_LENGTH;
      expect(validateDisplayName(sample).ok, sample).toBe(appAccepts);
    }
  });

  it("the app's conversation key passes the create route's key grammar", () => {
    // NewConversationScreen.tsx: `chat:conversation-${randomUUID()}`, kept across retries.
    expect(fixture.threads.create.request.key).toMatch(/^chat:conversation-[0-9a-f-]{36}$/);
    expect(fixture.threads.create.request.key).toMatch(/^[^\s:]+:[^\s]+$/);
  });
});
