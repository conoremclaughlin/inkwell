/**
 * Client-Local Context Management Tools
 *
 * These tools run entirely in the CLI — they modify the local context ledger
 * without going through the PCP MCP server. This gives the SB agency over
 * its own context window: the ability to introspect what's there and
 * surgically evict what's no longer relevant.
 *
 * The SB calls these the same way as PCP tools (via ink-tool blocks),
 * but the CLI intercepts and handles them locally.
 */

import {
  entryRefHash,
  type ContextLedger,
  type LedgerEntry,
  type LedgerEvictResult,
} from './context-ledger.js';
import type { PcpToolCallResult } from '../lib/pcp-client.js';

// ─── Session Status Signal ──────────────────────────────────────

export type SessionStatus = 'completed' | 'blocked' | 'continuing';

export interface SessionSignal {
  status: SessionStatus;
  reason?: string;
  /** Timestamp of last signal */
  signalledAt: string;
}

/**
 * Where a `signal_status` call is recorded.
 *
 * A sink exists because the process-global below is read by `runChat` to decide
 * whether the whole non-interactive run completed or blocked. A shadow clone is
 * *instructed* to signal when it finishes, so a clone writing the global would
 * end its parent's run — and concurrent clones would race each other for it.
 * Clones pass their own sink; the loop still stops on the returned result.
 */
export interface SignalSink {
  set(signal: SessionSignal): void;
}

/** Mutable shared state — the main loop reads this after each turn */
let _lastSignal: SessionSignal | null = null;

/** The parent's sink: the process-global the REPL reads after each turn. */
export const globalSignalSink: SignalSink = {
  set(signal) {
    _lastSignal = signal;
  },
};

/** A private sink, for a caller whose signal must not escape into the parent. */
export function createSignalSink(): SignalSink & { get(): SessionSignal | null } {
  let held: SessionSignal | null = null;
  return {
    set(signal) {
      held = signal;
    },
    get() {
      return held;
    },
  };
}

export function getLastSignal(): SessionSignal | null {
  return _lastSignal;
}

export function clearLastSignal(): void {
  _lastSignal = null;
}

/** Tool names that are handled client-locally, not forwarded to PCP */
export const CLIENT_LOCAL_TOOLS = new Set([
  'list_context',
  'evict_context',
  'compact_context',
  'signal_status',
]);

export function isClientLocalTool(toolName: string): boolean {
  return CLIENT_LOCAL_TOOLS.has(toolName);
}

/** A persistent reference to an evicted entry — what the runtime writes to the ledger. */
export interface EvictRef {
  eid?: number;
  hash: string;
  role: LedgerEntry['role'];
  source?: string;
  preview: string;
  tokens: number;
}

/**
 * What the RUNTIME needs to know about an eviction, delivered out of band.
 *
 * The refs used to ride inside the tool result the model reads. That result
 * is fed straight back into the model's context — and after an eviction of
 * 3,000 entries it was 425K characters of hashes and previews, injected into
 * the very window the call had just cleared (Myra, 2026-09-02; #571). The
 * model needs a count and a handful of previews; the ledger needs every ref.
 * Two audiences, two channels.
 */
export interface EvictionHooks {
  onEvict?(eviction: {
    args: Record<string, unknown>;
    tokensFreed: number;
    refs: EvictRef[];
  }): void;
  /**
   * What the provider last reported it was asked to read: the window as
   * BILLED, not as estimated. The ledger's totals are a characters-per-token
   * guess over what ink packed; a resumed native session also carries what
   * the provider itself accumulated. Myra's list_context said 297K of 300K
   * while the API said 541K (task 9cf538a2). Both numbers are shown; the
   * larger is the one the model actually occupies.
   */
  providerUsage?(): ProviderContextMeasurement | undefined;
}

export interface ProviderContextMeasurement {
  /** input + cache read + cache write of the last provider request — the context it was handed. */
  contextTokens: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
  /** When that request happened (ISO). */
  measuredAt?: string;
}

/**
 * The context size to reason with: the provider's own measurement when it is
 * larger than the estimate (it counts what the estimate cannot see — the
 * identity envelope, the native session's own accumulation), else the
 * estimate. Pure so the budget check and the tool agree.
 */
export function effectiveContextTokens(
  estimatedTokens: number,
  measured: ProviderContextMeasurement | undefined
): number {
  return Math.max(estimatedTokens, measured?.contextTokens ?? 0);
}

