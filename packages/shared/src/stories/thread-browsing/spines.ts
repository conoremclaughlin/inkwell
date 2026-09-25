/**
 * Which threads the list shows, and what each row says about its thread.
 *
 * A spine is everything the server knows about one thread key: the
 * conversation, and the sessions, studios and task groups working on it.
 */

import type { SpineSession, ThreadSpine } from '../threads-api/index.js';
import type { NameFor } from '../thread-viewing/index.js';

export type StatusFilter = 'all' | 'unread' | 'active' | 'closed';

/**
 * A session's relation to a key, in words a reader shouldn't have to decode:
 * "routed here" = the key is the session's immutable routing anchor (where
 * inbox triggers landed it); "working now" = the session's mutable current
 * focus; both when they coincide. These are session facts, not studios.
 */
export const SESSION_RELATION_LABELS: Readonly<Record<SpineSession['relation'], string>> = {
  anchor: 'routed here',
  active: 'working now',
  both: 'routed · working',
};

/**
 * A spine the list shows: one with a conversation. A key that only a
 * session references has nothing to read yet, so it stays out of the list;
 * a direct link to the key still opens it.
 */
export function isConversation(spine: ThreadSpine): boolean {
  return spine.thread !== null;
}

/** The server decides liveness (isSessionLive); lifecycle is the fallback for older payloads. */
export function isSessionLive(session: SpineSession): boolean {
  return session.live ?? (session.lifecycle === 'running' || session.lifecycle === 'generating');
}

export function hasLiveSession(spine: ThreadSpine): boolean {
  return spine.sessions.some(isSessionLive);
}

/** SBs working on the key right now, each once. */
export function liveAgentsOf(spine: ThreadSpine): string[] {
  return [
    ...new Set(spine.sessions.filter(isSessionLive).flatMap((s) => (s.sbSlug ? [s.sbSlug] : []))),
  ];
}

/**
 * Where a spine sits in the work lifecycle:
 * - unannounced: someone is on the key but no thread exists — work begun,
 *   nothing said.
 * - active: open thread, or any live session on the key.
 * - closed: thread closed and nothing live.
 */
export function spineStatus(spine: ThreadSpine): 'active' | 'unannounced' | 'closed' {
  if (!spine.thread) return 'unannounced';
  if (spine.thread.status === 'closed' && !hasLiveSession(spine)) return 'closed';
  return 'active';
}

export function displayTitle(spine: ThreadSpine): string | null {
  return spine.thread?.title ?? spine.taskGroups[0]?.title ?? null;
}

/**
 * The list's search box: `needle` (already lowercased and trimmed) against
 * the key, the title, the summary, the newest message's preview, and the
 * participants by slug and by display name. So "pr:670", "Lumen" and a
 * phrase from the last reply all find the thread.
 */
export function matchesThreadSearch(spine: ThreadSpine, needle: string, nameFor: NameFor): boolean {
  if (!needle) return true;
  const haystack = [
    spine.key,
    displayTitle(spine) ?? '',
    spine.thread?.summary ?? '',
    spine.thread?.lastMessage?.preview ?? '',
    ...spine.participants,
    ...spine.participants.map(nameFor),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}
