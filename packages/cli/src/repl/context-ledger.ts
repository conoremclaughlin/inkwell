export type LedgerRole = 'system' | 'user' | 'assistant' | 'inbox';

export interface LedgerEntry {
  id: number;
  role: LedgerRole;
  content: string;
  source?: string;
  createdAt: string;
  approxTokens: number;
}

export interface LedgerBookmark {
  id: string;
  label: string;
  entryId: number;
  entryIndex: number;
  createdAt: string;
  approxTokensAtCreation: number;
}

export interface LedgerEjectResult {
  bookmark: LedgerBookmark;
  removedEntries: LedgerEntry[];
  removedTokens: number;
}

export interface LedgerTrimResult {
  removedEntries: LedgerEntry[];
  removedTokens: number;
  totalAfter: number;
}

export interface PromptBuildOptions {
  maxTokens?: number;
  includeSources?: boolean;
}

const DEFAULT_CHARS_PER_TOKEN = 4;

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

  public addEntry(role: LedgerRole, content: string, source?: string): LedgerEntry {
    const entry: LedgerEntry = {
      id: this.entrySeq++,
      role,
      content,
      source,
      createdAt: new Date().toISOString(),
      approxTokens: estimateTokens(content),
    };
    this.entries.push(entry);
    return entry;
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

  public ejectToBookmark(ref: string): LedgerEjectResult | null {
    const preview = this.previewEjectToBookmark(ref);
    if (!preview) {
      return null;
    }

    const cutoff = Math.min(preview.bookmark.entryIndex, this.entries.length - 1);
    this.entries = cutoff < 0 ? this.entries : this.entries.slice(cutoff + 1);

    // Remove bookmarks at/inside the ejected region.
    this.bookmarks = this.bookmarks
      .filter((b) => b.entryIndex > cutoff)
      .map((b) => ({ ...b, entryIndex: b.entryIndex - (cutoff + 1) }));

    return preview;
  }

  public previewEjectToBookmark(ref: string): LedgerEjectResult | null {
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
}
