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

import { calendarShareRouter, parseRevision, revisionOf } from './admin-calendar-share';

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

const ADA_ROW = '00000000-0000-4000-8000-0000000000a1';
const SAM_ROW = '00000000-0000-4000-8000-0000000000a2';
const SAM_REJOINED = '00000000-0000-4000-8000-0000000000a3';

const rowOf = (userId: string) =>
  fake.tables.workspace_members.find((row) => row.user_id === userId)!;
const shareOf = (userId: string) => rowOf(userId).calendar_share;
const rev = (membershipId: string, version: number) => `${membershipId}.${version}`;

beforeEach(() => {
  vi.clearAllMocks();
  fake.failOn = null;
  fake.writes.length = 0;
  fake.sources = ['cloud'];
  fake.tables = {
    workspace_members: [
      {
        id: ADA_ROW,
        workspace_id: SPACE,
        user_id: ADA,
        role: 'owner',
        calendar_share: 'none',
        calendar_share_version: 0,
      },
      {
        id: SAM_ROW,
        workspace_id: SPACE,
        user_id: SAM,
        role: 'member',
        calendar_share: 'none',
        calendar_share_version: 0,
      },
    ],
    connected_accounts: [],
  };
});

describe('revisions', () => {
  it('name the membership row and its version, and parse back only from that shape', () => {
    expect(revisionOf({ id: SAM_ROW, calendar_share_version: 7 })).toBe(`${SAM_ROW}.7`);
    expect(revisionOf({ id: SAM_ROW, calendar_share_version: null })).toBe(`${SAM_ROW}.0`);
    expect(parseRevision(`${SAM_ROW}.7`)).toEqual({ membershipId: SAM_ROW, version: 7 });
    for (const value of [
      undefined,
      null,
      7,
      '7',
      SAM_ROW,
      `${SAM_ROW}.`,
      `${SAM_ROW}.-1`,
      `${SAM_ROW}.01`,
      `${SAM_ROW}.1.5`,
      `${SAM_ROW}.99999999999999999`,
      `not-a-row.1`,
      ` ${SAM_ROW}.1`,
    ]) {
      expect(parseRevision(value)).toBeNull();
    }
  });
});

describe('GET calendar-share', () => {
  it("reads the person's own level and revision, starting at none, and whether a calendar is connected", async () => {
    const res = await call(read);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      level: 'none',
      calendarConnected: false,
      revision: rev(ADA_ROW, 0),
    });
    expect(res.headers['Cache-Control']).toBe('no-store');

    Object.assign(rowOf(ADA), { calendar_share: 'busy', calendar_share_version: 3 });
    fake.tables.connected_accounts = [
      {
        user_id: ADA,
        provider: 'google',
        status: 'active',
        workspace_id: null,
        scopes: [CALENDAR],
      },
    ];
    expect((await call(read)).body).toEqual({
      level: 'busy',
      calendarConnected: true,
      revision: rev(ADA_ROW, 3),
    });
  });

  it('counts a credential the server holds for the person, when it can read free/busy', async () => {
    fake.sources = ['cloud', 'desktop'];
    fake.desktop.mockResolvedValue({
      error: null,
      credentials: [{ state: 'active', scopes: [CALENDAR] }],
    });
    expect((await call(read)).body).toMatchObject({ level: 'none', calendarConnected: true });
    fake.desktop.mockResolvedValue({ error: 'unreadable', credentials: [] });
    expect((await call(read)).body).toMatchObject({ level: 'none', calendarConnected: null });
  });

  it('is 404 for someone who is not a member, and for a malformed space', async () => {
    expect((await call(read, { as: STRANGER })).statusCode).toBe(404);
    expect((await call(read, { space: 'not-a-space' })).statusCode).toBe(404);
  });
});

