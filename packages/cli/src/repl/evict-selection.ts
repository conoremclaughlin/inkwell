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
 *   /evict ... --dry-run         preview the selection, no mutation
 */

import type { LedgerEntry, LedgerRole } from './context-ledger.js';

const LEDGER_ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant', 'inbox']);
const DRY_RUN_FLAGS: ReadonlySet<string> = new Set(['--dry-run', '--dry', '-n']);

export interface EvictSelection {
  /** True when no selector was given — caller should list evictable entries */
  list: boolean;
  dryRun: boolean;
  ids?: number[];
  source?: string;
  role?: LedgerRole;
  error?: string;
}

export function parseEvictSelection(args: string[]): EvictSelection {
  const selection: EvictSelection = { list: false, dryRun: false };
  const ids: number[] = [];

  for (const arg of args) {
    if (DRY_RUN_FLAGS.has(arg.toLowerCase())) {
      selection.dryRun = true;
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

  if (ids.length > 0 && (selection.source || selection.role)) {
    selection.error = 'Combine ids OR a source:/role: filter, not both';
    return selection;
  }
  if (selection.source && selection.role) {
    selection.error = 'Combine source: OR role:, not both';
    return selection;
  }

  if (ids.length > 0) {
    selection.ids = [...new Set(ids)];
  } else if (!selection.source && !selection.role) {
    selection.list = true;
  }
  return selection;
}

/**
 * Resolve a parsed selection against the current ledger entries.
 * Returns the entries that would be evicted, in ledger order.
 */
export function selectEvictionEntries(
  entries: LedgerEntry[],
  selection: EvictSelection
): LedgerEntry[] {
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
  return [];
}

/** One-line preview of a ledger entry for /evict listings */
export function formatEvictCandidate(entry: LedgerEntry, previewChars = 70): string {
  const src = entry.source ? `/${entry.source}` : '';
  const preview = entry.content.slice(0, previewChars).replace(/\s+/g, ' ');
  return `#${entry.id} [${entry.role}${src}] ~${entry.approxTokens} tok · ${preview}`;
}
