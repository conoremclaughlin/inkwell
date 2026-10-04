/**
 * The reaction context an SB is shown with its next turn in a thread: people's
 * reactions to that SB's own messages, one line per message (spec
 * inkling-reactions v2, "Reactions and an SB's turns", item 2; design
 * ink://designs/reaction-context-next-turn v2).
 *
 * Pure: it renders a batch already claimed for this turn and reads or writes
 * nothing. Which reactions are in the batch, and whether they were delivered,
 * is the claim protocol's business, not this module's. A reaction is never
 * approval, and the block says so first.
 */

import { REACTIONS_ARE_NOT_APPROVAL } from './thread-reactions';

/** One reaction in a claimed batch: a person's, on the SB's own message. */
export interface ContextReaction {
  id: string;
  messageId: string;
  emoji: string;
  reactorUserId: string;
  createdAt: string;
}

/** A message of the SB's that a reaction in the batch is on. */
export interface ContextMessage {
  id: string;
  createdAt: string;
  content: string;
}

export interface ReactionContextBatch {
  reactions: ContextReaction[];
  messages: ContextMessage[];
  /** Reactions left pending beyond this batch's bound, for a later turn. */
  pendingBeyond?: number;
}

export interface ReactionContextFormat {
  /** Person ids to display names; an unknown id reads as "Someone". */
  names: ReadonlyMap<string, string>;
  /** The user's timezone, for the message times. */
  timeZone: string;
}

const EXCERPT_CHARS = 40;

/** The message's first words on one line, cut at a word boundary. */
function excerpt(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (flat.length <= EXCERPT_CHARS) return flat;
  const cut = flat.slice(0, EXCERPT_CHARS);
  const lastSpace = flat[EXCERPT_CHARS] === ' ' ? cut.length : cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function people(reactorIds: string[], names: ReadonlyMap<string, string>): string {
  if (reactorIds.length >= 3) return `${reactorIds.length} people`;
  return reactorIds.map((id) => names.get(id) ?? 'Someone').join(' and ');
}

function localDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(new Date(iso));
}

/** "3:02 PM", or "Oct 3, 9:30 AM" when the message is from an earlier day than its first reaction. */
function when(message: ContextMessage, firstReactionAt: string, timeZone: string): string {
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(message.createdAt));
  if (localDay(message.createdAt, timeZone) === localDay(firstReactionAt, timeZone)) return time;
  const day = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(
    new Date(message.createdAt)
  );
  return `${day}, ${time}`;
}

/**
 * The block for one batch, or null when it has nothing to show. One line
 * per message, in order of each message's first reaction; the people and
 * emoji on a line in the order they first reacted.
 */
export function formatReactionContext(
  batch: ReactionContextBatch,
  format: ReactionContextFormat
): string | null {
  const messages = new Map(batch.messages.map((m) => [m.id, m]));
  const byMessage = new Map<string, ContextReaction[]>();
  const ordered = [...batch.reactions].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  );
  for (const reaction of ordered) {
    if (!messages.has(reaction.messageId)) continue;
    const list = byMessage.get(reaction.messageId) ?? [];
    list.push(reaction);
    byMessage.set(reaction.messageId, list);
  }
  if (byMessage.size === 0) return null;

  const lines = [
    `Reactions to your messages since your last turn here. ${REACTIONS_ARE_NOT_APPROVAL}`,
  ];
  for (const [messageId, reactions] of byMessage) {
    const message = messages.get(messageId)!;
    const reactors = [...new Set(reactions.map((r) => r.reactorUserId))];
    const emoji = [...new Set(reactions.map((r) => r.emoji))].join(' ');
    const quoted = excerpt(message.content);
    lines.push(
      `- ${people(reactors, format.names)} reacted ${emoji} to your ${when(message, reactions[0].createdAt, format.timeZone)} message` +
        (quoted ? ` "${quoted}"` : '')
    );
  }
  if (batch.pendingBeyond && batch.pendingBeyond > 0) {
    lines.push(`- ${batch.pendingBeyond} more reactions will follow on a later turn.`);
  }
  return lines.join('\n');
}
