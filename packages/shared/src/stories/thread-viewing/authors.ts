/**
 * Thread payloads → the conversation shapes every chat surface renders.
 * The only place any client decides who wrote a thread message.
 */

import type { ThreadMessage } from '../threads-api/index.js';
import type { ConversationAuthor, ConversationMessage } from './conversation.js';

/** Slug → display name ("wren" → "Wren"), falling back to the slug. */
export type NameFor = (sbSlug: string) => string;

const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);

/** The viewer, as their own messages show them. */
export const YOU: ConversationAuthor = { kind: 'user', id: 'user', name: 'You', isOwn: true };
export const SYSTEM: ConversationAuthor = {
  kind: 'system',
  id: 'system',
  name: 'system',
  isOwn: false,
};

export function sbAuthor(sbSlug: string, nameFor: NameFor): ConversationAuthor {
  return { kind: 'sb', id: sbSlug, name: nameFor(sbSlug), isOwn: false };
}

export function authorOf(message: ThreadMessage, nameFor: NameFor): ConversationAuthor {
  // The server names every author and decides which person is the viewer
  // (spec inkmail-thread-scope §3); the page only maps it.
  switch (message.senderKind) {
    case 'system':
      return SYSTEM;
    case 'user':
      return message.isOwn
        ? YOU
        : {
            kind: 'user',
            id: message.senderUserId ?? 'user',
            name: message.senderName || 'a workspace member',
            isOwn: false,
          };
    default:
      return sbAuthor(message.senderSlug, nameFor);
  }
}

export function toConversationMessage(
  message: ThreadMessage,
  nameFor: NameFor
): ConversationMessage {
  const author = authorOf(message, nameFor);
  const labelled =
    author.kind !== 'system' &&
    message.messageType !== 'message' &&
    message.messageType !== 'system';
  return {
    id: message.id,
    author,
    body: message.content,
    createdAt: message.createdAt,
    label: labelled ? message.messageType : undefined,
    priority: PRIORITIES.has(message.priority)
      ? (message.priority as ConversationMessage['priority'])
      : undefined,
  };
}

/**
 * "wren" → "Wren" from the identities the dashboard already loads; an SB
 * with no identity row keeps its slug.
 */
export function nameLookup(
  identities: Array<{ sbSlug: string; name?: string | null }> | undefined
): NameFor {
  const names = new Map<string, string>();
  for (const identity of identities ?? []) {
    if (identity.name?.trim()) names.set(identity.sbSlug, identity.name.trim());
  }
  return (sbSlug) => names.get(sbSlug) ?? sbSlug;
}

/**
 * Who started a thread, for display. The server reports an SB by slug and
 * a person or the system by kind alone (spec inkmail-thread-scope §3).
 */
export function creatorLabel(createdBySlug: string, nameFor: NameFor): string {
  if (createdBySlug === 'user') return 'a person';
  if (createdBySlug === 'system') return 'the system';
  return nameFor(createdBySlug);
}
