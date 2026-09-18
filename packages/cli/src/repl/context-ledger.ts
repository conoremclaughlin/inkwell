import { createHash } from 'crypto';

export type LedgerRole = 'system' | 'user' | 'assistant' | 'inbox';

/**
 * Display-replay metadata for entries whose LEDGER representation is a
 * compact bookkeeping line but whose SCROLLBACK representation is a full
 * message block — platform messages (📤 myra → telegram). Pure display
 * data: prompt building and token accounting read `content` only, so this
 * never changes what the model sees. Carried through compaction keptEntries
 * so a platform send in the protected tail still replays as a message
 * block after compact → detach → reattach (Lumen, PR #478 review).
 */
export interface LedgerReplayMeta {
  role: 'user' | 'assistant';
  label: string;
  body: string;
  at?: string;
}

export interface LedgerEntry {
  id: number;
  role: LedgerRole;
  content: string;
  source?: string;
  createdAt: string;
  approxTokens: number;
  /**
   * Transcript event id this entry was hydrated from (file-relative,
   * stamped by appendTranscript). Undefined for live entries that haven't
   * been individually tracked — eviction refs fall back to content hash.
   */
  eid?: number;
  /** Display-replay metadata (see LedgerReplayMeta). */
  replay?: LedgerReplayMeta;
}

/**
 * Content-addressed reference for an entry — used by persistent eviction
 * (context_evict transcript events) to identify entries across reattach.
 * Stable as long as the role + stored content are reproduced identically
 * by hydration (they are — ledger transformations are deterministic).
 */
export function entryRefHash(role: string, content: string): string {
  return 'sha1:' + createHash('sha1').update(`${role}|${content}`).digest('hex').slice(0, 16);
}

export interface LedgerBookmark {
  id: string;
  label: string;
  entryId: number;
  entryIndex: number;
  createdAt: string;
  approxTokensAtCreation: number;
}

export interface LedgerBookmarkEvictResult {
  bookmark: LedgerBookmark;
  removedEntries: LedgerEntry[];
  removedTokens: number;
}

export interface LedgerTrimResult {
  removedEntries: LedgerEntry[];
  removedTokens: number;
  totalAfter: number;
}

export interface LedgerEvictResult {
  removedEntries: LedgerEntry[];
  removedTokens: number;
  totalAfter: number;
}

export interface LedgerCompactResult {
  removedEntries: LedgerEntry[];
  removedTokens: number;
  summaryTokens: number;
  totalAfter: number;
  /**
   * Where the summary landed among the surviving entries.
   *
   * Always 0 for an oldest-N compaction, which is why nothing needed it until
   * ref-selected consolidation arrived: that removes a set from the MIDDLE, so
   * the summary takes the first removed entry's place rather than the front.
   * The transcript event has to carry this or reattach rebuilds the ledger in a
   * different order than the live session holds — see the compaction event's
   * `summaryIndex` in compaction.ts.
   */
  summaryIndex: number;
}

export interface PromptBuildOptions {
  maxTokens?: number;
  includeSources?: boolean;
}

export const DEFAULT_CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) return 0;
  return Math.ceil(normalized.length / DEFAULT_CHARS_PER_TOKEN);
}

export class ContextLedger {
  private entries: LedgerEntry[] = [];
  private bookmarks: LedgerBookmark[] = [];
  private entrySeq = 1;
  private bookmarkSeq = 1;

  public addEntry(
    role: LedgerRole,
    content: string,
    source?: string,
    eid?: number,
    replay?: LedgerReplayMeta
  ): LedgerEntry {
    const entry: LedgerEntry = {
      id: this.entrySeq++,
      role,
      content,
      source,
      createdAt: new Date().toISOString(),
      approxTokens: estimateTokens(content),
      ...(eid !== undefined ? { eid } : {}),
      ...(replay !== undefined ? { replay } : {}),
    };
    this.entries.push(entry);
    return entry;
  }