/**
 * Handle a client-local tool call. Returns the result in PCP tool format,
 * or null if the tool isn't recognized.
 */
export function handleClientLocalTool(
  tool: string,
  args: Record<string, unknown>,
  ledger: ContextLedger,
  signalSink: SignalSink = globalSignalSink,
  hooks: EvictionHooks = {}
): PcpToolCallResult | null {
  switch (tool) {
    case 'list_context':
      return handleListContext(args, ledger, hooks);
    case 'evict_context':
      return handleEvictContext(args, ledger, hooks);
    case 'compact_context':
      // Compaction needs the host: a summarizer turn, the transcript event,
      // and the provider-session roll. The REPL intercepts this name before
      // reaching here; anywhere else (a shadow clone's throwaway ledger) it
      // is honestly unavailable rather than silently a no-op.
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error:
                'compact_context is not available in this context (a shadow clone cannot compact; report what you found and let your parent act on it).',
            }),
          },
        ],
        isError: true,
      };
    case 'signal_status':
      return handleSignalStatus(args, signalSink);
    default:
      return null;
  }
}

// ─── compact_context ────────────────────────────────────────────

/** Ceiling on an agent-written compaction summary. */
export const COMPACT_CONTEXT_SUMMARY_MAX_CHARS = 20_000;
/** Ceiling on the protected recent tail an agent may ask to keep verbatim. */
export const COMPACT_CONTEXT_MAX_KEEP_RECENT = 200;

/**
 * A compaction must leave the window smaller than it found it. An agent may
 * replace one tiny entry with a 20K-character "summary" and be told it
 * compacted; the provider session would then roll for a rewrite that grew
 * the context (Lumen, PR #578). Refused, and the refusal says by how much.
 */
export function compactionShrinks(removedTokens: number, summaryTokens: number): boolean {
  return summaryTokens < removedTokens;
}

export interface CompactContextArgs {
  /** The agent's own brief. Absent means the runtime summarizes. */
  summary?: string;
  /** Entries kept verbatim after the summary. Absent means the runtime default. */
  keepRecent?: number;
}

/**
 * Validate a `compact_context` call. Pure, so the shape the runtime accepts
 * is testable without the host.
 *
 * The agent writing its own summary is the preferred path — it knows which
 * decisions, identifiers and open threads matter, and it costs no summarizer
 * turn. Omitting it asks the runtime to summarize the oldest entries the
 * same way auto-compaction does.
 */
export function parseCompactContextArgs(
  args: Record<string, unknown>
): CompactContextArgs | { error: string } {
  const out: CompactContextArgs = {};
  if (args.summary !== undefined) {
    if (typeof args.summary !== 'string') return { error: 'summary must be a string' };
    const summary = args.summary.trim();
    if (!summary) return { error: 'summary is empty — omit it to have the runtime summarize' };
    if (summary.length > COMPACT_CONTEXT_SUMMARY_MAX_CHARS) {
      return {
        error: `summary is ${summary.length} chars; the ceiling is ${COMPACT_CONTEXT_SUMMARY_MAX_CHARS} — a compaction summary should be a dense brief, not the transcript`,
      };
    }
    out.summary = summary;
  }
  if (args.keepRecent !== undefined) {
    const n = args.keepRecent;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      return { error: 'keepRecent must be a non-negative number' };
    }
    if (n > COMPACT_CONTEXT_MAX_KEEP_RECENT) {
      return { error: `keepRecent must be at most ${COMPACT_CONTEXT_MAX_KEEP_RECENT}` };
    }
    out.keepRecent = Math.floor(n);
  }
  return out;
}

// ─── list_context ───────────────────────────────────────────────

/** Entries per page unless the caller asks otherwise. */
export const LIST_CONTEXT_DEFAULT_LIMIT = 50;
/**
 * Bookmarks listed in detail. Unbounded, they recreate the payload explosion
 * through a second array — 3,500 bookmarks with 84-char labels returned
 * 460,458 characters while the entry page was only 50 (Lumen, PR #576) — and
 * the relay cap then cuts the JSON mid-document. The COUNT is always exact.
 */
export const LIST_CONTEXT_BOOKMARK_LIMIT = 20;
/** Labels are agent-supplied; one long label must not blow the page either. */
const BOOKMARK_LABEL_MAX_CHARS = 120;
/** Ceiling on a single page, whatever the caller asks. */
export const LIST_CONTEXT_MAX_LIMIT = 200;

