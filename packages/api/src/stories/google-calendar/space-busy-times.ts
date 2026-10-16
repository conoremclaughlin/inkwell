/**
 * A space's members' busy times, for the space's SB (ink://specs/
 * inkling-multi-person-groups D5-D7: calendar coordination between members).
 *
 * - D6: nothing of a member's calendar is shared until that member switches
 *   "share my busy times here" on in this space
 *   (workspace_members.calendar_share = 'busy'). Connecting a calendar sets
 *   nothing. Only the member sets it (routes/admin-calendar-share.ts).
 * - D7: busy blocks only, from now to a year ahead. Google's free/busy
 *   query is the only read, so no title, place or attendee is ever fetched.
 *   Every block is clipped to the window, so nothing before now comes back.
 *   No argument widens the window or reads anyone who hasn't switched it on.
 *
 * Each member's calendar is read with that member's own Google connection,
 * the one in this space if there is one, else their most recent. The space is
 * the calling SB's own (its identity's workspace), never one a request names.
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { resolveCallerWorkspace } from '../../mcp/tools/caller-principal';
import { resolveUserOrThrow } from '../../services/user-resolver';
import { logger } from '../../utils/logger';
import { getRequestContext, getSessionContext } from '../../utils/request-context';
import { getGoogleCalendarService } from './service';

/** What a member's calendar shares in a space. Richer levels come later. */
export const CALENDAR_SHARE_LEVELS = ['none', 'busy'] as const;
export type CalendarShareLevel = (typeof CALENDAR_SHARE_LEVELS)[number];

export function isCalendarShareLevel(value: unknown): value is CalendarShareLevel {
  return typeof value === 'string' && (CALENDAR_SHARE_LEVELS as readonly string[]).includes(value);
}

/** How far ahead busy times reach (D7): a year. */
export const BUSY_DAYS_AHEAD = 365;

const DAY_MS = 86_400_000;

/** The scopes Google's free/busy query accepts. */
const FREE_BUSY_SCOPES: ReadonlySet<string> = new Set([
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.events.freebusy',
]);

/** Whether a connection with these scopes can answer a free/busy query. */
export function canReadFreeBusy(scopes: readonly string[] | null | undefined): boolean {
  return (scopes ?? []).some((scope) => FREE_BUSY_SCOPES.has(scope));
}

/** The scopes Google's events.insert accepts. */
const EVENT_WRITE_SCOPES: ReadonlySet<string> = new Set([
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.events.owned',
]);

/** Whether a connection with these scopes can create an event on its calendar. */
export function canWriteEvents(scopes: readonly string[] | null | undefined): boolean {
  return (scopes ?? []).some((scope) => EVENT_WRITE_SCOPES.has(scope));
}

export interface BusyBlock {
  start: string;
  end: string;
}

export interface BusyWindow {
  timeMin: string;
  timeMax: string;
}

/** From now to `days` ahead (at most BUSY_DAYS_AHEAD), as UTC instants. */
export function busyWindow(now: Date, days: number = BUSY_DAYS_AHEAD): BusyWindow {
  const span = Math.min(Math.max(Math.trunc(days) || BUSY_DAYS_AHEAD, 1), BUSY_DAYS_AHEAD);
  return {
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + span * DAY_MS).toISOString(),
  };
}

/**
 * The blocks inside the window: each clipped to it, and any left empty, out of
 * it, or unreadable dropped. An event already under way starts at now.
 */
