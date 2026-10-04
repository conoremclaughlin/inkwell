/**
 * The reaction context an SB is shown with its next turn in a thread: people's
 * reactions to that SB's own messages, one line per message (spec
 * inkling-reactions v2, "Reactions and an SB's turns", item 2; design
 * ink://designs/reaction-context-next-turn).
 *
 * Pure: it renders a batch already claimed for this turn and reads or writes
 * nothing. It reports exactly which claimed reactions it rendered, so only
 * those can be acknowledged as delivered; the rest go back to pending and
 * are counted, never silently dropped (Lumen, 3800b00e). A reaction is never
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
  /**
   * Reactions still pending beyond this batch's bound: a measured count, or
   * 'unmeasured' when the claim knows there are more but not how many.
   */
  pendingBeyond?: number | 'unmeasured';
}

export interface ReactionContextFormat {
  /** Person ids to display names; an unknown id reads as "Someone". */
  names: ReadonlyMap<string, string>;
  /** The user's timezone, for the message times. */
  timeZone: string;
  /** The block's text budget. The first message's line is always rendered. */
  maxChars?: number;
}

export interface RenderedReactionContext {
  /** The block, or null when it has nothing to show. */
  text: string | null;
  /** The claimed reactions the block shows: the only ones to acknowledge. */
  renderedReactionIds: string[];
  /** Claimed but not shown (over the budget, or no message): to release. */
  unrenderedReactionIds: string[];
}

export const REACTION_CONTEXT_MAX_CHARS = 1500;
const EXCERPT_CHARS = 40;
const HEADER = `New reactions to your messages. ${REACTIONS_ARE_NOT_APPROVAL}`;

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

function moreLine(count: number | 'unmeasured'): string {
  if (count === 'unmeasured') return '- More reactions will follow on a later turn.';
  return `- ${count} more reaction${count === 1 ? '' : 's'} will follow on a later turn.`;
}

/**
 * The block for one claimed batch. One line per message, in order of each
 * message's first reaction; the people and emoji on a line in the order they
 * first reacted. Whole lines only, in order, until the text budget: the first
 * line that does not fit ends the block, and its reactions and every later
 * message's are reported unrendered and counted as more to follow.
 */
export function formatReactionContext(
  batch: ReactionContextBatch,
  format: ReactionContextFormat
): RenderedReactionContext {
  const maxChars = format.maxChars ?? REACTION_CONTEXT_MAX_CHARS;
  const messages = new Map(batch.messages.map((m) => [m.id, m]));
  const byMessage = new Map<string, ContextReaction[]>();
  const unrendered: string[] = [];
  const ordered = [...batch.reactions].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  );
  for (const reaction of ordered) {
    if (!messages.has(reaction.messageId)) {
      unrendered.push(reaction.id);
      continue;
    }
    const list = byMessage.get(reaction.messageId) ?? [];
    list.push(reaction);
    byMessage.set(reaction.messageId, list);
  }

  const lines: string[] = [];
  const rendered: string[] = [];
  let budgetSpent = false;
  for (const [messageId, reactions] of byMessage) {
    if (budgetSpent) {
      unrendered.push(...reactions.map((r) => r.id));
      continue;
    }
    const message = messages.get(messageId)!;
    const reactors = [...new Set(reactions.map((r) => r.reactorUserId))];
    const emoji = [...new Set(reactions.map((r) => r.emoji))].join(' ');
    const quoted = excerpt(message.content);
    const line =
      `- ${people(reactors, format.names)} reacted ${emoji} to your ` +
      `${when(message, reactions[0].createdAt, format.timeZone)} message` +
      (quoted ? ` "${quoted}"` : '');
    // Room for the header, these lines, this one, and a "more" line after it.
    const length = [HEADER, ...lines, line, moreLine(999)].join('\n').length;
    if (lines.length > 0 && length > maxChars) {
      budgetSpent = true;
      unrendered.push(...reactions.map((r) => r.id));
      continue;
    }
    lines.push(line);
    rendered.push(...reactions.map((r) => r.id));
  }
  if (lines.length === 0) {
    return { text: null, renderedReactionIds: [], unrenderedReactionIds: unrendered };
  }

  const beyond = batch.pendingBeyond ?? 0;
  const more = beyond === 'unmeasured' ? 'unmeasured' : beyond + unrendered.length;
  if (more === 'unmeasured' || more > 0) lines.push(moreLine(more));
  return {
    text: [HEADER, ...lines].join('\n'),
    renderedReactionIds: rendered,
    unrenderedReactionIds: unrendered,
  };
}