type ListContextSort = 'oldest' | 'newest' | 'largest';

function intArg(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * The window, described — never the window, repeated.
 *
 * This result is fed back into the context it describes. Listing every entry
 * of a 3,500-entry session came to 797K characters (~400K tokens) and was
 * injected whole, which is how a call meant to find room in the window ended
 * up as its single largest occupant (Myra, 2026-09-02; #571). The totals and
 * per-source breakdown are always complete; the entry list is one page,
 * filterable by source/role/minimum size and sortable so the model can go
 * straight to what is worth evicting.
 */
function handleListContext(
  args: Record<string, unknown>,
  ledger: ContextLedger,
  hooks: EvictionHooks = {}
): PcpToolCallResult {
  const all = ledger.summarizeEntries();
  const totalTokens = ledger.totalTokens();
  const measured = hooks.providerUsage?.();
  const effectiveTokens = effectiveContextTokens(totalTokens, measured);
  const divergent = measured !== undefined && measured.contextTokens > totalTokens * 1.25;
  const bookmarks = ledger.listBookmarks();

  // Group by source for a quick breakdown — over EVERYTHING, not the page.
  const bySource: Record<string, { count: number; tokens: number }> = {};
  for (const entry of all) {
    const src = entry.source || '(none)';
    if (!bySource[src]) bySource[src] = { count: 0, tokens: 0 };
    bySource[src].count++;
    bySource[src].tokens += entry.approxTokens;
  }

  const source = typeof args.source === 'string' ? args.source : undefined;
  const role = typeof args.role === 'string' ? args.role : undefined;
  const minTokens = intArg(args.minTokens, 0, 0, Number.MAX_SAFE_INTEGER);
  const sort: ListContextSort =
    args.sort === 'newest' || args.sort === 'largest' ? args.sort : 'oldest';
  const limit = intArg(args.limit, LIST_CONTEXT_DEFAULT_LIMIT, 1, LIST_CONTEXT_MAX_LIMIT);
  const offset = intArg(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  const filtered = all.filter(
    (e) =>
      (source === undefined || (e.source || '(none)') === source) &&
      (role === undefined || e.role === role) &&
      e.approxTokens >= minTokens
  );
  if (sort === 'newest') filtered.reverse();
  else if (sort === 'largest') filtered.sort((a, b) => b.approxTokens - a.approxTokens);
  const page = filtered.slice(offset, offset + limit);
  const remaining = Math.max(0, filtered.length - offset - page.length);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: true,
          totalEntries: all.length,
          /** ink's estimate of what it packed (chars ÷ 4). */
          totalTokens,
          /** The number to reason with: the larger of the estimate and the provider's measurement. */
          effectiveTokens,
          ...(measured !== undefined ? { providerMeasured: measured } : {}),
          ...(divergent
            ? {
                accountingNote: `The provider last read ~${measured!.contextTokens.toLocaleString()} tokens of context; ink's estimate of the ledger is ~${totalTokens.toLocaleString()}. The larger number is the window you occupy: the estimate cannot see the identity envelope or what the native session accumulated. Budget against effectiveTokens.`,
              }
            : {}),
          bySource,
          bookmarkCount: bookmarks.length,
          ...(bookmarks.length > LIST_CONTEXT_BOOKMARK_LIMIT
            ? { bookmarksNotShown: bookmarks.length - LIST_CONTEXT_BOOKMARK_LIMIT }
            : {}),
          // The most recent ones: an older bookmark is the least likely to be
          // what a caller is about to act on, and the count above is exact.
          bookmarks: bookmarks.slice(-LIST_CONTEXT_BOOKMARK_LIMIT).map((b) => ({
            id: b.id,
            label:
              typeof b.label === 'string' && b.label.length > BOOKMARK_LABEL_MAX_CHARS
                ? b.label.slice(0, BOOKMARK_LABEL_MAX_CHARS) + '…'
                : b.label,
            entryIndex: b.entryIndex,
          })),
          page: {
            matched: filtered.length,
            offset,
            limit,
            returned: page.length,
            remaining,
            sort,
            ...(source !== undefined ? { source } : {}),
            ...(role !== undefined ? { role } : {}),
            ...(minTokens > 0 ? { minTokens } : {}),
          },
          ...(remaining > 0
            ? {
                note: `${remaining} more matching entries not shown — page with offset ${offset + page.length}, narrow with source/role/minTokens, or sort by "largest" to find what is worth evicting. Evicting by source or role does not require listing the entries.`,
              }
            : {}),
          // `ref` is the address: a content hash that survives reattach and
          // eviction. The process ordinal is deliberately NOT shown — it
          // renumbers on reattach, so a link or an evict captured against it
          // could resolve to DIFFERENT content later, which reads as correct
          // (Myra, 2026-09-03; #570). `entryIds` stays accepted for callers
          // that still hold one.
          entries: page.map((e) => ({
            ref: e.ref,
            role: e.role,
            source: e.source,
            tokens: e.approxTokens,
            age: e.createdAt,
            preview: e.preview,
          })),
        }),
      },
    ],
  };
}

