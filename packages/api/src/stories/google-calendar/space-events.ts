/**
 * A space's SB creates an event with the people whose calendars are in it.
 * Conor chose the simple form on Oct 16 (option (a)): the SB shows the event
 * in the conversation, asks the person it is for, and creates it on their yes.
 * He accepted that the yes is the SB's to judge.
 *
 * - The event goes on the organizer's own primary calendar, written with the
 *   organizer's own Google connection; the others are invited as attendees,
 *   and Google emails them.
 * - Everyone named, organizer and attendees alike, must be a member of the
 *   calling SB's space with "share my busy times here" switched on there
 *   (D6). Nobody else's calendar is read or written, and nobody else is
 *   invited.
 * - The organizer's confirmation is the SB's to judge: the tool takes an
 *   explicit `organizerConfirmed: true`, and its description says to show the
 *   event and ask first. Nothing on the server can tell a real yes apart.
 * - Times are instants from now to a year ahead (D7), never the past.
 * - No address reaches the SB: people are named as the space reads them, and
 *   the answer names them the same way.
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { logger } from '../../utils/logger';
import type { CreateEventOptions } from './types';
import { getGoogleCalendarService } from './service';
import {
  BUSY_DAYS_AHEAD,
  calendarConnection,
  canWriteEvents,
  displayName,
  freeBusyConnection,
  resolveCallerSpace,
  type BusyConnection,
} from './space-busy-times';

const DAY_MS = 86_400_000;
/** An instant with its offset: 2026-10-20T19:00:00-07:00 or …Z. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export const createSpaceEventSchema = z.object({
  sbSlug: z
    .string()
    .optional()
    .describe('Your SB slug. Omit to use the identity your connection is bound to.'),
  title: z.string().trim().min(1).max(200).describe('What the event is called'),
  start: z
    .string()
    .describe('When it starts: an instant with its offset, e.g. 2026-10-20T19:00:00-07:00'),
  end: z.string().describe('When it ends, the same way; after the start'),
  organizer: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The member who asked for it, by name as get_space_busy_times gives it. It goes on their calendar.'
    ),
  attendees: z
    .array(z.string().trim().min(1))
    .max(50)
    .default([])
    .describe('Other members to invite, by name as get_space_busy_times gives them'),
  description: z.string().max(2000).optional().describe('Notes for the invitation'),
  location: z.string().max(300).optional().describe('Where'),
  organizerConfirmed: z
    .literal(true)
    .describe(
      'True only after the organizer saw this exact event in the conversation and said yes to it'
    ),
  userId: z.string().guid().optional().describe('User UUID (if known)'),
  email: z.string().email().optional().describe('User email address'),
});

export type CreateSpaceEventInput = z.infer<typeof createSpaceEventSchema>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = { from: (table: string) => any };

interface Member {
  userId: string;
  name: string;
  sharing: boolean;
  /** The person's account address, used only if their Google account has none. */
  accountEmail: string | null;
}

