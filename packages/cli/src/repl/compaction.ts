/**
 * Context compaction, as a function of its dependencies.
 *
 * The REPL's `compactContextNow` used to hold everything — the summarizer
 * spawn, the transcript append, usage accounting, the ledger mutation — in one
 * closure that no test could reach, so the two failure paths most likely to
 * regress (a cancelled summarizer, a marker that could not be persisted) were
 * only ever "correct by inspection" (Lumen, PR #578 rounds 2–3). The policy
 * lives here; the host binds the spawn, the file, and the counters.
 */
import { type ContextLedger, estimateTokens } from './context-ledger.js';
import { compactionShrinks } from './context-tools.js';
import type { BackendTokenUsage } from './token-usage.js';

export interface CompactionRequest {
  reason: string;
  actor: 'system' | 'sb';
  /** The agent's own brief. Absent means `deps.summarize` runs. */
  summaryText?: string;
  /** Entries kept verbatim after the summary. Absent means `deps.keepRecentDefault`. */
  keepRecent?: number;
  /** The turn's cancellation — reaches the summarizer. */
  signal?: AbortSignal;
}

export interface SummarizerResult {
  text: string;
  /** Provider usage for the summarizer spawn, on EVERY outcome — spent tokens are spent. */
  usage?: BackendTokenUsage;
  /** Why no text came back, when none did. */
  error?: string;
}

export interface CompactionDeps {
  ledger: ContextLedger;
  keepRecentDefault: number;
  /** Summarize `chunk`; honour `signal` (abort the spawn) and report usage regardless. */
  summarize: (chunk: string, signal?: AbortSignal) => Promise<SummarizerResult>;
  /** Persist the compaction event — the durable marker. Throws on failure. */
  persist: (event: Record<string, unknown>) => void;
  recordUsage: (usage: BackendTokenUsage | undefined) => void;
  /** The system actor's fallback when its own summarizer fails; never used for an agent. */
  hardTrim?: (reason: string) => Promise<{ removed: number }>;
  log: (line: string) => void;
}

export type CompactionOutcome =
  | {
      ok: true;
      removed: number;
      removedTokens: number;
      summaryTokens: number;
      /** Live total just before the mutation — late appends included. */
      before: number;
      totalAfter: number;
      /** What the operation itself freed: removed minus summary. Never confused with `before − totalAfter`. */
      freedTokens: number;
    }
  | { ok: false; error: string; hardTrimmed?: number };

export function buildCompactionPrompt(chunk: string): string {
  return [
    'You are compacting a conversation transcript into a dense continuation brief.',
    'Summarize the conversation below, preserving: decisions and their rationale,',
    'completed and in-progress work, key facts and constraints, open questions,',
    'commitments made, and any identifiers (PR numbers, session IDs, file paths, URLs).',
    'Write compact bullet points. Output ONLY the summary — no preamble.',
    '',
    '<conversation>',
    chunk,
    '</conversation>',
  ].join('\n');
}