// ─── evict_context ──────────────────────────────────────────────

/** Previews the model gets back — enough to confirm what went, not to re-read it. */
export const EVICT_CONTEXT_PREVIEW_LIMIT = 10;

function handleEvictContext(
  args: Record<string, unknown>,
  ledger: ContextLedger,
  hooks: EvictionHooks
): PcpToolCallResult {
  const refs = Array.isArray(args.refs)
    ? (args.refs as unknown[]).filter((r): r is string => typeof r === 'string')
    : undefined;
  const entryIds = args.entryIds as number[] | undefined;
  const source = args.source as string | undefined;
  const role = args.role as string | undefined;

  if (!refs && !entryIds && !source && !role) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error:
              'Provide at least one filter: refs (string[] — the ref values from list_context), entryIds (number[]), source (string), or role (string)',
          }),
        },
      ],
      isError: true,
    };
  }

  let result: LedgerEvictResult;

  if (refs) {
    // Hash-addressed: the durable handle list_context hands out. Resolved
    // against the live ledger at this moment, so a ref captured before an
    // earlier eviction still names the same content or nothing at all —
    // never a neighbour that inherited its position.
    result = ledger.evictEntries(ledger.findEntriesByRefs(refs.map((hash) => ({ hash }))));
  } else if (entryIds && Array.isArray(entryIds)) {
    result = ledger.evictEntries(entryIds);
  } else if (source) {
    result = ledger.evictBySource(source);
  } else if (role) {
    result = ledger.evictByRole(role as 'system' | 'user' | 'assistant' | 'inbox');
  } else {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: false, error: 'Invalid filter combination' }),
        },
      ],
      isError: true,
    };
  }

  // Persistent eviction refs go to the RUNTIME (it writes the context_evict
  // transcript event so the eviction survives reattach) — never into the
  // result the model reads. See EvictionHooks.
  if (result.removedEntries.length > 0) {
    hooks.onEvict?.({
      args,
      tokensFreed: result.removedTokens,
      refs: result.removedEntries.map((e) => ({
        ...(e.eid !== undefined ? { eid: e.eid } : {}),
        hash: entryRefHash(e.role, e.content),
        role: e.role,
        source: e.source,
        preview: e.content.slice(0, 80),
        tokens: e.approxTokens,
      })),
    });
  }

  const previews = result.removedEntries.slice(0, EVICT_CONTEXT_PREVIEW_LIMIT);
  const notShown = result.removedEntries.length - previews.length;
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: true,
          evicted: result.removedEntries.length,
          tokensFreed: result.removedTokens,
          totalAfter: result.totalAfter,
          removedPreviews: previews.map((e) => ({
            ref: entryRefHash(e.role, e.content),
            role: e.role,
            source: e.source,
            tokens: e.approxTokens,
            preview: e.content.slice(0, 80),
          })),
          ...(notShown > 0 ? { removedNotShown: notShown } : {}),
        }),
      },
    ],
  };
}

// ─── signal_status ──────────────────────────────────────────────

function handleSignalStatus(args: Record<string, unknown>, sink: SignalSink): PcpToolCallResult {
  const status = args.status as string | undefined;
  const reason = args.reason as string | undefined;

  const validStatuses: SessionStatus[] = ['completed', 'blocked', 'continuing'];
  if (!status || !validStatuses.includes(status as SessionStatus)) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
          }),
        },
      ],
      isError: true,
    };
  }

  const signal: SessionSignal = {
    status: status as SessionStatus,
    reason: reason || undefined,
    signalledAt: new Date().toISOString(),
  };
  sink.set(signal);

  // The RESULT is what stops the caller's own loop (isTerminalSignalToolResult
  // reads it), so a clone halts correctly without its status ever reaching the
  // parent's global.
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: true,
          signal,
        }),
      },
    ],
  };
}
