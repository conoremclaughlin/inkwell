/**
 * Event creation through the real OAuth and Calendar services, from Lumen's
 * PR #885 review probes: the account chosen for the write is the only one
 * that can write, desktop credential or not, and the time contract reaches
 * Google as RFC 3339. Only the database, the desktop store and Google are
 * fakes; every account, address and token is invented.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const fake = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  sources: ['cloud', 'desktop'] as Array<'cloud' | 'desktop'>,
  inserted: [] as Array<{ token: string; args: Record<string, unknown> }>,
  desktop: {
    findForEmail: vi.fn(),
    getAccessToken: vi.fn(),
  },
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
  env: { ...(await import('../../test/fake-env')).fakeEnv },
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => client() }));
vi.mock('../../services/google-desktop-credentials', () => ({
  getDesktopGoogleCredentialStore: () => fake.desktop,
}));
vi.mock('../../services/oauth', async (importActual) => {
  const actual = await importActual<typeof import('../../services/oauth')>();
  return {
    ...actual,
    getOAuthService: () =>
      new actual.OAuthService({ sources: fake.sources, desktopStore: fake.desktop as never }),
  };
});
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
      events: {
        insert: async (args: Record<string, unknown>) => {
          fake.inserted.push({ token: auth.token, args });
          return { data: { id: 'synthetic-event', ...(args.requestBody as object) } };
        },
      },
    }),
  },
}));

import { GoogleCalendarService } from './service';
import { createSpaceEvent, createSpaceEventSchema, eventWindow } from './space-events';

const USER = '00000000-0000-4000-8000-000000000001';
const SPACE = '00000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-10-16T18:00:00.000Z');
const input = (extra = {}) =>
  createSpaceEventSchema.parse({
    title: 'Synthetic event',
    start: '2026-10-20T19:00:00-07:00',
    end: '2026-10-20T20:00:00-07:00',
    organizer: 'Ada',
    organizerConfirmed: true,
    ...extra,
  });
const run = (extra = {}) => {
  const calendar = new GoogleCalendarService();
  return createSpaceEvent(
    {
      client: client(),
      createEvent: (userId, options, connection) =>
        calendar.createEvent(userId, options, connection),
      now: () => NOW,
    },
    SPACE,
    input(extra)
  );
};

beforeEach(() => {
  fake.sources = ['cloud', 'desktop'];
  fake.inserted = [];
  fake.desktop.findForEmail
    .mockReset()
    .mockResolvedValue({ record: { email: 'ada.personal@example.test' }, error: null });
  fake.desktop.getAccessToken.mockReset().mockResolvedValue('synthetic-desktop-personal-token');
  fake.tables = {
    workspace_members: [{ user_id: USER, workspace_id: SPACE, calendar_share: 'busy' }],
    users: [{ id: USER, first_name: 'Ada', email: 'ada.personal@example.test' }],
    connected_accounts: [
      {
        id: 'synthetic-work-account',
        provider: 'google',
        user_id: USER,
        workspace_id: SPACE,
        status: 'active',
        scopes: ['https://www.googleapis.com/auth/calendar.events'],
        email: 'ada.work@example.test',
        access_token: 'synthetic-cloud-work-token',
        refresh_token: null,
        expires_at: null,
        updated_at: '2026-10-01',
      },
    ],
  };
});

describe('exact account selection through the real calendar and OAuth services', () => {
  it('uses the selected account in cloud-first mode (positive control)', async () => {
    await run();
    expect(fake.inserted.map((entry) => entry.token)).toEqual(['synthetic-cloud-work-token']);
    expect(fake.desktop.getAccessToken).not.toHaveBeenCalled();
  });

  it('does not replace an explicit account with desktop credentials', async () => {
    fake.sources = ['desktop', 'cloud'];
    await run();
    expect(fake.inserted.map((entry) => entry.token)).toEqual(['synthetic-cloud-work-token']);
  });

  it('does not write to a different account when the selected account has expired', async () => {
    fake.tables.connected_accounts[0].expires_at = '2020-01-01T00:00:00Z';
    await run().catch(() => undefined);
    expect(fake.inserted).toEqual([]);
  });
});

describe('event time contract', () => {
  it('does not write an end beyond the advertised one-year window', async () => {
    await run({ end: '2030-01-01T00:00:00Z' }).catch(() => undefined);
    expect(fake.inserted).toEqual([]);
  });

  it('normalizes minute-precision instants to RFC3339 before sending to Google', async () => {
    await run({ start: '2026-10-20T19:00-07:00', end: '2026-10-20T20:00-07:00' });
    const body = fake.inserted[0].args.requestBody as {
      start: { dateTime: string };
      end: { dateTime: string };
    };
    expect(body.start.dateTime).toMatch(/T\d\d:\d\d:\d\d/);
    expect(body.end.dateTime).toMatch(/T\d\d:\d\d:\d\d/);
  });

  it('refuses impossible civil dates', () => {
    expect(() => eventWindow('2027-02-30T10:00:00Z', '2027-02-30T11:00:00Z', NOW)).toThrow();
  });
});
