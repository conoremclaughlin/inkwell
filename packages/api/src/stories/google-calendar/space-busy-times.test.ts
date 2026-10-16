/**
 * A space's shared busy times (D5-D7): who is read, over what window, with
 * which connection, and what comes back. The database and Google are fakes;
 * the people, spaces and calendars are invented.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const fake = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failOn: null as string | null,
  freebusy: vi.fn(),
  eventsList: vi.fn(),
  getValidAccessToken: vi.fn(async (..._args: unknown[]) => 'token'),
}));

/** Filters eq/in, orders by one column; enough for the reads under test. */
function fakeClient() {
  return {
    from(table: string) {
      const filters: Array<[string, string, unknown]> = [];
      let orderBy: { column: string; ascending: boolean } | null = null;
      const rows = () => {
        if (fake.failOn === table) return { data: null, error: { message: 'connection reset' } };
        const kept = (fake.tables[table] ?? []).filter((row) =>
          filters.every(([op, column, value]) =>
            op === 'in' ? (value as unknown[]).includes(row[column]) : row[column] === value
          )
        );
        if (orderBy) {
          const { column, ascending } = orderBy;
          kept.sort((a, b) =>
            String(a[column]) < String(b[column]) ? (ascending ? -1 : 1) : ascending ? 1 : -1
          );
        }
        return { data: kept, error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => (filters.push(['eq', column, value]), builder),
        in: (column: string, value: unknown) => (filters.push(['in', column, value]), builder),
        order: (column: string, options?: { ascending?: boolean }) => {
          orderBy = { column, ascending: options?.ascending !== false };
          return builder;
        },
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
vi.mock('../../services/oauth', () => ({
  getOAuthService: () => ({ getValidAccessToken: fake.getValidAccessToken }),
}));
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials() {}
      },
    },
    calendar: () => ({
      freebusy: { query: fake.freebusy },
      events: { list: fake.eventsList },
    }),
  },
}));

import { GoogleCalendarService } from './service';
import {
  BUSY_DAYS_AHEAD,
  busyWindow,
  canReadFreeBusy,
  clipToWindow,
  freeBusyConnection,
  isCalendarShareLevel,
  readSpaceBusyTimes,
  type BusyBlock,
} from './space-busy-times';

const SPACE = '00000000-0000-4000-8000-00000000000a';
const OTHER_SPACE = '00000000-0000-4000-8000-00000000000b';
const ADA = '00000000-0000-4000-8000-000000000001';
const SAM = '00000000-0000-4000-8000-000000000002';
const KIT = '00000000-0000-4000-8000-000000000003';
const NOW = new Date('2026-10-16T08:00:00.000Z');
const DAY = 86_400_000;
const CALENDAR = 'https://www.googleapis.com/auth/calendar.readonly';

const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

function google(userId: string, workspaceId: string | null, scopes: string[], updatedAt: string) {
  return {
    user_id: userId,
    provider: 'google',
    status: 'active',
    workspace_id: workspaceId,
    scopes,
    updated_at: updatedAt,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.failOn = null;
  fake.tables = {
    workspace_members: [
      { workspace_id: SPACE, user_id: ADA, calendar_share: 'busy', created_at: '1' },
      { workspace_id: SPACE, user_id: SAM, calendar_share: 'busy', created_at: '2' },
      { workspace_id: SPACE, user_id: KIT, calendar_share: 'none', created_at: '3' },
      // Kit shares in another space; that says nothing about this one.
      { workspace_id: OTHER_SPACE, user_id: KIT, calendar_share: 'busy', created_at: '4' },
    ],
    users: [
      { id: ADA, first_name: 'Ada', last_name: 'L', username: 'ada', email: 'ada@example.test' },
      { id: SAM, first_name: null, last_name: null, username: 'sam', email: 'sam@example.test' },
      { id: KIT, first_name: null, last_name: null, username: null, email: 'kit@example.test' },
    ],
    connected_accounts: [
      google(ADA, SPACE, [CALENDAR], '2026-10-01'),
      google(SAM, null, [CALENDAR], '2026-10-01'),
      google(KIT, SPACE, [CALENDAR], '2026-10-01'),
    ],
  };
});

