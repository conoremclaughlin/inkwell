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
export const CLIENT_LOCAL_TOOLS = new Set(['list_context', 'evict_context', 'signal_status']);

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
      return handleListContext(args, ledger);
    case 'evict_context':
      return handleEvictContext(args, ledger, hooks);
    case 'signal_status':
      return handleSignalStatus(args, signalSink);
    default:
      return null;
  }
}

// ─── list_context ───────────────────────────────────────────────

/** Entries per page unless the caller asks otherwise. */
export const LIST_CONTEXT_DEFAULT_LIMIT = 50;
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
  ledger: ContextLedger
): PcpToolCallResult {
  const all = ledger.summarizeEntries();
  const totalTokens = ledger.totalTokens();
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
          totalTokens,
          bySource,
          bookmarks: bookmarks.map((b) => ({
            id: b.id,
            label: b.label,
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
          entries: page.map((e) => ({
            id: e.id,
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
  const entryIds = args.entryIds as number[] | undefined;
  const source = args.source as string | undefined;
  const role = args.role as string | undefined;

  if (!entryIds && !source && !role) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error:
              'Provide at least one filter: entryIds (number[]), source (string), or role (string)',
          }),
        },
      ],
      isError: true,
    };
  }

  let result: LedgerEvictResult;

  if (entryIds && Array.isArray(entryIds)) {
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
            id: e.id,
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