export async function runCompaction(
  req: CompactionRequest,
  deps: CompactionDeps
): Promise<CompactionOutcome> {
  const { ledger } = deps;
  const keepRecent = req.keepRecent ?? deps.keepRecentDefault;
  const entries = ledger.listEntries();
  const cutoff = Math.max(0, entries.length - keepRecent);
  if (cutoff === 0) {
    return {
      ok: false,
      error: `nothing to compact — only the protected recent tail remains (${entries.length} entries, keepRecent ${keepRecent})`,
    };
  }

  // The set to summarize is fixed HERE, by id. The ledger keeps moving while a
  // summarizer runs (inbox and activity polling append), and a compaction by
  // count after the await removed whatever was oldest by then — a protected
  // tail entry the summarizer never saw (Lumen, PR #578). The removed set is
  // exactly the summarized set; anything appended meanwhile survives.
  const oldest = entries.slice(0, cutoff);
  const oldestIds = oldest.map((e) => e.id);
  const oldestIdSet = new Set(oldestIds);
  const removedTokensPlanned = oldest.reduce((sum, e) => sum + e.approxTokens, 0);
  deps.log(
    `Context at ${ledger.totalTokens()} tok — compacting ${oldest.length} entries (${req.reason})`
  );

  let summaryText = req.summaryText?.trim() ?? '';
  if (!summaryText) {
    let failure: string | undefined;
    if (req.signal?.aborted) {
      failure = 'cancelled';
    } else {
      const chunk = oldest
        .map((e) => `${e.role.toUpperCase()}${e.source ? ` [${e.source}]` : ''}: ${e.content}`)
        .join('\n\n');
      // The dependency can REJECT, not just answer with an error: spawn
      // preparation, stream finalization, cleanup. Outside a catch that
      // escaped to the tool executor for an agent and out of the pre-turn
      // budget check for the system — no "pass your own summary", no hard
      // trim (Lumen, PR #578 round 4). A rejection is a failure like any
      // other here, on the same actor split.
      let result: SummarizerResult | undefined;
      try {
        result = await deps.summarize(chunk, req.signal);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      if (result !== undefined) {
        // Recorded on EVERY outcome — an aborted or failed summarizer still
        // spent its tokens (Lumen, PR #578).
        deps.recordUsage(result.usage);
        if (req.signal?.aborted) failure = 'cancelled';
        else if (!result.text.trim()) failure = result.error || 'empty summary';
        else summaryText = result.text.trim();
      } else if (req.signal?.aborted) {
        failure = 'cancelled';
      }
    }
    if (failure !== undefined) {
      if (req.actor === 'sb' || req.signal?.aborted || !deps.hardTrim) {
        deps.log(`Compaction failed (${failure})`);
        return { ok: false, error: `summarization failed (${failure}) — pass your own summary` };
      }
      deps.log(`Compaction summarization failed (${failure}) — hard-trimming`);
      const trimmed = await deps.hardTrim(`${req.reason} (compaction fallback)`);
      return {
        ok: false,
        error: `summarization failed (${failure}); hard-trimmed ${trimmed.removed} entries instead`,
        hardTrimmed: trimmed.removed,
      };
    }
  }

  const summary = `[Conversation summary — compacted ${oldest.length} earlier entries${
    req.actor === 'sb' ? ', written by the agent' : ''
  }]\n${summaryText}`;
  const summaryTokens = estimateTokens(summary);
  // A compaction must shrink the window. A "summary" larger than what it
  // replaces is a rewrite that grows the context and rolls the provider
  // session for nothing (Lumen, PR #578).
  if (!compactionShrinks(removedTokensPlanned, summaryTokens)) {
    deps.log('Compaction refused — the summary is not smaller than what it replaces');
    return {
      ok: false,
      error: `refused: the summary (~${summaryTokens} tok) is not smaller than the ${oldest.length} entries it would replace (~${removedTokensPlanned} tok) — write a denser summary, or keep fewer recent entries so more is replaced`,
    };
  }

  // The durable marker goes FIRST. The compaction event is the COMPLETE new
  // start state — summary plus the verbatim tail — projected from the live
  // ledger without touching it; only once it is persisted does the in-memory
  // ledger change. The other order left a live ledger compacted, a provider
  // session rolled, and no event to survive reattach when the append failed
  // (Lumen, PR #578).
  const live = ledger.listEntries();
  const removedNow = live.filter((e) => oldestIdSet.has(e.id));
  const keptNow = live.filter((e) => !oldestIdSet.has(e.id));
  const removedTokensNow = removedNow.reduce((sum, e) => sum + e.approxTokens, 0);
  const keptTokens = keptNow.reduce((sum, e) => sum + e.approxTokens, 0);
  // Live, pre-mutation: late appends are in here, as they are in totalAfter.
  const before = keptTokens + removedTokensNow;
  const totalAfter = keptTokens + summaryTokens;
  try {
    deps.persist({
      type: 'compaction',
      reason: req.reason,
      actor: req.actor,
      summary,
      keptEntries: keptNow.map((e) => ({
        role: e.role,
        content: e.content,
        source: e.source,
        ...(e.eid !== undefined ? { eid: e.eid } : {}),
        ...(e.replay !== undefined ? { replay: e.replay } : {}),
      })),
      removedCount: removedNow.length,
      removedTokens: removedTokensNow,
      summaryTokens,
      totalAfter,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    deps.log(`Compaction marker could not be persisted (${msg}) — context unchanged`);
    return {
      ok: false,
      error: `could not persist the compaction marker (${msg}); the context was left unchanged`,
    };
  }
  const result = ledger.compactEntriesToSummary(oldestIds, summary);
  return {
    ok: true,
    removed: result.removedEntries.length,
    removedTokens: result.removedTokens,
    summaryTokens: result.summaryTokens,
    before,
    totalAfter: result.totalAfter,
    // The operation's own delta — not `before − totalAfter`, which a late
    // append during the summarizer turns negative while the context shrank
    // (Lumen, PR #578 round 2).
    freedTokens: result.removedTokens - result.summaryTokens,
  };
}