/** Everyone in the space, named as the space reads them. */
async function spaceMembers(client: Client, spaceId: string): Promise<Member[]> {
  const { data: rows, error } = await client
    .from('workspace_members')
    .select('user_id, calendar_share')
    .eq('workspace_id', spaceId);
  if (error) throw new Error(`Could not read the space's members: ${error.message}`);
  const members = (rows ?? []) as Array<{ user_id: string; calendar_share: string | null }>;
  if (members.length === 0) return [];
  const { data: users, error: usersError } = await client
    .from('users')
    .select('id, first_name, last_name, username, email')
    .in(
      'id',
      members.map((member) => member.user_id)
    );
  if (usersError) throw new Error(`Could not read the space's members: ${usersError.message}`);
  const byId = new Map(
    (
      (users ?? []) as Array<{
        id: string;
        first_name: string | null;
        last_name: string | null;
        username: string | null;
        email: string | null;
      }>
    ).map((user) => [user.id, user])
  );
  return members.map((member) => {
    const user = byId.get(member.user_id);
    return {
      userId: member.user_id,
      name: displayName(user),
      sharing: member.calendar_share === 'busy',
      accountEmail: user?.email ?? null,
    };
  });
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** One member by name, or a refusal that lists who can be named. */
function memberNamed(members: Member[], name: string, role: string): Member {
  const matches = members.filter((member) => sameName(member.name, name));
  const sharers = members.filter((member) => member.sharing).map((member) => member.name);
  if (matches.length === 0) {
    throw new Error(
      `No one in this space is called "${name}" (${role}). People sharing their busy times here: ${
        sharers.join(', ') || 'none'
      }.`
    );
  }
  if (matches.length > 1) {
    throw new Error(`More than one person in this space is called "${name}" (${role}).`);
  }
  const [member] = matches;
  if (!member.sharing) {
    throw new Error(
      `${member.name} hasn't switched "share my busy times here" on in this space, so their calendar can't be used. They can turn it on in the space screen.`
    );
  }
  return member;
}

/** Start and end as instants, inside now … a year ahead, end after start. */
export function eventWindow(start: string, end: string, now: Date): { start: string; end: string } {
  if (!INSTANT.test(start) || !INSTANT.test(end)) {
    throw new Error(
      'start and end must be instants with an offset, e.g. 2026-10-20T19:00:00-07:00'
    );
  }
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (Number.isNaN(from) || Number.isNaN(to)) throw new Error('start or end is not a real time');
  if (from < now.getTime()) throw new Error('The event would start in the past');
  if (from > now.getTime() + BUSY_DAYS_AHEAD * DAY_MS) {
    throw new Error('The event would start more than a year from now');
  }
  if (to <= from) throw new Error('The event must end after it starts');
  return { start, end };
}

export interface SpaceEventDeps {
  client: Client;
  /** Creates the event on the organizer's calendar with the chosen connection. */
  createEvent: (
    userId: string,
    options: CreateEventOptions,
    connection: BusyConnection
  ) => Promise<{ id: string }>;
  now?: () => Date;
}

/** The invitation address for a member: their Google account's, else their account's. */
async function inviteAddress(client: Client, member: Member, spaceId: string): Promise<string> {
  const connection = await freeBusyConnection(client, member.userId, spaceId);
  if (connection.accountId) {
    const { data } = await client
      .from('connected_accounts')
      .select('email')
      .eq('id', connection.accountId)
      .maybeSingle();
    const address = (data as { email?: string | null } | null)?.email;
    if (address) return address;
  }
  if (member.accountEmail) return member.accountEmail;
  throw new Error(`${member.name} can't be invited: there's no address to send it to.`);
}

/** Creates the event; the answer names people, never their addresses. */
export async function createSpaceEvent(
  deps: SpaceEventDeps,
  spaceId: string,
  input: CreateSpaceEventInput
): Promise<{ title: string; start: string; end: string; organizer: string; invited: string[] }> {
  const window = eventWindow(input.start, input.end, (deps.now ?? (() => new Date()))());
  const members = await spaceMembers(deps.client, spaceId);
  const organizer = memberNamed(members, input.organizer, 'organizer');
  const invited: Member[] = [];
  for (const name of input.attendees) {
    const member = memberNamed(members, name, 'attendee');
    if (member.userId !== organizer.userId && !invited.includes(member)) invited.push(member);
  }

  const connection = await calendarConnection(
    deps.client,
    organizer.userId,
    spaceId,
    canWriteEvents
  );
  if (!connection.found) {
    throw new Error(
      `${organizer.name}'s Google connection can't add events to their calendar. They can reconnect Google in Connectors.`
    );
  }
  const addresses = await Promise.all(
    invited.map((member) => inviteAddress(deps.client, member, spaceId))
  );

  await deps.createEvent(
    organizer.userId,
    {
      summary: input.title,
      description: input.description,
      location: input.location,
      start: { dateTime: window.start },
      end: { dateTime: window.end },
      attendees: addresses,
    },
    connection
  );
  return {
    title: input.title,
    start: window.start,
    end: window.end,
    organizer: organizer.name,
    invited: invited.map((member) => member.name),
  };
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/** create_space_event: one event on a sharing member's calendar, after their yes. */
export async function handleCreateSpaceEvent(
  args: unknown,
  dataComposer: DataComposer,
  options: { createEvent?: SpaceEventDeps['createEvent']; now?: () => Date } = {}
): Promise<ToolResult> {
  const params = createSpaceEventSchema.parse(args);
  const { client, workspaceId, sbId } = await resolveCallerSpace(
    params,
    dataComposer,
    "Only a space's SB can create an event for its members"
  );
  const calendar = getGoogleCalendarService();
  const event = await createSpaceEvent(
    {
      client,
      createEvent:
        options.createEvent ??
        ((userId, eventOptions, connection) =>
          calendar.createEvent(userId, eventOptions, connection)),
      now: options.now,
    },
    workspaceId,
    params
  );
  logger.info('Created a space event', { workspaceId, sbId, invited: event.invited.length });
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          event,
          note: `It's on ${event.organizer}'s calendar. Google emails the invitations.`,
        }),
      },
    ],
  };
}