describe('the window (D7)', () => {
  it('runs from now to a year ahead, never earlier and never further', () => {
    expect(BUSY_DAYS_AHEAD).toBe(365);
    expect(busyWindow(NOW)).toEqual({ timeMin: NOW.toISOString(), timeMax: at(365 * DAY) });
    expect(busyWindow(NOW, 7)).toEqual({ timeMin: NOW.toISOString(), timeMax: at(7 * DAY) });
    for (const days of [366, 1000, Number.POSITIVE_INFINITY]) {
      expect(busyWindow(NOW, days).timeMax).toBe(at(365 * DAY));
    }
    for (const days of [0, -5, Number.NaN]) {
      expect(Date.parse(busyWindow(NOW, days).timeMin)).toBe(NOW.getTime());
      expect(Date.parse(busyWindow(NOW, days).timeMax)).toBeGreaterThan(NOW.getTime());
    }
  });

  it('clips every block to the window and drops what falls outside it', () => {
    const window = busyWindow(NOW);
    const blocks: BusyBlock[] = [
      { start: at(-3 * DAY), end: at(-2 * DAY) }, // the past: dropped
      { start: at(-3_600_000), end: at(3_600_000) }, // under way: starts now
      { start: at(DAY), end: at(DAY + 1_800_000) }, // inside: kept
      { start: at(364 * DAY), end: at(367 * DAY) }, // runs past the window: clipped
      { start: at(366 * DAY), end: at(367 * DAY) }, // beyond the window: dropped
      { start: at(2 * DAY), end: at(2 * DAY) }, // empty: dropped
      { start: 'not a time', end: at(DAY) }, // unreadable: dropped
    ];
    expect(clipToWindow(blocks, window)).toEqual([
      { start: NOW.toISOString(), end: at(3_600_000) },
      { start: at(DAY), end: at(DAY + 1_800_000) },
      { start: at(364 * DAY), end: at(365 * DAY) },
    ]);
  });
});

describe('the share levels', () => {
  it("are 'none' and 'busy' only", () => {
    expect(['none', 'busy'].every(isCalendarShareLevel)).toBe(true);
    for (const value of ['BUSY', 'details', '', null, undefined, 1]) {
      expect(isCalendarShareLevel(value)).toBe(false);
    }
  });
});

describe("a member's connection", () => {
  it('takes the one in this space, else their most recent one that can read free/busy', async () => {
    fake.tables.connected_accounts = [
      google(ADA, OTHER_SPACE, [CALENDAR], '2026-10-10'),
      google(ADA, SPACE, [CALENDAR], '2026-10-01'),
      google(SAM, OTHER_SPACE, [CALENDAR], '2026-10-01'),
      google(SAM, null, [CALENDAR], '2026-10-09'),
      // Mail only: can't answer free/busy, however recent.
      google(SAM, SPACE, ['https://www.googleapis.com/auth/gmail.readonly'], '2026-10-12'),
    ];
    const client = fakeClient();
    expect(await freeBusyConnection(client, ADA, SPACE)).toEqual({
      found: true,
      workspaceId: SPACE,
    });
    expect(await freeBusyConnection(client, SAM, SPACE)).toEqual({
      found: true,
      workspaceId: null,
    });
    expect(await freeBusyConnection(client, KIT, SPACE)).toEqual({
      found: false,
      workspaceId: SPACE,
    });
  });

  it('counts only the scopes free/busy accepts', () => {
    expect(canReadFreeBusy([CALENDAR])).toBe(true);
    expect(canReadFreeBusy(['https://www.googleapis.com/auth/calendar.freebusy'])).toBe(true);
    // Google's free/busy does not accept calendar.events alone.
    expect(canReadFreeBusy(['https://www.googleapis.com/auth/calendar.events'])).toBe(false);
    expect(canReadFreeBusy(null)).toBe(false);
  });
});

describe('readSpaceBusyTimes', () => {
  const oneHourFromWindowStart = async (
    _userId: string,
    window: { timeMin: string },
    _workspaceId: string | null
  ) => [{ start: window.timeMin, end: at(3_600_000) }];
  const busyFor = vi.fn(oneHourFromWindowStart);

  beforeEach(() => {
    busyFor.mockReset();
    busyFor.mockImplementation(oneHourFromWindowStart);
  });

  const read = (days?: number) =>
    readSpaceBusyTimes({ client: fakeClient(), busyFor, now: () => NOW }, SPACE, days);

  it('reads only the members who switched it on, each with their own connection (D6)', async () => {
    const result = await read();
    expect(busyFor.mock.calls.map(([userId, , workspaceId]) => [userId, workspaceId])).toEqual([
      [ADA, SPACE],
      [SAM, null],
    ]);
    // Kit connected Google and shares in another space: nothing of theirs here.
    expect(busyFor.mock.calls.some(([userId]) => userId === KIT)).toBe(false);
    expect(result).toEqual({
      window: { from: NOW.toISOString(), to: at(365 * DAY) },
      sharing: [
        { name: 'Ada L', busy: [{ start: NOW.toISOString(), end: at(3_600_000) }] },
        { name: 'sam', busy: [{ start: NOW.toISOString(), end: at(3_600_000) }] },
      ],
      unavailable: [],
      notSharing: ['a member of this space'],
    });
  });

  it('asks for the narrower window it is given, never a wider one', async () => {
    await read(3);
    expect(busyFor.mock.calls[0][1]).toEqual({ timeMin: NOW.toISOString(), timeMax: at(3 * DAY) });
  });

  it('reads membership and consent afresh on every call (Lumen, 18f5604b)', async () => {
    await read();
    expect(busyFor.mock.calls.map(([userId]) => userId)).toEqual([ADA, SAM]);
    busyFor.mockClear();
    // Between two asks, Ada turns sharing off and Sam leaves the space.
    fake.tables.workspace_members[0].calendar_share = 'none';
    fake.tables.workspace_members.splice(1, 1);
    const result = await read();
    expect(busyFor).not.toHaveBeenCalled();
    expect(result.sharing).toEqual([]);
    expect(result.notSharing).toEqual(['Ada L', 'a member of this space']);
    expect(JSON.stringify(result)).not.toContain('sam');
  });

  it('treats any level but busy as none', async () => {
    fake.tables.workspace_members[0].calendar_share = 'details';
    fake.tables.workspace_members[1].calendar_share = null as unknown as string;
    const result = await read();
    expect(busyFor).not.toHaveBeenCalled();
    expect(result.sharing).toEqual([]);
    expect(result.notSharing).toHaveLength(3);
  });

  it("names a sharer whose calendar can't be read, and why, without failing the rest", async () => {
    fake.tables.connected_accounts = [google(ADA, SPACE, [CALENDAR], '2026-10-01')];
    busyFor.mockImplementation(async (userId) => {
      if (userId === ADA) throw new Error('Google said no');
      throw new Error('No active google account found');
    });
    const result = await read();
    expect(result.sharing).toEqual([]);
    expect(result.unavailable).toEqual([
      { name: 'Ada L', reason: 'their Google calendar could not be read just now' },
      { name: 'sam', reason: 'they have no Google calendar connected' },
    ]);
  });

  it('never carries an email address, whatever the users row holds', async () => {
    expect(JSON.stringify(await read())).not.toMatch(/@example\.test/);
  });

  it('refuses when the members cannot be read', async () => {
    fake.failOn = 'workspace_members';
    await expect(read()).rejects.toThrow("Could not read the space's members");
    expect(busyFor).not.toHaveBeenCalled();
  });
});