describe('PUT calendar-share', () => {
  it("changes the person's own row from the revision they read, and no one else's", async () => {
    const res = await call(change, {
      as: SAM,
      body: { level: 'busy', ifRevision: rev(SAM_ROW, 0) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ level: 'busy', revision: rev(SAM_ROW, 1) });
    expect(rowOf(SAM)).toMatchObject({ calendar_share: 'busy', calendar_share_version: 1 });
    expect(rowOf(ADA)).toMatchObject({ calendar_share: 'none', calendar_share_version: 0 });
    // One statement: the fence and the change together.
    expect(fake.writes).toEqual([
      {
        table: 'workspace_members',
        fields: { calendar_share: 'busy', calendar_share_version: 1 },
        filters: [
          ['id', SAM_ROW],
          ['workspace_id', SPACE],
          ['user_id', SAM],
          ['calendar_share_version', 0],
        ],
      },
    ]);
  });

  it("gives the space's owner no way to set another member's level, even with that member's revision", async () => {
    const own = await call(change, {
      as: ADA,
      body: { level: 'busy', ifRevision: rev(ADA_ROW, 0), userId: SAM, user_id: SAM },
    });
    expect(own.statusCode).toBe(200);
    expect(shareOf(SAM)).toBe('none');
    expect(shareOf(ADA)).toBe('busy');
    const theirs = await call(change, {
      as: ADA,
      body: { level: 'busy', ifRevision: rev(SAM_ROW, 0) },
    });
    expect(theirs.statusCode).toBe(409);
    expect(rowOf(SAM)).toMatchObject({ calendar_share: 'none', calendar_share_version: 0 });
  });

  it('turns it back off, and every acknowledged write moves the revision, a same-level one too', async () => {
    Object.assign(rowOf(SAM), { calendar_share: 'busy', calendar_share_version: 4 });
    expect(
      (await call(change, { as: SAM, body: { level: 'none', ifRevision: rev(SAM_ROW, 4) } })).body
    ).toEqual({ level: 'none', revision: rev(SAM_ROW, 5) });
    expect(
      (await call(change, { as: SAM, body: { level: 'none', ifRevision: rev(SAM_ROW, 5) } })).body
    ).toEqual({ level: 'none', revision: rev(SAM_ROW, 6) });
    expect(rowOf(SAM)).toMatchObject({ calendar_share: 'none', calendar_share_version: 6 });
  });

  it('refuses a write from a revision that has moved on, answering what is held now', async () => {
    Object.assign(rowOf(SAM), { calendar_share: 'busy', calendar_share_version: 2 });
    const res = await call(change, {
      as: SAM,
      body: { level: 'none', ifRevision: rev(SAM_ROW, 1) },
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({
      code: 'revision_changed',
      level: 'busy',
      revision: rev(SAM_ROW, 2),
    });
    expect(rowOf(SAM)).toMatchObject({ calendar_share: 'busy', calendar_share_version: 2 });
  });

  it('lets a lost grant never land after a revoke sent from the same revision (Lumen, app r4)', async () => {
    // Both were sent from revision 0. The revoke arrives first and is acknowledged.
    const revoke = await call(change, {
      as: SAM,
      body: { level: 'none', ifRevision: rev(SAM_ROW, 0) },
    });
    expect(revoke.body).toEqual({ level: 'none', revision: rev(SAM_ROW, 1) });
    // The grant whose answer was lost arrives late, still claiming revision 0.
    const lateGrant = await call(change, {
      as: SAM,
      body: { level: 'busy', ifRevision: rev(SAM_ROW, 0) },
    });
    expect(lateGrant.statusCode).toBe(409);
    expect(lateGrant.body).toMatchObject({ code: 'revision_changed', level: 'none' });
    expect(rowOf(SAM)).toMatchObject({ calendar_share: 'none', calendar_share_version: 1 });
  });

  it('never lands a write read from an earlier membership on a later one (Lumen, membership generation)', async () => {
    // Sam left and rejoined: a new row, its version back at 0.
    fake.tables.workspace_members[1] = {
      id: SAM_REJOINED,
      workspace_id: SPACE,
      user_id: SAM,
      role: 'member',
      calendar_share: 'none',
      calendar_share_version: 0,
    };
    // A grant read from the old membership, at the same version number, arrives now.
    const late = await call(change, {
      as: SAM,
      body: { level: 'busy', ifRevision: rev(SAM_ROW, 0) },
    });
    expect(late.statusCode).toBe(409);
    expect(late.body).toMatchObject({
      code: 'revision_changed',
      level: 'none',
      revision: rev(SAM_REJOINED, 0),
    });
    expect(rowOf(SAM)).toMatchObject({
      id: SAM_REJOINED,
      calendar_share: 'none',
      calendar_share_version: 0,
    });
  });

  it('refuses a missing or malformed ifRevision, writing nothing', async () => {
    for (const ifRevision of [
      undefined,
      null,
      0,
      '0',
      `${ADA_ROW}.-1`,
      `${ADA_ROW}.1.5`,
      ADA_ROW,
    ]) {
      const res = await call(change, { body: { level: 'busy', ifRevision } });
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ code: 'invalid_if_revision' });
    }
    // The old field name is not a way around the fence.
    const legacy = await call(change, { body: { level: 'busy', ifVersion: 0 } });
    expect(legacy.statusCode).toBe(400);
    expect(fake.writes).toEqual([]);
    expect(shareOf(ADA)).toBe('none');
  });

  it('refuses any level but none or busy, writing nothing', async () => {
    for (const level of ['details', 'BUSY', '', null, undefined, true]) {
      const res = await call(change, { body: { level, ifRevision: rev(ADA_ROW, 0) } });
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ code: 'invalid_level' });
    }
    expect(fake.writes).toEqual([]);
  });

  it('is 404 for someone who is not a member, and changes nothing', async () => {
    const res = await call(change, {
      as: STRANGER,
      body: { level: 'busy', ifRevision: rev(ADA_ROW, 0) },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ code: 'not_a_member' });
    expect(shareOf(ADA)).toBe('none');
    expect(shareOf(SAM)).toBe('none');
  });

  it('is 500 when the row cannot be written', async () => {
    fake.failOn = 'workspace_members';
    expect(
      (await call(change, { body: { level: 'busy', ifRevision: rev(ADA_ROW, 0) } })).statusCode
    ).toBe(500);
  });
});
