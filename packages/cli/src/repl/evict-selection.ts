/**
 * /evict selection parsing & matching
 *
 * Pure helpers behind the user-facing /evict command. The grammar mirrors
 * the SB's evict_context tool filters so both actors speak the same
 * language:
 *
 *   /evict                       list evictable entries (no mutation)
 *   /evict 3,5 7                 evict ledger entries by id
 *   /evict source:heartbeat      evict all entries from a source
 *   /evict role:inbox            evict all entries with a role
 *   /evict bookmark:heavy        evict everything up to a bookmark
 *   /evict ... --dry-run         preview the selection, no mutation
 *   /evict ... --force           skip the large-removal confirmation
 *
 * `bookmark:` is what `/eject` used to be. Removal had two verbs for one act
 * on one ledger — positional versus named selection — and only the selector
 * differed, so eject became a selector here (Conor, 2026-09-17). `compact`
 * stays its own verb: it removes AND inserts, and refuses when the summary
 * is not smaller.
 */

import type { LedgerEntry, LedgerRole } from './context-ledger.js';

const LEDGER_ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant', 'inbox']);
const DRY_RUN_FLAGS: ReadonlySet<string> = new Set(['--dry-run', '--dry', '-n']);
const FORCE_FLAGS: ReadonlySet<string> = new Set(['--force', '-f']);

export interface EvictSelection {
  /** True when no selector was given — caller should list evictable entries */
  list: boolean;
  dryRun: boolean;
  /** Skip the large-removal confirmation prompt */
  force: boolean;
  ids?: number[];
  source?: string;
  role?: LedgerRole;
  /** Bookmark id or label, or `last`. Selects everything up to and including it. */
  bookmark?: string;
  error?: string;
}

export function parseEvictSelection(args: string[]): EvictSelection {
  const selection: EvictSelection = { list: false, dryRun: false, force: false };
  const ids: number[] = [];

  for (const arg of args) {
    if (DRY_RUN_FLAGS.has(arg.toLowerCase())) {
      selection.dryRun = true;
      continue;
    }
    if (FORCE_FLAGS.has(arg.toLowerCase())) {
      selection.force = true;
      continue;
    }
    if (arg.toLowerCase().startsWith('bookmark:')) {
      // Case-preserving: bookmark labels are user-chosen free text, unlike
      // role: whose values are a fixed lowercase set.
      const bookmark = arg.slice('bookmark:'.length);
      if (!bookmark) {
        selection.error = 'bookmark: requires a value (e.g., bookmark:heavy, bookmark:last)';
        return selection;
      }
      if (selection.bookmark) {
        selection.error = 'Only one bookmark: filter allowed';
        return selection;
      }
      selection.bookmark = bookmark;
      continue;
    }
    if (arg.toLowerCase().startsWith('source:')) {
      const source = arg.slice('source:'.length);
      if (!source) {
        selection.error = 'source: requires a value (e.g., source:heartbeat)';
        return selection;
      }
      if (selection.source) {
        selection.error = 'Only one source: filter allowed';
        return selection;
      }
      selection.source = source;
      continue;
    }
    if (arg.toLowerCase().startsWith('role:')) {
      const role = arg.slice('role:'.length).toLowerCase();
      if (!LEDGER_ROLES.has(role)) {
        selection.error = `role: must be one of ${[...LEDGER_ROLES].join(', ')}`;
        return selection;
      }
      if (selection.role) {
        selection.error = 'Only one role: filter allowed';
        return selection;
      }
      selection.role = role as LedgerRole;
      continue;
    }
    // Bare ids, possibly comma-separated: "3,5" or "7". Each token must be a
    // full positive integer — parseInt would accept "1abc"/"1.5"/"1e3" as 1
    // and silently evict the wrong entry.
    const parts = arg.split(',').filter(Boolean);
    if (parts.length === 0 || parts.some((p) => !/^\d+$/.test(p))) {
      selection.error = `Unrecognized selector: ${arg} (expected entry ids, source:<name>, role:<role>, or --dry-run)`;
      return selection;
    }
    const parsed = parts.map((p) => Number.parseInt(p, 10));
    if (parsed.some((n) => n <= 0)) {
      selection.error = `Entry ids must be positive integers: ${arg}`;
      return selection;
    }
    ids.push(...parsed);
  }

  // Exactly one selector kind. Counted rather than checked pairwise: with
  // four kinds the pairwise form needs six conditions and silently gains a
  // hole every time a fifth selector is added.
  const kinds = [
    ids.length > 0 ? 'ids' : null,
    selection.source ? 'source:' : null,
    selection.role ? 'role:' : null,
    selection.bookmark ? 'bookmark:' : null,
  ].filter((kind): kind is string => kind !== null);

  if (kinds.length > 1) {
    selection.error = `Use one selector at a time, not ${kinds.join(' + ')}`;
    return selection;
  }

  if (ids.length > 0) {
    selection.ids = [...new Set(ids)];
  } else if (kinds.length === 0) {
    selection.list = true;
  }
  return selection;
}

/**
 * Resolve a bookmark ref to the entries it selects. The ledger owns the
 * cutoff rule (`previewEvictToBookmark`), so this module never reimplements
 * it — a second copy would drift the moment one of them changed. Returns
 * null for an unknown ref, which the caller reports differently from a
 * selector that matched nothing.
 */
export type BookmarkResolver = (ref: string) => LedgerEntry[] | null;

/**
 * Resolve a parsed selection against the current ledger entries.
 * Returns the entries that would be evicted, in ledger order. Returns null
 * only when a `bookmark:` ref names no bookmark.
 */
export function selectEvictionEntries(
  entries: LedgerEntry[],
  selection: EvictSelection,
  resolveBookmark?: BookmarkResolver
): LedgerEntry[] | null {
  if (selection.error || selection.list) return [];
  if (selection.ids) {
    const wanted = new Set(selection.ids);
    return entries.filter((e) => wanted.has(e.id));
  }
  if (selection.source) {
    return entries.filter((e) => e.source === selection.source);
  }
  if (selection.role) {
    return entries.filter((e) => e.role === selection.role);
  }
  if (selection.bookmark) {
    // No resolver wired is a programming error, not an unknown bookmark —
    // report it as unresolvable rather than silently evicting nothing.
    return resolveBookmark ? resolveBookmark(selection.bookmark) : null;
  }
  return [];
}

/** One-line preview of a ledger entry for /evict listings */
export function formatEvictCandidate(entry: LedgerEntry, previewChars = 70): string {
  const src = entry.source ? `/${entry.source}` : '';
  const preview = entry.content.slice(0, previewChars).replace(/\s+/g, ' ');
  return `#${entry.id} [${entry.role}${src}] ~${entry.approxTokens} tok · ${preview}`;
}
