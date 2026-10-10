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

vi.mock('../config/env', async () => ({
  isDevelopment: () => false,
  env: {
    ...(await import('../test/fake-env')).fakeEnv,
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

vi.mock('../data/task-graph-read-model', () => ({
  applyGraphBlockedBy: async (_client: unknown, rows: unknown[]) => rows,
}));
import router from './admin';
import { listSearchFilter } from './list-search';
import { encodeTasksCursor } from './tasks-page';

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
  const stack = router as unknown as {
    stack: Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
      };
    }>;
  };
  const layer = stack.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods[method]
  );
  if (!layer) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  }
  return layer.route!.stack[0].handle as (req: Request, res: Response) => Promise<void>;
}

const counted = (data: unknown, count: number) => ({ data, error: null, count });
const row = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Garden plan',
  description: 'A paper trail',
  created_at: '2026-01-01T00:00:00+00:00',
  status: 'pending',
  priority: 'medium',
};
async function get(path: string, query: Record<string, unknown> = {}) {
  const res = createMockRes();
  await getRouteHandler(path, 'get')(
    createMockReq({
      query,
      inkUserId: 'synthetic-owner',
      inkWorkspaceId: 'synthetic-workspace',
    } as unknown as Partial<Request>),
    res
  );
  return res;
}
const builder = (index: number) =>
  currentSupabaseMock.calls[index].builder as Record<string, ReturnType<typeof vi.fn>>;

describe('authenticated list search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it.each(['/artifacts', '/tasks'])(
    '%s rejects malformed input before creating a query',
    async (path) => {
      currentSupabaseMock = createTableAwareSupabaseMock({});
      expect((await get(path, { search: ['garden', 'plan'] }))._status).toBe(400);
      expect(currentSupabaseMock.calls).toHaveLength(0);
    }
  );
  it('searches Library title/content inside both authorization boundaries and before capping', async () => {
    currentSupabaseMock = createTableAwareSupabaseMock({
      artifacts: [
        {
          then: counted([{ ...row, content: 'Do not return this', edit_mode: 'workspace' }], 1200),
        },
      ],
    });
    const res = await get('/artifacts', { search: 'garden paper' });
    expect(res._status).toBe(200);
    expect(builder(0).eq.mock.calls).toEqual([
      ['user_id', 'synthetic-owner'],
      ['workspace_id', 'synthetic-workspace'],
    ]);
    expect(builder(0).or).toHaveBeenCalledWith(
      listSearchFilter(['garden', 'paper'], ['title', 'content'])
    );
    expect(builder(0).limit).toHaveBeenCalledWith(1000);
    expect(builder(0).or.mock.invocationCallOrder[0]).toBeLessThan(
      builder(0).limit.mock.invocationCallOrder[0]
    );
    expect(res._json).toMatchObject({ meta: { fetched: 1, total: 1200, truncated: true } });
    expect((res._json as { artifacts: unknown[] }).artifacts[0]).not.toHaveProperty('content');
  });
  it('applies search to both page and cursor-free total without replacing the cursor predicate', async () => {
    currentSupabaseMock = createTableAwareSupabaseMock({
      tasks: [{ then: counted([row], 2) }, { then: counted(null, 12) }],
    });
    const res = await get('/tasks', {
      search: 'garden paper',
      status: 'pending',
      groupId: 'synthetic-group',
      limit: '1',
      before: encodeTasksCursor({ createdAt: '2026-01-02T00:00:00+00:00', id: row.id }),
    });
    expect(res._status).toBe(200);
    for (const index of [0, 1]) {
      expect(builder(index).eq).toHaveBeenCalledWith('user_id', 'synthetic-owner');
      expect(builder(index).eq).toHaveBeenCalledWith('status', 'pending');
      expect(builder(index).eq).toHaveBeenCalledWith('task_group_id', 'synthetic-group');
      expect(builder(index).or).toHaveBeenCalledWith(
        listSearchFilter(['garden', 'paper'], ['title', 'description'])
      );
    }
    expect(builder(0).or).toHaveBeenCalledTimes(2);
    expect(builder(1).or).toHaveBeenCalledTimes(1);
    expect(res._json).toMatchObject({ meta: { fetched: 1, total: 12, truncated: true } });
  });
  it.each(['/artifacts', '/tasks'])('%s leaves blank queries unfiltered', async (path) => {
    currentSupabaseMock = createTableAwareSupabaseMock({
      [path.slice(1)]: [{ then: { data: [], error: null } }, {}],
    });
    expect((await get(path, { search: '   ' }))._status).toBe(200);
    expect(builder(0).or).not.toHaveBeenCalled();
  });
  it.each(['/artifacts', '/tasks'])(
    '%s reports DB errors instead of successful empty results',
    async (path) => {
      currentSupabaseMock = createTableAwareSupabaseMock({
        [path.slice(1)]: [{ then: { data: null, error: { message: 'Synthetic failure' } } }, {}],
      });
      expect((await get(path, { search: 'garden' }))._status).toBe(500);
    }
  );
});
