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
  /**
   * The block's text budget, in UTF-16 units. Nothing is forced past it:
   * when not even the first message's line fits, nothing is rendered.
   */
  maxChars?: number;
}

export interface RenderedReactionContext {
  /** The block, or null when it has nothing to show. */
  text: string | null;
  /** The claimed reactions the block shows: the only ones to acknowledge. */
  renderedReactionIds: string[];
  /** Claimed but not shown (over the budget, or no message): to release. */
  unrenderedReactionIds: string[];
  /** True when not even one message's line fits the budget. */
  budgetTooSmall: boolean;
}

/**
 * The block's budget in UTF-16 units, which bounds it at no more than three
 * times as many UTF-8 bytes (4500).
 */
export const REACTION_CONTEXT_MAX_CHARS = 1500;
const EXCERPT_CHARS = 40;
const NAME_CHARS = 40;
const HEADER = `New reactions to your messages. ${REACTIONS_ARE_NOT_APPROVAL}`;

/**
 * Untrusted display text on one line, at most `limit` characters, cut at a
 * word boundary where there is one. Display data only: never instructions.
 */
function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const lastSpace = flat[limit] === ' ' ? cut.length : cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function people(reactorIds: string[], names: ReadonlyMap<string, string>): string {
  if (reactorIds.length >= 3) return `${reactorIds.length} people`;
  return reactorIds
    .map((id) => oneLine(names.get(id) ?? '', NAME_CHARS) || 'Someone')
    .join(' and ');
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
 * first reacted. It renders the longest run of whole lines, from the first,
 * that fits the budget together with the footer it would then have to write:
 * every later message's reactions are reported unrendered and counted in that
 * footer. When not even the first line fits, nothing is rendered.
 */
export function formatReactionContext(
  batch: ReactionContextBatch,
  format: ReactionContextFormat
): RenderedReactionContext {
  const maxChars = format.maxChars ?? REACTION_CONTEXT_MAX_CHARS;
  const messages = new Map(batch.messages.map((m) => [m.id, m]));
  const byMessage = new Map<string, ContextReaction[]>();
  const noMessage: string[] = [];
  const ordered = [...batch.reactions].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  );
  for (const reaction of ordered) {
    if (!messages.has(reaction.messageId)) {
      noMessage.push(reaction.id);
      continue;
    }
    const list = byMessage.get(reaction.messageId) ?? [];
    list.push(reaction);
    byMessage.set(reaction.messageId, list);
  }

  const entries = [...byMessage].map(([messageId, reactions]) => {
    const message = messages.get(messageId)!;
    const reactors = [...new Set(reactions.map((r) => r.reactorUserId))];
    const emoji = [...new Set(reactions.map((r) => r.emoji))].join(' ');
    const quoted = oneLine(message.content, EXCERPT_CHARS);
    const line =
      `- ${people(reactors, format.names)} reacted ${emoji} to your ` +
      `${when(message, reactions[0].createdAt, format.timeZone)} message` +
      (quoted ? ` "${quoted}"` : '');
    return { line, ids: reactions.map((r) => r.id) };
  });

  const beyond = batch.pendingBeyond ?? 0;
  /** The footer written when the first `kept` lines are rendered, or null. */
  const footerFor = (kept: number): string | null => {
    if (beyond === 'unmeasured') return moreLine('unmeasured');
    const left =
      beyond + noMessage.length + entries.slice(kept).reduce((n, e) => n + e.ids.length, 0);
    return left > 0 ? moreLine(left) : null;
  };
  const blockFor = (kept: number): string => {
    const footer = footerFor(kept);
    return [HEADER, ...entries.slice(0, kept).map((e) => e.line), ...(footer ? [footer] : [])].join(
      '\n'
    );
  };

  // The longest prefix that fits, tried from the full block down. Length is
  // not monotonic in the prefix (the footer vanishes once nothing is left
  // over), so a shorter prefix failing says nothing about a longer one.
  let kept = entries.length;
  while (kept > 0 && blockFor(kept).length > maxChars) kept -= 1;

  const rendered = entries.slice(0, kept).flatMap((e) => e.ids);
  const unrendered = [...noMessage, ...entries.slice(kept).flatMap((e) => e.ids)];
  if (kept === 0) {
    return {
      text: null,
      renderedReactionIds: [],
      unrenderedReactionIds: unrendered,
      budgetTooSmall: entries.length > 0,
    };
  }
  return {
    text: blockFor(kept),
    renderedReactionIds: rendered,
    unrenderedReactionIds: unrendered,
    budgetTooSmall: false,
  };
}