export function clipToWindow(blocks: readonly BusyBlock[], window: BusyWindow): BusyBlock[] {
  const min = Date.parse(window.timeMin);
  const max = Date.parse(window.timeMax);
  return blocks.flatMap((block) => {
    const start = Math.max(Date.parse(block.start), min);
    const end = Math.min(Date.parse(block.end), max);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return [];
    return [{ start: new Date(start).toISOString(), end: new Date(end).toISOString() }];
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = { from: (table: string) => any };

interface UserRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
}

/**
 * A part of a member's name, or '' when it may be an email address: a
 * username or name field can hold one, and the space must never read it.
 */
function namePart(value: string | null | undefined): string {
  const part = (value ?? '').trim();
  return part.includes('@') ? '' : part;
}

/** A member's name as the space reads it: never an email address. */
export function displayName(user: UserRow | undefined): string {
  const full = [namePart(user?.first_name), namePart(user?.last_name)].filter(Boolean).join(' ');
  return full || namePart(user?.username) || 'a member of this space';
}

/** The Google connection a member's busy times are read with. */
export interface BusyConnection {
  /** Whether a stored connection that can answer free/busy was found. */
  found: boolean;
  workspaceId: string | null;
  /** The stored connection chosen, so the token read is that one and no other. */
  accountId?: string;
}

/**
 * Which of a person's Google connections can answer a free/busy query: the
 * one in `spaceId` if it can, else their most recent one that can. `found`
 * is false when no stored connection can; the call may still succeed through
 * a credential the server holds for them (GOOGLE_CREDENTIAL_SOURCES).
 *
 * The chosen row's id travels with it: a newer connection in the same
 * workspace without a calendar scope must not be the one whose token is read
 * (Lumen, PR #882).
 */
export async function freeBusyConnection(
  client: Client,
  userId: string,
  spaceId: string
): Promise<BusyConnection> {
  return calendarConnection(client, userId, spaceId, canReadFreeBusy);
}

/**
 * The person's Google connection whose scopes `accepts` admits: the one in
 * `spaceId` if there is one, else their most recent. `found` is false when no
 * stored connection qualifies.
 */
export async function calendarConnection(
  client: Client,
  userId: string,
  spaceId: string,
  accepts: (scopes: readonly string[] | null | undefined) => boolean
): Promise<BusyConnection> {
  const { data, error } = await client
    .from('connected_accounts')
    .select('id, workspace_id, scopes')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .eq('status', 'active')
    .order('updated_at', { ascending: false });
  if (error) throw new Error(`Could not read a member's Google connection: ${error.message}`);
  const usable = (
    (data ?? []) as Array<{ id: string; workspace_id: string | null; scopes: string[] | null }>
  ).filter((row) => accepts(row.scopes));
  if (usable.length === 0) return { found: false, workspaceId: spaceId };
  const chosen = usable.find((row) => row.workspace_id === spaceId) ?? usable[0];
  return { found: true, workspaceId: chosen.workspace_id, accountId: chosen.id };
}

export interface SpaceBusyTimes {
  window: { from: string; to: string };
  /** Members sharing busy times here, with their busy blocks in the window. */
  sharing: Array<{ name: string; busy: BusyBlock[] }>;
  /** Members sharing busy times here whose calendar couldn't be read. */
  unavailable: Array<{ name: string; reason: string }>;
  /** Members who haven't switched sharing on in this space. */
  notSharing: string[];
}

export interface SpaceBusyDeps {
  client: Client;
  /** A member's primary-calendar busy blocks, read with their own connection. */
  busyFor: (userId: string, window: BusyWindow, connection: BusyConnection) => Promise<BusyBlock[]>;
  now?: () => Date;
}

/** The busy times of the space's members who switched sharing on. */
export async function readSpaceBusyTimes(
  deps: SpaceBusyDeps,
  spaceId: string,
  days?: number
): Promise<SpaceBusyTimes> {
  const window = busyWindow((deps.now ?? (() => new Date()))(), days);
  const { data: members, error } = await deps.client
    .from('workspace_members')
    .select('user_id, calendar_share')
    .eq('workspace_id', spaceId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Could not read the space's members: ${error.message}`);
  const rows = (members ?? []) as Array<{ user_id: string; calendar_share: string | null }>;

  const userIds = rows.map((row) => row.user_id);
  const { data: users, error: usersError } = userIds.length
    ? await deps.client
        .from('users')
        .select('id, first_name, last_name, username')
        .in('id', userIds)
    : { data: [], error: null };
  if (usersError) throw new Error(`Could not read the space's members: ${usersError.message}`);
  const nameOf = (userId: string) =>
    displayName(((users ?? []) as UserRow[]).find((user) => user.id === userId));

  // Anything but 'busy' shares nothing.
  const sharers = rows.filter((row) => row.calendar_share === 'busy');
  type Read = { name: string; busy: BusyBlock[] } | { name: string; reason: string };
  const reads = await Promise.all(
    sharers.map(async (row): Promise<Read> => {
      const name = nameOf(row.user_id);
      let found: boolean | null = null;
      try {
        const connection = await freeBusyConnection(deps.client, row.user_id, spaceId);
        found = connection.found;
        const blocks = await deps.busyFor(row.user_id, window, connection);
        return { name, busy: clipToWindow(blocks, window) };
      } catch (readError) {
        logger.warn("Couldn't read a member's shared busy times", {
          spaceId,
          reason: readError instanceof Error ? readError.name : 'unknown',
        });
        return {
          name,
          reason:
            found === false
              ? 'they have no Google calendar connected'
              : 'their Google calendar could not be read just now',
        };
      }
    })
  );

  return {
    window: { from: window.timeMin, to: window.timeMax },
    sharing: reads.flatMap((read) => ('busy' in read ? [read] : [])),
    unavailable: reads.flatMap((read) => ('reason' in read ? [read] : [])),
    notSharing: rows
      .filter((row) => row.calendar_share !== 'busy')
      .map((row) => nameOf(row.user_id)),
  };
}

export const getSpaceBusyTimesSchema = z.object({
  sbSlug: z
    .string()
    .optional()
    .describe('Your SB slug. Omit to use the identity your connection is bound to.'),
  days: z
    .number()
    .int()
    .min(1)
    .max(BUSY_DAYS_AHEAD)
    .optional()
    .describe(`How many days ahead from now, 1 to ${BUSY_DAYS_AHEAD} (default ${BUSY_DAYS_AHEAD})`),
  userId: z.string().guid().optional().describe('User UUID (if known)'),
  email: z.string().email().optional().describe('User email address'),
});

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/** get_space_busy_times: the calling SB's space, its sharing members' busy blocks. */
/**
 * The calling SB's own space: its identity's workspace, never one a request
 * names. A caller with no SB, or one whose identity isn't the resolved
 * user's, is refused with `refusal`.
 */
export async function resolveCallerSpace(
  params: { sbSlug?: string; userId?: string; email?: string },
  dataComposer: DataComposer,
  refusal: string
): Promise<{ client: ReturnType<DataComposer['getClient']>; workspaceId: string; sbId: string }> {
  // A person has no space of their own to ask about here; only an SB does.
  if (!params.sbSlug && !(getRequestContext() ?? getSessionContext())?.sbId) {
    throw new Error(refusal);
  }
  const { user } = await resolveUserOrThrow(params, dataComposer);
  const client = dataComposer.getClient();
  const { workspaceId, sb } = await resolveCallerWorkspace(client, user.id, params.sbSlug);
  if (!sb || sb.userId !== user.id) throw new Error(refusal);
  return { client, workspaceId, sbId: sb.sbId };
}

export async function handleGetSpaceBusyTimes(
  args: unknown,
  dataComposer: DataComposer,
  options: { busyFor?: SpaceBusyDeps['busyFor']; now?: () => Date } = {}
): Promise<ToolResult> {
  const params = getSpaceBusyTimesSchema.parse(args);
  const { client, workspaceId, sbId } = await resolveCallerSpace(
    params,
    dataComposer,
    "Only a space's SB can read its members' busy times"
  );
  const calendar = getGoogleCalendarService();
  const result = await readSpaceBusyTimes(
    {
      client,
      busyFor:
        options.busyFor ??
        ((userId, window, connection) => calendar.primaryBusy(userId, window, connection)),
      now: options.now,
    },
    workspaceId,
    params.days
  );
  logger.info('Read shared busy times', {
    workspaceId,
    sbId,
    sharing: result.sharing.length,
    unavailable: result.unavailable.length,
  });
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          ...result,
          note:
            'Busy blocks only, as UTC instants (start inclusive, end exclusive): no event ' +
            'details. Only members who switched "share my busy times here" on in this space ' +
            'are read. Someone in notSharing can turn it on in the space screen.',
        }),
      },
    ],
  };
}
