/**
 * Reactions as a chat surface shows and toggles them (spec inkling-reactions).
 * A reaction is never approval: these helpers only display and toggle.
 */

import type { ConversationReaction } from './conversation.js';

/** The six choices a picker offers, with the name a screen reader says. */
export const REACTION_CHOICES: ReadonlyArray<{ emoji: string; name: string }> = [
  { emoji: '❤️', name: 'heart' },
  { emoji: '👍', name: 'thumbs up' },
  { emoji: '😂', name: 'laughing' },
  { emoji: '😮', name: 'surprised' },
  { emoji: '😢', name: 'sad' },
  { emoji: '🙏', name: 'thanks' },
];

/** At most this many emoji of one viewer on one message (the server refuses a seventh). */
export const REACTIONS_PER_VIEWER = 6;

/** What a chip says to a screen reader: "❤️, 2, including you". */
export function reactionChipLabel(reaction: ConversationReaction): string {
  return `${reaction.emoji}, ${reaction.count}${reaction.mine ? ', including you' : ''}`;
}

/** What a picker button says: "React with heart". */
export function reactionChoiceLabel(choice: { name: string }): string {
  return `React with ${choice.name}`;
}

/**
 * The request a tap makes: take the reaction back when it is already the
 * viewer's, add it otherwise.
 */
export function reactionToggle(
  emoji: string,
  reactions: ConversationReaction[] | undefined
): { emoji: string; remove: boolean } {
  return { emoji, remove: (reactions ?? []).some((r) => r.emoji === emoji && r.mine) };
}

/**
 * Whether the viewer may add this emoji: always when it is already theirs
 * (a tap takes it back), otherwise only while they have fewer than six.
 */
export function canAddReaction(
  emoji: string,
  reactions: ConversationReaction[] | undefined
): boolean {
  const mine = (reactions ?? []).filter((r) => r.mine);
  return mine.some((r) => r.emoji === emoji) || mine.length < REACTIONS_PER_VIEWER;
}

/**
 * Messages with the reactions a reaction request answered with, for
 * messages the next poll has not refreshed yet (an older page is never
 * refetched). A message the source cannot speak for keeps `undefined`.
 */
export function withReactionOverrides<T extends { id: string; reactions?: ConversationReaction[] }>(
  messages: T[],
  overrides: ReadonlyMap<string, ConversationReaction[]>
): T[] {
  if (overrides.size === 0) return messages;
  return messages.map((m) =>
    overrides.has(m.id) && m.reactions !== undefined ? { ...m, reactions: overrides.get(m.id) } : m
  );
}
