/**
 * Shared busy times through the real OAuth and Calendar services, from
 * Lumen's PR #882 review probes. Only the database and Google are fakes: the
 * database sorts and filters as PostgREST would, and Google answers free/busy
 * for a calendar-scoped token and refuses a mail-only one. The people,
 * accounts and tokens are invented; no provider is reached.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const fake = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  /** The access token each free/busy query was made with, in order. */
  tokens: [] as string[],
}));

function client() {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let sort: string | undefined;
      let ascending = true;
      let limit = Infinity;
      let update: Row | undefined;
      const rows = () => {
        let selected = (fake.tables[table] ?? []).filter((row) =>
          filters.every(([key, value]) =>
            Array.isArray(value) ? value.includes(row[key]) : row[key] === value
          )
        );
        if (sort) {
          const by = sort;
          selected.sort(
            (a, b) => String(a[by]).localeCompare(String(b[by])) * (ascending ? 1 : -1)
          );
        }
        selected = selected.slice(0, limit);
        if (update) selected.forEach((row) => Object.assign(row, update));
        return { data: selected, error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (key: string, value: unknown) => (filters.push([key, value]), builder),
        is: (key: string, value: unknown) => (filters.push([key, value]), builder),
        in: (key: string, value: unknown) => (filters.push([key, value]), builder),
        order: (key: string, options: { ascending?: boolean } = {}) => {
          sort = key;
          ascending = options.ascending !== false;
          return builder;
        },
        limit: (value: number) => ((limit = value), builder),
        update: (value: Row) => ((update = value), builder),
        maybeSingle: async () => ({ data: rows().data[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
          Promise.resolve(rows()).then(resolve, reject),
      };
      return builder;
    },
  };
}

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../config/env', async () => ({
  env: { ...(await import('../../test/fake-env')).fakeEnv, GOOGLE_CREDENTIAL_SOURCES: 'cloud' },
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => client() }));
vi.mock('../../services/google-desktop-credentials', () => ({
  getDesktopGoogleCredentialStore: () =>
    new Proxy(
      {},
      {
        get: () => {
          throw new Error('Desktop credentials are outside this test');
        },
      }
    ),
}));
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        token = '';
        setCredentials(value: { access_token: string }) {
          this.token = value.access_token;
        }
      },
    },
    calendar: ({ auth }: { auth: { token: string } }) => ({
      freebusy: {
        query: async () => {
          fake.tokens.push(auth.token);
          if (auth.token === 'token-mail-only') {
            throw new Error('Insufficient authentication scopes');
          }
          return {
            data: {
              calendars: {
                primary: {
                  busy: [{ start: '2026-10-17T12:00:00.000Z', end: '2026-10-17T13:00:00.000Z' }],
                },
              },
            },
          };
        },
      },
    }),
  },
}));

import { GoogleCalendarService } from './service';
import { freeBusyConnection, readSpaceBusyTimes } from './space-busy-times';

const USER = '00000000-0000-4000-8000-000000000001';
const SPACE = '00000000-0000-4000-8000-000000000002';
const CALENDAR = 'https://www.googleapis.com/auth/calendar.readonly';
const MAIL = 'https://www.googleapis.com/auth/gmail.readonly';

const calendar = new GoogleCalendarService();
const read = () =>
  readSpaceBusyTimes(
    {
      client: client(),
      busyFor: (userId, window, connection) => calendar.primaryBusy(userId, window, connection),
      now: () => new Date('2026-10-16T08:00:00.000Z'),
    },
    SPACE,
    2
  );

const account = (id: string, scopes: string[], token: string, updatedAt: string): Row => ({
  id,
  provider_account_id: `${id}-provider`,
  user_id: USER,
  workspace_id: SPACE,
  provider: 'google',
  status: 'active',
  scopes,
  access_token: token,
  refresh_token: null,
  expires_at: null,
  updated_at: updatedAt,
});

beforeEach(() => {
  fake.tokens = [];
  fake.tables = {
    workspace_members: [{ user_id: USER, workspace_id: SPACE, calendar_share: 'busy' }],
    users: [{ id: USER, first_name: 'Ada', last_name: null, username: null }],
    connected_accounts: [account('acct-calendar', [CALENDAR], 'token-calendar', '2026-10-01')],
  };
});

describe('shared busy times through the real OAuth and Calendar services (Lumen, PR #882)', () => {
  it('reads a calendar-scoped connection (the positive control)', async () => {
    expect((await read()).sharing).toHaveLength(1);
    expect(fake.tokens).toEqual(['token-calendar']);
  });

  it('reads the connection it chose, not a newer mail-only one in the same space', async () => {
    fake.tables.connected_accounts.push(
      account('acct-mail', [MAIL], 'token-mail-only', '2026-10-15')
    );
    expect(await freeBusyConnection(client(), USER, SPACE)).toEqual({
      found: true,
      workspaceId: SPACE,
      accountId: 'acct-calendar',
    });
    const result = await read();
    expect(fake.tokens).toEqual(['token-calendar']);
    expect(result.sharing).toHaveLength(1);
    expect(result.unavailable).toEqual([]);
  });

  it("never shows a non-sharer's address held in a name field, and reads nothing of theirs", async () => {
    fake.tables.workspace_members[0].calendar_share = 'none';
    fake.tables.users[0] = {
      id: USER,
      first_name: null,
      last_name: null,
      username: 'ada@example.test',
    };
    const result = await read();
    expect(JSON.stringify(result)).not.toContain('ada@example.test');
    expect(result.notSharing).toEqual(['a member of this space']);
    expect(fake.tokens).toEqual([]);
  });
});