  /**
   * Find entry IDs matching persistent eviction refs. Matches by eid when
   * the ref carries one (precise), otherwise by content hash — bounded to as
   * many entries as there were refs.
   */
  public findEntriesByRefs(refs: Array<{ eid?: number; hash?: string }>): number[] {
    // Three kinds of ref, three rules. A ref that carries a hash ENFORCES it:
    // an eid can name two different entries (a compaction's kept tail and a
    // later event both hydrate with it), so matching by eid alone whenever
    // one was present turned a hash-selected eviction back into an eid
    // eviction on replay — the neighbour went with the target (Lumen, PR
    // #582). Eid-only refs keep their legacy behaviour.
    //
    // Hash-only refs are COUNTED, not set-matched. Content is not a unique
    // key: send the same message twice and both entries share a hash, so a
    // set removed every copy on replay no matter how many the eviction
    // actually took. Evicting one of two identical messages dropped the
    // survivor too — it existed live, and came back missing (Lumen, PR #653).
    // One ref is written per removed entry, so the ref count IS the number
    // evicted; spending a budget per hash replays that multiplicity.
    //
    // Which copy gets spent is ledger order, oldest first, because that is
    // what an eviction back to a bookmark removed. A ref that must name an
    // exact occurrence carries an eid — that is what eids are for, and live
    // entries from transcript-backed events now carry theirs.
    //
    // The two kinds resolve in two passes, named first, because one batch
    // holds both: recordEviction writes eid+hash for a removed entry that has
    // an eid and hash-only for one that does not, and a ledger carries both
    // identities at once wherever a compaction's kept tail preserves eids
    // beside entries loaded without any. Spending budgets in ledger order
    // alongside the named matches let the named entry consume the anonymous
    // ref intended for its twin, and the twin — a genuinely removed entry —
    // came back on reattach (Lumen, PR #653 round 2). Reserving first is not
    // an ordering preference: a named ref has exactly one entry it can mean,
    // an anonymous one has a choice, so the constrained match goes first.
    const eidOnly = new Set(
      refs.filter((r) => typeof r.eid === 'number' && typeof r.hash !== 'string').map((r) => r.eid!)
    );
    const hashOnlyBudget = new Map<string, number>();
    for (const ref of refs) {
      if (typeof ref.eid === 'number' || typeof ref.hash !== 'string') continue;
      hashOnlyBudget.set(ref.hash, (hashOnlyBudget.get(ref.hash) ?? 0) + 1);
    }
    const both = refs.filter((r) => typeof r.eid === 'number' && typeof r.hash === 'string');
    const matched = new Set<number>();
    for (const entry of this.entries) {
      if (entry.eid === undefined) continue;
      const hash = entryRefHash(entry.role, entry.content);
      if (eidOnly.has(entry.eid) || both.some((r) => r.eid === entry.eid && r.hash === hash)) {
        matched.add(entry.id);
      }
    }
    for (const entry of this.entries) {
      if (matched.has(entry.id)) continue;
      const hash = entryRefHash(entry.role, entry.content);
      const budget = hashOnlyBudget.get(hash) ?? 0;
      if (budget > 0) {
        hashOnlyBudget.set(hash, budget - 1);
        matched.add(entry.id);
      }
    }
    return this.entries.filter((entry) => matched.has(entry.id)).map((entry) => entry.id);
  }

  public listEntries(): LedgerEntry[] {
    return [...this.entries];
  }

  public listBookmarks(): LedgerBookmark[] {
    return [...this.bookmarks];
  }

  public totalTokens(): number {
    return this.entries.reduce((sum, entry) => sum + entry.approxTokens, 0);
  }

  public createBookmark(label?: string): LedgerBookmark {
    const bookmark: LedgerBookmark = {
      id: `b${this.bookmarkSeq++}`,
      label: label?.trim() || `bookmark-${this.bookmarkSeq - 1}`,
      entryId: this.entries[this.entries.length - 1]?.id || 0,
      entryIndex: Math.max(this.entries.length - 1, 0),
      createdAt: new Date().toISOString(),
      approxTokensAtCreation: this.totalTokens(),
    };
    this.bookmarks.push(bookmark);
    return bookmark;
  }

  /**
   * Resolve a bookmark ref to the entries at or before it — the positional
   * SELECTOR in the evict family, alongside by-id, by-source and by-role.
   *
   * Selection only: everything removes through `evictEntries`. There was a
   * mutating twin here (`ejectToBookmark`, which sliced the prefix itself)
   * until 2026-09-17. Two removal implementations on one ledger is how the
   * two diverged in the first place — the slicing one never recorded a
   * `context_evict`, so its removals came back on reattach. One remover, and
   * that cannot happen again by construction.
   */
  public previewEvictToBookmark(ref: string): LedgerBookmarkEvictResult | null {
    const bookmark =
      ref === 'last'
        ? this.bookmarks[this.bookmarks.length - 1]
        : this.bookmarks.find((b) => b.id === ref || b.label === ref);

    if (!bookmark) return null;

    const cutoff = Math.min(bookmark.entryIndex, this.entries.length - 1);
    if (cutoff < 0) {
      return { bookmark, removedEntries: [], removedTokens: 0 };
    }

    const removedEntries = this.entries.slice(0, cutoff + 1);
    const removedTokens = removedEntries.reduce((sum, entry) => sum + entry.approxTokens, 0);
    return { bookmark, removedEntries, removedTokens };
  }

