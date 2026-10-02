/**
 * Adopting an interrupted create's conversation, through the real admin
 * route AND the real handleSendToInbox, with only the database (the
 * in-memory FakePostgrest), the gateway and the read-pointer RPC faked.
 *
 * Built on Lumen's review probes (09b80921, at 113cef7b), which showed two
 * P1s when adoption trusted the creator, the title and a member subset:
 * a changed-recipient retry added Moss to Fern's conversation before being
 * refused, and a different client message id took over an empty
 * conversation. Adoption now requires the intent the create recorded on the
 * thread row itself, before any participant was written.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createInklingDb } from '../test/fake-inkling-db';
import type { FakePostgrest, Row } from '../test/fake-postgrest';
import { createIntentOf, createRequestOf } from '../services/send-receipt';

const ME = '11111111-1111-4111-8111-111111111111';
const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY = 'chat:conversation-review';
const ID = '6d1f8a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const OTHER_ID = '0f0e0d0c-0b0a-4908-8706-050403020100';

let db: FakePostgrest;
let sends = 0;
/** Runs as the route calls the send handler: after every adoption check has passed. */
let beforeSend: (() => void) | undefined;
vi.mock('../mcp/tools/inbox-handlers', async (original) => {
  const real = await original<typeof import('../mcp/tools/inbox-handlers')>();
  return {
    ...real,
    handleSendToInbox: (...args: Parameters<typeof real.handleSendToInbox>) => {
      sends++;
      beforeSend?.();
      return real.handleSendToInbox(...args);
    },
  };
});
vi.mock('../services/user-resolver', async (original) => ({
  ...(await original<typeof import('../services/user-resolver')>()),
  resolveUserOrThrow: vi.fn(async () => ({ user: { id: ME }, resolvedBy: 'userId' })),
}));
vi.mock('../utils/request-context', async (original) => ({
  ...(await original<typeof import('../utils/request-context')>()),
  getRequestContext: vi.fn(() => ({ userId: ME })),
  getSessionContext: vi.fn(() => undefined),
  getPinnedSlug: vi.fn(() => undefined),
}));
vi.mock('../channels/agent-gateway', () => ({
  getAgentGateway: vi.fn(() => ({
    dispatchTrigger: vi.fn(() => ({ success: true, accepted: true })),
    processTrigger: vi.fn(async () => ({ success: true })),
  })),
}));
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

import router from './admin';

type Handler = (req: Request, res: Response) => Promise<void>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const create: Handler = (router as any).stack
  .find((x: any) => x.route?.path === '/threads' && x.route.methods.post)
  .route.stack.at(-1).handle;

const body = (extra: Row = {}) => ({
  key: KEY,
  recipients: ['fern'],
  content: 'private words',
  clientMessageId: ID,
  ...extra,
});

async function call(b: Row): Promise<{ status: number; body: Row }> {
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
  await create(
    {
      body: b,
      headers: {},
      cookies: {},
      params: {},
      inkUserId: ME,
      inkWorkspaceId: WS,
      inkWorkspaceRole: 'owner',
    } as unknown as Request,
    res as unknown as Response
  );
  return answer;
}

/** An empty conversation, as a create that died after its participants left it. */
function emptyConversation(metadata: Row = {}): Row {
  const thread = db.seed('inbox_threads', {
    thread_key: KEY,
    workspace_id: WS,
    created_by_user_id: ME,
    created_by_kind: 'user',
    title: null,
    metadata,
  });
  db.seed('inbox_thread_participants', {
    thread_id: thread.id,
    workspace_id: WS,
    sb_id: 'sb-fern',
    user_id: null,
  });
  db.seed('inbox_thread_participants', {
    thread_id: thread.id,
    workspace_id: WS,
    sb_id: null,
    user_id: ME,
  });
  return thread;
}

const fernsIntent = { createIntent: createIntentOf(ID, createRequestOf(['fern'], '')) };

function members(): string[] {
  return db
    .rows('inbox_thread_participants')
    .filter((p) => p.sb_id)
    .map((p) => String(p.sb_id))
    .sort();
}

/** The original's message lands a moment later, during the retry's wait. */
function originalLandsSoon(thread: Row): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(() => {
      db.seed('inbox_thread_messages', {
        thread_id: thread.id,
        sender_kind: 'user',
        sender_user_id: ME,
        content: 'private words',
        metadata: { clientMessageId: ID, pcp: { createRequest: createRequestOf(['fern'], '') } },
      });
      resolve();
    }, 150)
  );
}

