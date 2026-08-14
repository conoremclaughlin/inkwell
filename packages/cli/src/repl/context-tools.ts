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

import { entryRefHash, type ContextLedger, type LedgerEvictResult } from './context-ledger.js';
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

/**
 * Handle a client-local tool call. Returns the result in PCP tool format,
 * or null if the tool isn't recognized.
 */
export function handleClientLocalTool(
  tool: string,
  args: Record<string, unknown>,
  ledger: ContextLedger,
  signalSink: SignalSink = globalSignalSink
): PcpToolCallResult | null {
  switch (tool) {
    case 'list_context':
      return handleListContext(args, ledger);
    case 'evict_context':
      return handleEvictContext(args, ledger);
    case 'signal_status':
      return handleSignalStatus(args, signalSink);
    default:
      return null;
  }
}

// ─── list_context ───────────────────────────────────────────────

function handleListContext(
  _args: Record<string, unknown>,
  ledger: ContextLedger
): PcpToolCallResult {
  const entries = ledger.summarizeEntries();
  const totalTokens = ledger.totalTokens();
  const bookmarks = ledger.listBookmarks();

  // Group by source for a quick breakdown
  const bySource: Record<string, { count: number; tokens: number }> = {};
  for (const entry of entries) {
    const src = entry.source || '(none)';
    if (!bySource[src]) bySource[src] = { count: 0, tokens: 0 };
    bySource[src].count++;
    bySource[src].tokens += entry.approxTokens;
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: true,
          totalEntries: entries.length,
          totalTokens,
          bySource,
          bookmarks: bookmarks.map((b) => ({
            id: b.id,
            label: b.label,
            entryIndex: b.entryIndex,
          })),
          entries: entries.map((e) => ({
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

function handleEvictContext(
  args: Record<string, unknown>,
  ledger: ContextLedger
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

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: true,
          evicted: result.removedEntries.length,
          tokensFreed: result.removedTokens,
          totalAfter: result.totalAfter,
          removedPreviews: result.removedEntries.slice(0, 10).map((e) => ({
            id: e.id,
            role: e.role,
            source: e.source,
            tokens: e.approxTokens,
            preview: e.content.slice(0, 80),
          })),
          // Persistent eviction refs — the runtime writes these to a
          // context_evict transcript event so the eviction survives reattach
          evictRefs: result.removedEntries.map((e) => ({
            ...(e.eid !== undefined ? { eid: e.eid } : {}),
            hash: entryRefHash(e.role, e.content),
            role: e.role,
            source: e.source,
            preview: e.content.slice(0, 80),
            tokens: e.approxTokens,
          })),
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
