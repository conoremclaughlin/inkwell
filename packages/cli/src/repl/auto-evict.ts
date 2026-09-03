/**
 * Automatic clearing of consumed tool results.
 *
 * A tool result is read once — in the continuation that follows the call —
 * and then sits in the window as a 500-character bookkeeping line for the
 * rest of the session. Over a long-lived session those lines are most of the
 * window (Myra, 2026-09-02: per-source costs of 24–255 tokens per entry over
 * thousands of entries; #571). The Claude API's context editing clears old
 * tool results server-side for the same reason; ink owns its own window, so
 * it does the same on the ledger — and the transcript keeps every payload.
 *
 * Policy only. The host applies the selection with the same persistent
 * eviction every other actor uses (a context_evict event), so replay
 * reproduces it, and it leaves one tombstone naming what went.
 */
import type { LedgerEntry } from './context-ledger.js';

/** Ledger source under which the REPL records local tool outcomes. */
export const LOCAL_TOOL_RESULT_SOURCE = 'local-tool';
/** Source of the tombstone an automatic sweep leaves behind. */
export const AUTO_EVICT_TOMBSTONE_SOURCE = 'auto-evict';
/** Results from the last N completed turns are never touched. */
export const AUTO_EVICT_KEEP_RECENT_TURNS = 2;
/** A sweep must free at least this many tokens to be worth rolling the provider session. */
export const AUTO_EVICT_MIN_TOKENS = 8_000;
/** …or this share of the effective budget, whichever is larger. */
export const AUTO_EVICT_MIN_SHARE = 0.05;

export interface AutoEvictSelection {
  ids: number[];
  tokens: number;
  /** Distinct tool names, in first-seen order, for the tombstone. */
  tools: string[];
}

/** `local tool <name> -> …` — an executed result, as the REPL records it. */
const TOOL_NAME_RE = /^local tool ([A-Za-z_][\w.-]*) ->/;
/** `Local tool error|blocked|denied (<name>): …` — a refused or failed one. */
const OUTCOME_RE = /^Local tool (?:error|blocked|denied) \(([A-Za-z_][\w.-]*)\)/;

/**
 * Pick the consumed tool results to clear: `local-tool` entries that sit
 * BEFORE the last `keepRecentTurns` assistant entries (each completed turn
 * ends with one), when together they exceed `minTokens`. Anything in the
 * current or recent turns is untouched — a continuation still has to carry
 * them whole — and a sweep below the threshold is skipped, because every
 * eviction rolls the provider session and a small one is not worth that.
 */
export function selectConsumedToolResults(
  entries: ReadonlyArray<LedgerEntry>,
  opts: { keepRecentTurns?: number; minTokens?: number } = {}
): AutoEvictSelection | null {
  const keepRecentTurns = opts.keepRecentTurns ?? AUTO_EVICT_KEEP_RECENT_TURNS;
  const minTokens = opts.minTokens ?? AUTO_EVICT_MIN_TOKENS;

  // The boundary: the assistant entry that ENDS the turn before the protected
  // ones — the (keepRecentTurns + 1)-th most recent. A turn's results precede
  // its own assistant entry, so everything at or after this index belongs to
  // the protected recent turns (and the one in progress).
  let seen = 0;
  let boundary = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]!.role === 'assistant') {
      seen += 1;
      if (seen === keepRecentTurns + 1) {
        boundary = i;
        break;
      }
    }
  }
  if (boundary === -1) return null; // fewer completed turns than we protect

  const ids: number[] = [];
  const tools: string[] = [];
  let tokens = 0;
  for (let i = 0; i < boundary; i += 1) {
    const e = entries[i]!;
    if (e.source !== LOCAL_TOOL_RESULT_SOURCE) continue;
    ids.push(e.id);
    tokens += e.approxTokens;
    const name = OUTCOME_RE.exec(e.content)?.[1] ?? TOOL_NAME_RE.exec(e.content)?.[1];
    if (name && !tools.includes(name)) tools.push(name);
  }
  if (ids.length === 0 || tokens < minTokens) return null;
  return { ids, tokens, tools };
}

/** The one line left where the results were. */
export function autoEvictTombstone(selection: AutoEvictSelection, keepRecentTurns: number): string {
  const named = selection.tools.length > 0 ? ` (${selection.tools.join(', ')})` : '';
  return (
    `[${selection.ids.length} earlier tool results${named}, ~${selection.tokens.toLocaleString()} tokens, ` +
    `were cleared from context automatically after they had been consumed — results older than ${keepRecentTurns} turns are cleared once they outgrow the threshold. ` +
    'The transcript holds every one; re-run a tool if you need its data again.]'
  );
}