/** The next message insert fails as a dropped connection would. */
function failNextMessageInsert(): void {
  const from = db.from.bind(db);
  let failed = false;
  db.from = ((table: string) => {
    const query = from(table);
    if (table === 'inbox_thread_messages' && !failed) {
      query.insert = (() => {
        failed = true;
        return {
          select: () => ({
            single: async () => ({
              data: null,
              error: { code: '08006', message: 'connection reset' },
            }),
          }),
        };
      }) as never;
    }
    return query;
  }) as never;
}

beforeEach(() => {
  db = createInklingDb();
  sends = 0;
  beforeSend = undefined;
  for (const slug of ['fern', 'moss']) {
    db.seed('agent_identities', {
      id: `sb-${slug}`,
      agent_id: slug,
      user_id: ME,
      workspace_id: WS,
      name: slug,
      metadata: {},
    });
  }
  db.rpcHandlers.advance_thread_read_pointer = () => ({ data: true, error: null });
});

describe('Lumen 09b80921: an interrupted create cannot be taken over', () => {
  for (const [label, metadata] of [
    ['with no recorded intent', {}],
    ["with Fern's recorded intent", fernsIntent],
  ] as const) {
    it(`a changed-recipient retry never adds Moss, even if the original lands after the checks (${label})`, async () => {
      // Lumen's probe: the original's message lands the moment the route
      // reaches the send, i.e. after every adoption check has passed.
      const thread = emptyConversation(metadata);
      beforeSend = () => {
        beforeSend = undefined;
        db.seed('inbox_thread_messages', {
          thread_id: thread.id,
          sender_kind: 'user',
          sender_user_id: ME,
          content: 'private words',
          metadata: { clientMessageId: ID, pcp: { createRequest: createRequestOf(['fern'], '') } },
        });
      };

      const result = await call(body({ recipients: ['fern', 'moss'] }));

      expect(result.status).toBe(409);
      expect(members()).toEqual(['sb-fern']);
      expect(sends).toBe(0);
    });

    it(`a changed-recipient retry is refused when the original lands during its wait (${label})`, async () => {
      const thread = emptyConversation(metadata);
      const landed = originalLandsSoon(thread);
      const result = await call(body({ recipients: ['fern', 'moss'] }));
      await landed;
      expect(result.status).toBe(409);
      expect(members()).toEqual(['sb-fern']);
      expect(db.rows('inbox_thread_messages')).toHaveLength(1);
    });

    it(`a different client id cannot adopt the empty conversation (${label})`, async () => {
      emptyConversation(metadata);
      const result = await call(
        body({ clientMessageId: OTHER_ID, recipients: ['fern', 'moss'], content: 'different' })
      );
      expect(result.status).toBe(409);
      expect(members()).toEqual(['sb-fern']);
      expect(db.rows('inbox_thread_messages')).toHaveLength(0);
      expect(sends).toBe(0);
    });
  }
});

describe('the create that recorded its intent is the one that may adopt', () => {
  it('records its intent on the thread row, and its exact retry completes it', async () => {
    failNextMessageInsert();
    const died = await call(body());
    expect(died.status).toBe(500);
    const [thread] = db.rows('inbox_threads');
    expect((thread.metadata as Row).createIntent).toEqual(
      createIntentOf(ID, createRequestOf(['fern'], ''))
    );
    expect(db.rows('inbox_thread_messages')).toHaveLength(0);

    const retry = await call(body());
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ replayed: false });
    expect(db.rows('inbox_thread_messages')).toHaveLength(1);
    expect(members()).toEqual(['sb-fern']);
  });

  it('an exact retry whose original lands after the adoption checks: one message, its addressee only', async () => {
    // Lumen's interleaving: the checks see an empty conversation, then the
    // slow original stores its message before the retry's send writes.
    const thread = emptyConversation(fernsIntent);
    beforeSend = () => {
      beforeSend = undefined;
      db.seed('inbox_thread_messages', {
        thread_id: thread.id,
        sender_kind: 'user',
        sender_user_id: ME,
        content: 'private words',
        metadata: { clientMessageId: ID, pcp: { createRequest: createRequestOf(['fern'], '') } },
      });
    };
    const result = await call(body());
    expect(sends).toBe(1);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ replayed: true });
    expect(db.rows('inbox_thread_messages')).toHaveLength(1);
    expect(members()).toEqual(['sb-fern']);
  });
});
