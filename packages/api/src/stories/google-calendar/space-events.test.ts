/**
 * A space's SB creating an event with the people whose calendars are in it
 * (Conor, Oct 16, option (a)). The database and Google are fakes; the people,
 * spaces and addresses are invented.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const fake = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
}));

/** Filters eq/in, orders by one column; enough for the reads under test. */
function fakeClient() {
  return {
    from(table: string) {
      const filters: Array<[string, string, unknown]> = [];
      let orderBy: { column: string; ascending: boolean } | null = null;
      const rows = () => {
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
vi.mock('../../services/oauth', () => ({ getOAuthService: () => ({}) }));

import { createSpaceEvent, createSpaceEventSchema, eventWindow } from './space-events';

const SPACE = '00000000-0000-4000-8000-00000000000a';
const OTHER_SPACE = '00000000-0000-4000-8000-00000000000b';
const ADA = '00000000-0000-4000-8000-000000000001';
const SAM = '00000000-0000-4000-8000-000000000002';
const KIT = '00000000-0000-4000-8000-000000000003';
const LEE = '00000000-0000-4000-8000-000000000004';
const NOW = new Date('2026-10-16T18:00:00.000Z');
const READ = 'https://www.googleapis.com/auth/calendar.readonly';
const WRITE = 'https://www.googleapis.com/auth/calendar.events';

const createEvent = vi.fn(async (..._args: unknown[]) => ({ id: 'event-1' }));

function account(id: string, userId: string, scopes: string[], email: string | null) {
  return {
    id,
    user_id: userId,
    provider: 'google',
    status: 'active',
    workspace_id: SPACE,
    scopes,
    email,
    updated_at: '2026-10-01',
  };
}

beforeEach(() => {
  createEvent.mockClear();
  fake.tables = {
    workspace_members: [
      { workspace_id: SPACE, user_id: ADA, calendar_share: 'busy' },
      { workspace_id: SPACE, user_id: SAM, calendar_share: 'busy' },
      { workspace_id: SPACE, user_id: KIT, calendar_share: 'none' },
      // Lee shares, but in another space only.
      { workspace_id: OTHER_SPACE, user_id: LEE, calendar_share: 'busy' },
    ],
    users: [
      { id: ADA, first_name: 'Ada', last_name: null, username: null, email: 'ada@example.test' },
      { id: SAM, first_name: 'Sam', last_name: null, username: null, email: 'sam@example.test' },
      { id: KIT, first_name: 'Kit', last_name: null, username: null, email: 'kit@example.test' },
      { id: LEE, first_name: 'Lee', last_name: null, username: null, email: 'lee@example.test' },
    ],
    connected_accounts: [
      account('acct-ada', ADA, [READ, WRITE], 'ada.cal@example.test'),
      account('acct-sam', SAM, [READ, WRITE], 'sam.cal@example.test'),
      account('acct-kit', KIT, [READ, WRITE], 'kit.cal@example.test'),
      account('acct-lee', LEE, [READ, WRITE], 'lee.cal@example.test'),
    ],
  };
});

const input = (overrides: Partial<Record<string, unknown>> = {}) =>
  createSpaceEventSchema.parse({
    title: 'Dinner',
    start: '2026-10-20T19:00:00-07:00',
    end: '2026-10-20T21:00:00-07:00',
    organizer: 'Ada',
    attendees: ['Sam'],
    organizerConfirmed: true,
    ...overrides,
  });

const create = (overrides: Partial<Record<string, unknown>> = {}) =>
  createSpaceEvent({ client: fakeClient(), createEvent, now: () => NOW }, SPACE, input(overrides));

describe('create_space_event', () => {
  it("puts it on the organizer's calendar with their own connection, and invites the others by their Google address", async () => {
    const event = await create();
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(createEvent).toHaveBeenCalledWith(
      ADA,
      {
        summary: 'Dinner',
        description: undefined,
        location: undefined,
        start: { dateTime: '2026-10-20T19:00:00-07:00' },
        end: { dateTime: '2026-10-20T21:00:00-07:00' },
        attendees: ['sam.cal@example.test'],
      },
      { found: true, workspaceId: SPACE, accountId: 'acct-ada' }
    );
    // The answer names people; no address reaches the SB.
    expect(event).toEqual({
      title: 'Dinner',
      start: '2026-10-20T19:00:00-07:00',
      end: '2026-10-20T21:00:00-07:00',
      organizer: 'Ada',
      invited: ['Sam'],
    });
    expect(JSON.stringify(event)).not.toContain('@');
  });

  it('matches names however they are cased, and never invites the organizer or anyone twice', async () => {
    await create({ organizer: 'ada', attendees: ['SAM', 'Ada', 'sam '] });
    expect((createEvent.mock.calls[0]![1] as { attendees: string[] }).attendees).toEqual([
      'sam.cal@example.test',
    ]);
  });

  it("refuses an organizer who hasn't switched sharing on, and creates nothing", async () => {
    fake.tables.workspace_members[0].calendar_share = 'none';
    await expect(create()).rejects.toThrow(`Ada hasn't switched "share my busy times here" on`);
    expect(createEvent).not.toHaveBeenCalled();
  });

  it("refuses an attendee who hasn't switched sharing on, and creates nothing at all", async () => {
    await expect(create({ attendees: ['Sam', 'Kit'] })).rejects.toThrow(
      `Kit hasn't switched "share my busy times here" on`
    );
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('refuses someone outside the space, even one sharing elsewhere, naming who can be invited', async () => {
    await expect(create({ attendees: ['Lee'] })).rejects.toThrow(
      'No one in this space is called "Lee" (attendee). People sharing their busy times here: Ada, Sam.'
    );
    await expect(create({ organizer: 'Lee' })).rejects.toThrow('(organizer)');
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('refuses a name two members share', async () => {
    fake.tables.users[1].first_name = 'Ada';
    await expect(create({ attendees: [] })).rejects.toThrow(
      'More than one person in this space is called "Ada" (organizer).'
    );
    expect(createEvent).not.toHaveBeenCalled();
  });

  it("refuses when the organizer's connection can't add events, pointing to Connectors", async () => {
    fake.tables.connected_accounts[0].scopes = [READ];
    await expect(create()).rejects.toThrow(
      "Ada's Google connection can't add events to their calendar. They can reconnect Google in Connectors."
    );
    expect(createEvent).not.toHaveBeenCalled();
  });

  it("writes with the organizer's connection that can add events, not a newer read-only one", async () => {
    fake.tables.connected_accounts.push({
      ...account('acct-ada-read', ADA, [READ], 'ada.other@example.test'),
      updated_at: '2026-10-15',
    });
    await create();
    expect(createEvent.mock.calls[0]![2]).toEqual({
      found: true,
      workspaceId: SPACE,
      accountId: 'acct-ada',
    });
  });

  it("invites by the person's account address when their Google account has none", async () => {
    fake.tables.connected_accounts[1].email = null;
    await create();
    expect((createEvent.mock.calls[0]![1] as { attendees: string[] }).attendees).toEqual([
      'sam@example.test',
    ]);
  });
});

describe("the event's time", () => {
  it('runs from now to a year ahead and ends after it starts', () => {
    // 19:00 at -07:00 is 02:00Z the next day; the end is after it in any zone.
    expect(eventWindow('2026-10-20T19:00:00-07:00', '2026-10-21T04:00:00Z', NOW)).toEqual({
      start: '2026-10-20T19:00:00-07:00',
      end: '2026-10-21T04:00:00Z',
    });
    expect(() => eventWindow('2026-10-20T19:00:00-07:00', '2026-10-20T21:00:00Z', NOW)).toThrow(
      'end after it starts'
    );
    expect(() => eventWindow('2026-10-16T17:00:00Z', '2026-10-16T19:00:00Z', NOW)).toThrow(
      'in the past'
    );
    expect(() => eventWindow('2027-10-17T18:00:00Z', '2027-10-17T19:00:00Z', NOW)).toThrow(
      'more than a year'
    );
    expect(() => eventWindow('2026-10-20T19:00:00Z', '2026-10-20T19:00:00Z', NOW)).toThrow(
      'end after it starts'
    );
    for (const [start, end] of [
      ['2026-10-20', '2026-10-21'],
      ['2026-10-20T19:00:00', '2026-10-20T21:00:00'],
      ['tomorrow at 7', 'tomorrow at 9'],
    ]) {
      expect(() => eventWindow(start, end, NOW)).toThrow('instants with an offset');
    }
  });

  it('creates nothing for a time outside it', async () => {
    await expect(
      create({ start: '2026-10-16T17:00:00Z', end: '2026-10-16T19:00:00Z' })
    ).rejects.toThrow('in the past');
    expect(createEvent).not.toHaveBeenCalled();
  });
});

describe('the confirmation', () => {
  it('is required, and only as true', () => {
    for (const organizerConfirmed of [undefined, false, 'yes', 1]) {
      expect(
        createSpaceEventSchema.safeParse({
          title: 'Dinner',
          start: '2026-10-20T19:00:00-07:00',
          end: '2026-10-20T21:00:00-07:00',
          organizer: 'Ada',
          organizerConfirmed,
        }).success
      ).toBe(false);
    }
  });
});
