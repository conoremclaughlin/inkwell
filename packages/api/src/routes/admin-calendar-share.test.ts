/**
 * A member's own "share my busy times here" switch (D6). The database and the
 * OAuth service are fakes; the people and spaces are invented.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

type Row = Record<string, unknown>;

const fake = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failOn: null as string | null,
  writes: [] as Array<{ table: string; fields: Row; filters: Array<[string, unknown]> }>,
  sources: ['cloud'] as string[],
  desktop: vi.fn(),
}));

function fakeClient() {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let update: Row | undefined;
      const rows = () => {
        if (fake.failOn === table) return { data: null, error: { message: 'connection reset' } };
        const kept = (fake.tables[table] ?? []).filter((row) =>
          filters.every(([column, value]) => row[column] === value)
        );
        if (update) {
          fake.writes.push({ table, fields: update, filters: [...filters] });
          for (const row of kept) Object.assign(row, update);
        }
        return { data: kept, error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        eq: (column: string, value: unknown) => (filters.push([column, value]), builder),
        update: (fields: Row) => ((update = fields), builder),
        maybeSingle: async () => {
          const result = rows();
          return { data: (result.data as Row[] | null)?.[0] ?? null, error: result.error };
        },
        then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
          Promise.resolve(rows()).then(resolve, reject),
      };
      return builder;
    },
  };
}

vi.mock('../data/composer', () => ({
  getDataComposer: async () => ({ getClient: () => fakeClient() }),
}));
vi.mock('../services/oauth', () => ({
  getOAuthService: () => ({
    getCredentialSources: () => fake.sources,
    describeDesktopCredentials: fake.desktop,
  }),
}));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { calendarShareRouter } from './admin-calendar-share';

type Handler = (req: Request, res: Response) => unknown;
/* eslint-disable @typescript-eslint/no-explicit-any */
function route(method: string, path: string): Handler {
  const layer = (calendarShareRouter as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const SPACE = '00000000-0000-4000-8000-00000000000a';
const ADA = '00000000-0000-4000-8000-000000000001';
const SAM = '00000000-0000-4000-8000-000000000002';
const STRANGER = '00000000-0000-4000-8000-000000000009';
const CALENDAR = 'https://www.googleapis.com/auth/calendar.readonly';

const PATH = '/workspaces/:workspaceId/calendar-share';
const read = route('get', PATH);
const change = route('put', PATH);

async function call(
  handler: Handler,
  { as = ADA, space = SPACE, body = {} }: { as?: string; space?: string; body?: object } = {}
) {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(n: number) {
      res.statusCode = n;
      return res;
    },
    json(value: unknown) {
      res.body = value;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
  };
  await handler(
    { params: { workspaceId: space }, body, inkUserId: as } as unknown as Request,
    res as unknown as Response
  );
  return res;
}

const shareOf = (userId: string) =>
  fake.tables.workspace_members.find((row) => row.user_id === userId)?.calendar_share;

beforeEach(() => {
  vi.clearAllMocks();
  fake.failOn = null;
  fake.writes.length = 0;
  fake.sources = ['cloud'];
  fake.tables = {
    workspace_members: [
      { workspace_id: SPACE, user_id: ADA, role: 'owner', calendar_share: 'none' },
      { workspace_id: SPACE, user_id: SAM, role: 'member', calendar_share: 'none' },
    ],
    connected_accounts: [],
  };
});

describe('GET calendar-share', () => {
  it("reads the person's own level, starting at none, and whether a calendar is connected", async () => {
    const res = await call(read);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ level: 'none', calendarConnected: false });
    expect(res.headers['Cache-Control']).toBe('no-store');

    fake.tables.workspace_members[0].calendar_share = 'busy';
    fake.tables.connected_accounts = [
      {
        user_id: ADA,
        provider: 'google',
        status: 'active',
        workspace_id: null,
        scopes: [CALENDAR],
      },
    ];
    expect((await call(read)).body).toEqual({ level: 'busy', calendarConnected: true });
  });

  it('counts a credential the server holds for the person, when it can read free/busy', async () => {
    fake.sources = ['cloud', 'desktop'];
    fake.desktop.mockResolvedValue({
      error: null,
      credentials: [{ state: 'active', scopes: [CALENDAR] }],
    });
    expect((await call(read)).body).toEqual({ level: 'none', calendarConnected: true });
    fake.desktop.mockResolvedValue({ error: 'unreadable', credentials: [] });
    expect((await call(read)).body).toEqual({ level: 'none', calendarConnected: null });
  });

  it('is 404 for someone who is not a member, and for a malformed space', async () => {
    expect((await call(read, { as: STRANGER })).statusCode).toBe(404);
    expect((await call(read, { space: 'not-a-space' })).statusCode).toBe(404);
  });
});

describe('PUT calendar-share', () => {
  it("changes the person's own row and no one else's", async () => {
    const res = await call(change, { as: SAM, body: { level: 'busy' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ level: 'busy' });
    expect(shareOf(SAM)).toBe('busy');
    expect(shareOf(ADA)).toBe('none');
    expect(fake.writes).toEqual([
      {
        table: 'workspace_members',
        fields: { calendar_share: 'busy' },
        filters: [
          ['workspace_id', SPACE],
          ['user_id', SAM],
        ],
      },
    ]);
  });

  it("gives the space's owner no way to set another member's level", async () => {
    const res = await call(change, { as: ADA, body: { level: 'busy', userId: SAM, user_id: SAM } });
    expect(res.statusCode).toBe(200);
    expect(shareOf(SAM)).toBe('none');
    expect(shareOf(ADA)).toBe('busy');
  });

  it('turns it back off', async () => {
    fake.tables.workspace_members[1].calendar_share = 'busy';
    expect((await call(change, { as: SAM, body: { level: 'none' } })).body).toEqual({
      level: 'none',
    });
    expect(shareOf(SAM)).toBe('none');
  });

  it('refuses any level but none or busy, writing nothing', async () => {
    for (const level of ['details', 'BUSY', '', null, undefined, true]) {
      const res = await call(change, { body: { level } });
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ code: 'invalid_level' });
    }
    expect(fake.writes).toEqual([]);
  });

  it('is 404 for someone who is not a member, and changes nothing', async () => {
    const res = await call(change, { as: STRANGER, body: { level: 'busy' } });
    expect(res.statusCode).toBe(404);
    expect(shareOf(ADA)).toBe('none');
    expect(shareOf(SAM)).toBe('none');
  });

  it('is 500 when the row cannot be written', async () => {
    fake.failOn = 'workspace_members';
    expect((await call(change, { body: { level: 'busy' } })).statusCode).toBe(500);
  });
});