describe('GoogleCalendarService.primaryBusy', () => {
  const window = { timeMin: NOW.toISOString(), timeMax: at(28 * DAY) };

  it('asks about a year in 60-day pieces that tile it exactly, and joins a block across a seam', async () => {
    const year = { timeMin: NOW.toISOString(), timeMax: at(365 * DAY) };
    fake.freebusy.mockImplementation(async ({ requestBody }: { requestBody: Row }) => {
      const from = Date.parse(requestBody.timeMin as string);
      const to = Date.parse(requestBody.timeMax as string);
      // One event straddles the first seam; Google answers it in each piece.
      const seam = NOW.getTime() + 60 * DAY;
      const busy =
        from < seam && seam <= to
          ? [{ start: new Date(seam - 3_600_000).toISOString(), end: new Date(seam).toISOString() }]
          : from === seam
            ? [
                {
                  start: new Date(seam).toISOString(),
                  end: new Date(seam + 3_600_000).toISOString(),
                },
              ]
            : [];
      return { data: { calendars: { primary: { busy } } } };
    });
    const busy = await new GoogleCalendarService().primaryBusy(SAM, year, null);
    const asked = fake.freebusy.mock.calls.map(([{ requestBody }]) => [
      requestBody.timeMin,
      requestBody.timeMax,
    ]);
    expect(asked).toHaveLength(7);
    expect(asked[0]![0]).toBe(year.timeMin);
    expect(asked[6]![1]).toBe(year.timeMax);
    for (let i = 1; i < asked.length; i++) expect(asked[i]![0]).toBe(asked[i - 1]![1]);
    for (const [from, to] of asked) {
      expect(Date.parse(to as string) - Date.parse(from as string)).toBeLessThanOrEqual(60 * DAY);
    }
    expect(busy).toEqual([{ start: at(60 * DAY - 3_600_000), end: at(60 * DAY + 3_600_000) }]);
  });

  it('asks free/busy for the primary calendar with the chosen connection, and reads no event', async () => {
    fake.freebusy.mockResolvedValue({
      data: {
        calendars: {
          primary: {
            busy: [
              { start: at(DAY), end: at(DAY + 3_600_000), summary: 'Dentist' },
              { start: at(2 * DAY) },
            ],
          },
        },
      },
    });
    const busy = await new GoogleCalendarService().primaryBusy(SAM, window, null);
    expect(fake.getValidAccessToken).toHaveBeenCalledWith(SAM, 'google', null);
    expect(fake.freebusy).toHaveBeenCalledWith({
      requestBody: { ...window, items: [{ id: 'primary' }] },
    });
    expect(fake.eventsList).not.toHaveBeenCalled();
    expect(busy).toEqual([{ start: at(DAY), end: at(DAY + 3_600_000) }]);
  });

  it('refuses when Google reports an error for the calendar, rather than calling it free', async () => {
    fake.freebusy.mockResolvedValue({
      data: { calendars: { primary: { errors: [{ domain: 'global', reason: 'notFound' }] } } },
    });
    await expect(new GoogleCalendarService().primaryBusy(SAM, window, null)).rejects.toThrow(
      'Google could not read free/busy: notFound'
    );
  });

  it('refuses when Google returns no calendar at all', async () => {
    fake.freebusy.mockResolvedValue({ data: { calendars: {} } });
    await expect(new GoogleCalendarService().primaryBusy(SAM, window, null)).rejects.toThrow(
      'no free/busy'
    );
  });
});