  public buildPromptTranscript(options: PromptBuildOptions = {}): string {
    const includeSources = options.includeSources ?? true;
    const maxTokens = options.maxTokens;

    const chosen: LedgerEntry[] = [];
    let running = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (maxTokens && chosen.length > 0 && running + entry.approxTokens > maxTokens) {
        break;
      }
      chosen.push(entry);
      running += entry.approxTokens;
    }
    chosen.reverse();

    return chosen
      .map((entry) => {
        const source = includeSources && entry.source ? ` [${entry.source}]` : '';
        return `${entry.role.toUpperCase()}${source}: ${entry.content}`;
      })
      .join('\n\n');
  }

  public trimOldestToTokenBudget(maxTokens: number, keepRecentEntries = 0): LedgerTrimResult {
    if (this.entries.length === 0) {
      return { removedEntries: [], removedTokens: 0, totalAfter: 0 };
    }

    const normalizedMax = Math.max(0, Math.floor(maxTokens));
    let runningTotal = this.totalTokens();
    if (runningTotal <= normalizedMax) {
      return { removedEntries: [], removedTokens: 0, totalAfter: runningTotal };
    }

    const protectedStart = Math.max(0, this.entries.length - Math.max(0, keepRecentEntries));
    let removeCount = 0;
    let removedTokens = 0;

    while (removeCount < protectedStart && runningTotal - removedTokens > normalizedMax) {
      removedTokens += this.entries[removeCount]?.approxTokens || 0;
      removeCount += 1;
    }

    if (removeCount === 0) {
      return { removedEntries: [], removedTokens: 0, totalAfter: runningTotal };
    }

    const removedEntries = this.entries.slice(0, removeCount);
    this.entries = this.entries.slice(removeCount);

    this.bookmarks = this.bookmarks
      .filter((bookmark) => bookmark.entryIndex >= removeCount)
      .map((bookmark) => ({ ...bookmark, entryIndex: bookmark.entryIndex - removeCount }));

    runningTotal = this.totalTokens();
    return { removedEntries, removedTokens, totalAfter: runningTotal };
  }

  /**
   * Replace the oldest entries with a single summary entry, keeping the most
   * recent `keepRecentEntries` verbatim. This is the in-memory half of
   * transcript compaction: the summary becomes the new start state and the
   * recent tail preserves working context.
   */
  public compactToSummary(
    summary: string,
    keepRecentEntries: number,
    source = 'compaction'
  ): LedgerCompactResult {
    const keep = Math.max(0, Math.floor(keepRecentEntries));
    const cutoff = Math.max(0, this.entries.length - keep);
    const removedEntries = this.entries.slice(0, cutoff);
    const removedTokens = removedEntries.reduce((sum, entry) => sum + entry.approxTokens, 0);
    const kept = this.entries.slice(cutoff);

    const summaryEntry: LedgerEntry = {
      id: this.entrySeq++,
      role: 'system',
      content: summary,
      source,
      createdAt: new Date().toISOString(),
      approxTokens: estimateTokens(summary),
    };

    this.entries = [summaryEntry, ...kept];
    // Bookmarks inside the compacted region are gone; survivors shift to
    // account for removed entries plus the prepended summary.
    this.bookmarks = this.bookmarks
      .filter((bookmark) => bookmark.entryIndex >= cutoff)
      .map((bookmark) => ({ ...bookmark, entryIndex: bookmark.entryIndex - cutoff + 1 }));

    return {
      removedEntries,
      removedTokens,
      summaryTokens: summaryEntry.approxTokens,
      totalAfter: this.totalTokens(),
      // This path always prepends — the removed set is by construction the
      // oldest run, so there are no survivors before it.
      summaryIndex: 0,
    };
  }

  /**
   * Replace EXACTLY these entries with one summary entry, wherever they now
   * sit. The summary takes the place of the first of them; everything else —
   * including entries appended after the caller chose the set — survives in
   * order.
   *
   * compactToSummary recomputes its cutoff from the live ledger, so a caller
   * that snapshots the oldest entries, awaits a summarizer, and then compacts
   * by COUNT removes whatever is oldest at that moment: an entry appended
   * during the await pushed a protected tail entry into the removed set even
   * though the summarizer never saw it (Lumen, PR #578). Compacting by id
   * makes the removed set the summarized set, whatever happened meanwhile.
   */
  public compactEntriesToSummary(
    entryIds: readonly number[],
    summary: string,
    source = 'compaction'
  ): LedgerCompactResult {
    const idSet = new Set(entryIds);
    const removedEntries = this.entries.filter((entry) => idSet.has(entry.id));
    const removedTokens = removedEntries.reduce((sum, entry) => sum + entry.approxTokens, 0);
    const survivors = this.entries.filter((entry) => !idSet.has(entry.id));
    const firstRemovedIndex = this.entries.findIndex((entry) => idSet.has(entry.id));
    const insertAt =
      firstRemovedIndex === -1
        ? 0
        : this.entries.slice(0, firstRemovedIndex).filter((entry) => !idSet.has(entry.id)).length;

    const summaryEntry: LedgerEntry = {
      id: this.entrySeq++,
      role: 'system',
      content: summary,
      source,
      createdAt: new Date().toISOString(),
      approxTokens: estimateTokens(summary),
    };

    const before = this.entries;
    const after = [...survivors.slice(0, insertAt), summaryEntry, ...survivors.slice(insertAt)];
    // Bookmarks on removed entries are gone; survivors follow their entry.
    this.bookmarks = this.bookmarks.flatMap((bookmark) => {
      const target = before[bookmark.entryIndex];
      if (!target || idSet.has(target.id)) return [];
      return [{ ...bookmark, entryIndex: after.indexOf(target) }];
    });
    this.entries = after;

    return {
      removedEntries,
      removedTokens,
      summaryTokens: summaryEntry.approxTokens,
      totalAfter: this.totalTokens(),
      summaryIndex: insertAt,
    };
  }

  /**
   * Evict specific entries by ID. Unlike evictToBookmark (positional) or trim
   * (oldest-first), this removes arbitrary entries — enabling the SB to
   * surgically drop irrelevant context while preserving everything else.
   */
  public evictEntries(entryIds: number[]): LedgerEvictResult {
    const idSet = new Set(entryIds);
    const removedEntries: LedgerEntry[] = [];
    let removedTokens = 0;

    const kept: LedgerEntry[] = [];
    for (const entry of this.entries) {
      if (idSet.has(entry.id)) {
        removedEntries.push(entry);
        removedTokens += entry.approxTokens;
      } else {
        kept.push(entry);
      }
    }

    if (removedEntries.length === 0) {
      return { removedEntries: [], removedTokens: 0, totalAfter: this.totalTokens() };
    }

    // Rebuild bookmark indices to match new array positions
    const oldToNew = new Map<number, number>();
    kept.forEach((entry, idx) => {
      const oldIdx = this.entries.indexOf(entry);
      oldToNew.set(oldIdx, idx);
    });

    this.entries = kept;
    this.bookmarks = this.bookmarks
      .filter((b) => oldToNew.has(b.entryIndex))
      .map((b) => ({ ...b, entryIndex: oldToNew.get(b.entryIndex)! }));

    return { removedEntries, removedTokens, totalAfter: this.totalTokens() };
  }

  /**
   * Evict all entries from a given source (e.g., "inkmail", "bootstrap", "local-tool").
   * Useful for bulk cleanup of a category of context.
   */
  public evictBySource(source: string): LedgerEvictResult {
    const ids = this.entries.filter((e) => e.source === source).map((e) => e.id);
    return this.evictEntries(ids);
  }

  /**
   * Evict all entries matching a role (e.g., "inbox", "system").
   */
  public evictByRole(role: LedgerRole): LedgerEvictResult {
    const ids = this.entries.filter((e) => e.role === role).map((e) => e.id);
    return this.evictEntries(ids);
  }

  /**
   * Get a compact summary of context entries for introspection.
   * Returns entry metadata without full content (for the SB to decide what to evict).
   */
  public summarizeEntries(): Array<{
    id: number;
    /** Durable, content-addressed handle — see entryRefHash. */
    ref: string;
    role: LedgerRole;
    source?: string;
    approxTokens: number;
    createdAt: string;
    preview: string;
  }> {
    return this.entries.map((e) => ({
      id: e.id,
      ref: entryRefHash(e.role, e.content),
      role: e.role,
      source: e.source,
      approxTokens: e.approxTokens,
      createdAt: e.createdAt,
      preview: e.content.slice(0, 120) + (e.content.length > 120 ? '...' : ''),
    }));
  }
}
