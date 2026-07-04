/**
 * groupTimelineEntries — single-level fork-tree grouping for the session
 * timeline. Entries whose parentId resolves to a visible entry render
 * indented under their nearest visible top-level ancestor; chains deeper
 * than one level are flattened into that ancestor's group so nothing is
 * dropped. Entries with an unmatched parentId stay top-level.
 *
 * See ink://specs/live-session-experience (WS2).
 */

export interface TimelineEntryLike {
  id: string;
  parentId?: string | null;
}

export interface GroupedTimeline<T extends TimelineEntryLike> {
  /** Entries with no visible ancestor, in input order. */
  topLevel: T[];
  /** Children keyed by their top-level ancestor's raw id, in input order. */
  childrenByAnchor: Map<string, T[]>;
}

export function groupTimelineEntries<T extends TimelineEntryLike>(
  entries: T[],
  rawId: (id: string) => string
): GroupedTimeline<T> {
  const byRawId = new Map<string, T>();
  for (const entry of entries) {
    byRawId.set(rawId(entry.id), entry);
  }

  // rawId → its top-level ancestor's rawId, or null if the entry is itself
  // top-level. Memoized; `walking` guards against parentId cycles.
  const anchorCache = new Map<string, string | null>();

  const anchorFor = (entry: T, walking: Set<string>): string | null => {
    const id = rawId(entry.id);
    const cached = anchorCache.get(id);
    if (cached !== undefined) return cached;

    const parentId = entry.parentId;
    if (!parentId || parentId === id || walking.has(id)) {
      anchorCache.set(id, null);
      return null;
    }
    const parent = byRawId.get(parentId);
    if (!parent) {
      // Unmatched parent — keep the entry visible at top level.
      anchorCache.set(id, null);
      return null;
    }

    walking.add(id);
    const parentAnchor = anchorFor(parent, walking);
    walking.delete(id);

    // Flatten: a grandchild anchors to its parent's anchor (the first-level
    // group), not to the parent itself. An entry can never anchor to itself
    // (possible under parentId cycles) — that would orphan its group.
    const anchor = parentAnchor ?? rawId(parent.id);
    const resolved = anchor === id ? null : anchor;
    anchorCache.set(id, resolved);
    return resolved;
  };

  const topLevel: T[] = [];
  const childrenByAnchor = new Map<string, T[]>();
  for (const entry of entries) {
    const anchor = anchorFor(entry, new Set());
    if (anchor === null) {
      topLevel.push(entry);
    } else {
      const group = childrenByAnchor.get(anchor) || [];
      group.push(entry);
      childrenByAnchor.set(anchor, group);
    }
  }

  return { topLevel, childrenByAnchor };
}
