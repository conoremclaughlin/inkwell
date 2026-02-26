import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createTableAwareSupabaseMock } from '../test/table-aware-supabase-mock';

let currentSupabaseMock: ReturnType<typeof createTableAwareSupabaseMock>;

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => currentSupabaseMock),
}));

vi.mock('../services/authorization', () => ({
  getAuthorizationService: vi.fn(() => ({
    listTrustedUsers: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../services/oauth', () => ({
  getOAuthService: vi.fn(() => ({})),
}));

vi.mock('../config/env', () => ({
  env: {
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'test-secret',
    MCP_HTTP_PORT: 3001,
  },
}));

vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../utils/request-context', () => ({
  runWithRequestContext: (_context: unknown, fn: () => void) => fn(),
}));

import router from './admin';

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    params: {},
    body: {},
    ...overrides,
  } as unknown as Request;
}

function createMockRes(): Response & { _status: number; _json: unknown } {
  const res = {
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
  return res as unknown as Response & { _status: number; _json: unknown };
}

function getRouteHandler(path: string, method: 'get' | 'post') {
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  }
  return layer.route.stack[0].handle as (req: Request, res: Response) => Promise<void>;
}

describe('admin artifact comments routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /artifacts/:id/comments returns comments enriched with identity metadata', async () => {
    currentSupabaseMock = createTableAwareSupabaseMock({
      artifacts: [{ single: [{ data: { id: 'artifact-1' }, error: null }] }],
      artifact_comments: [
        {
          then: {
            data: [
              {
                id: 'comment-1',
                artifact_id: 'artifact-1',
                parent_comment_id: null,
                content: 'Looks good',
                metadata: {},
                created_by_identity_id: 'identity-1',
                created_at: '2026-02-11T00:00:00Z',
                updated_at: '2026-02-11T00:00:00Z',
                user_id: '550e8400-e29b-41d4-a716-446655440000',
                deleted_at: null,
              },
            ],
            error: null,
          },
        },
      ],
      agent_identities: [
        {
          then: {
            data: [{ id: 'identity-1', agent_id: 'lumen', name: 'Lumen', backend: 'codex' }],
            error: null,
          },
        },
      ],
      users: [
        {
          then: {
            data: [
              {
                id: '550e8400-e29b-41d4-a716-446655440000',
                first_name: 'Alice',
                username: 'alice',
                email: 'alice@example.com',
              },
            ],
            error: null,
          },
        },
      ],
    });

    const handler = getRouteHandler('/artifacts/:id/comments', 'get');
    const req = createMockReq({
      params: { id: 'artifact-1' } as Record<string, string>,
      pcpUserId: '550e8400-e29b-41d4-a716-446655440000',
    } as unknown as Partial<Request>);
    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(200);
    const payload = res._json as { comments: Array<{ createdByIdentity: { agentId: string } }> };
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0].createdByIdentity.agentId).toBe('lumen');
  });

  it('POST /artifacts/:id/comments creates comment with canonical identity UUID', async () => {
    currentSupabaseMock = createTableAwareSupabaseMock({
      artifacts: [{ single: [{ data: { id: 'artifact-1' }, error: null }] }],
      agent_identities: [
        {
          single: [
            {
              data: { id: 'identity-1', agent_id: 'lumen', name: 'Lumen', backend: 'codex' },
              error: null,
            },
          ],
        },
      ],
      artifact_comments: [
        {
          single: [
            {
              data: {
                id: 'comment-1',
                artifact_id: 'artifact-1',
                parent_comment_id: null,
                content: 'Adding a review comment',
                metadata: {},
                created_by_user_id: '550e8400-e29b-41d4-a716-446655440000',
                created_by_identity_id: 'identity-1',
                created_at: '2026-02-11T00:00:00Z',
                updated_at: '2026-02-11T00:00:00Z',
              },
              error: null,
            },
          ],
        },
      ],
      users: [
        {
          maybeSingle: [
            {
              data: {
                id: '550e8400-e29b-41d4-a716-446655440000',
                first_name: 'Alice',
                username: 'alice',
                email: 'alice@example.com',
              },
              error: null,
            },
          ],
        },
      ],
    });

    const handler = getRouteHandler('/artifacts/:id/comments', 'post');
    const req = createMockReq({
      params: { id: 'artifact-1' } as Record<string, string>,
      body: { content: 'Adding a review comment', agentId: 'lumen' },
      pcpUserId: '550e8400-e29b-41d4-a716-446655440000',
    } as unknown as Partial<Request>);
    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(200);
    const payload = res._json as {
      comment: { createdByIdentityId: string; createdByIdentity: { agentId: string } };
    };
    expect(payload.comment.createdByIdentityId).toBe('identity-1');
    expect(payload.comment.createdByIdentity.agentId).toBe('lumen');

    const commentsBuilder = currentSupabaseMock.calls.find(
      (c) => c.table === 'artifact_comments'
    )?.builder;
    expect(commentsBuilder).toBeDefined();
    expect((commentsBuilder?.insert as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      created_by_user_id: '550e8400-e29b-41d4-a716-446655440000',
      created_by_identity_id: 'identity-1',
      content: 'Adding a review comment',
    });
  });
});
