/** The existing CLI eviction/trim/compaction composition, shared without host I/O.
 * Append has the existing synchronous ordering contract. Hosts with queued
 * sinks must flush before subsequent provider/tool dispatch and fail closed
 * on a write error; this module does not add a durability guarantee.
 */
import {
  runCompaction,
  buildCompactionPrompt,
  parseCompactContextArgs,
  assessContextPressure,
  estimateTokens,
  entryRefHash,
  EVICTED_DISPLAY_MAX,
  type ContextLedger,
  type LedgerRole,
  type EvictedEntryRecord,
  type CompactionOutcome,
  type SessionContextState,
  type BackendTokenUsage,
} from '../runtime/index.js';
import type { BackendRunRequest, BackendRunResult, BackendTurnHandle } from './backend-runner.js';
import type { SessionProviderRuntime } from './session-provider.js';

export const AUTO_TRIM_KEEP_RECENT_ENTRIES = 6;
export const DEFAULT_TRIM_TARGET_PCT = 70;
export const AUTO_COMPACT_THRESHOLD_PCT = 0.8;
export const AUTO_COMPACT_KEEP_RECENT_ENTRIES = 12;

export type SessionCompactionToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};
export interface SessionCompactionPorts {
  runtime: SessionProviderRuntime & { detectedModel?: string };
  ledger: ContextLedger;
  sessionContext: SessionContextState;
  sessionEvictedEntries: EvictedEntryRecord[];
  sbSlug: string;
  cliAttached: boolean;
  contextBudgetAuto(): boolean;
  append(event: Record<string, unknown>): number;
  spawnContext(): Pick<
    BackendRunRequest,
    'workingDirectory' | 'inkSessionId' | 'studioId' | 'host' | 'withholdProviderTools'
  >;
  startTurn(request: BackendRunRequest): BackendTurnHandle;
  recordUsage(usage: BackendTokenUsage | undefined): void;
  formatTokens(value: number): string;
  trimmed(note: string): void;
  progress(note: string): void;
  deferred(): void;
  compacted(outcome: Extract<CompactionOutcome, { ok: true }>, selected: boolean): void;
}

export function createSessionCompaction(ports: SessionCompactionPorts) {
  const { runtime, ledger, sessionContext, sessionEvictedEntries, sbSlug, cliAttached } = ports;
  // ── Persistent eviction (single writer) ──
  // Every eviction — SB tool, user /evict, system trim — flows through here
  // so the transcript event shape and the live evicted-display list can't
  // drift between actors. The context_evict event is what makes the
  // eviction survive reattach; sessionEvictedEntries is what Ctrl+O and
  // /evicted show right now.
  const recordEviction = (
    actor: 'sb' | 'user' | 'system',
    reason: string,
    removedTokens: number,
    refs: Array<{
      eid?: number;
      hash: string;
      role: LedgerRole;
      source?: string;
      preview: string;
    }>
  ): void => {
    if (refs.length === 0) return;
    ports.append({
      type: 'context_evict',
      actor,
      reason,
      removedTokens,
      refs: refs.map((ref) => ({
        ...(typeof ref.eid === 'number' ? { eid: ref.eid } : {}),
        hash: ref.hash,
      })),
    });
    for (const ref of refs) {
      sessionEvictedEntries.push({
        role: ref.role,
        content: ref.preview,
        source: ref.source,
        eid: ref.eid,
        actor,
        reason,
      });
    }
    if (sessionEvictedEntries.length > EVICTED_DISPLAY_MAX) {
      sessionEvictedEntries.splice(0, sessionEvictedEntries.length - EVICTED_DISPLAY_MAX);
    }
    // A context-boundary mutation (SB evict_context, user /evict, system trim —
    // all route through this single writer) just removed entries from ink's
    // window. Roll the provider session so the next turn re-seeds from the
    // post-eviction ledger; otherwise a resumed native session would still hold
    // the evicted content. findLastBackendSession clears cross-process
    // recovery on the matching markers.
    // A stateless provider re-packs the ledger on every spawn, so a reading
    // taken before the eviction describes a window that no longer exists —
    // and its scope (no session id) would otherwise still match (Lumen, PR
    // #583 round 2). Trims route through here too.
    sessionContext.clearProvider();
  };

  const trimContextToPercent = async (
    targetPercent: number,
    reason: string
  ): Promise<{ removed: number; removedTokens: number }> => {
    const targetTokens = Math.max(
      1,
      Math.floor((runtime.maxContextTokens * Math.max(1, Math.min(99, targetPercent))) / 100)
    );
    const trim = ledger.trimOldestToTokenBudget(targetTokens, AUTO_TRIM_KEEP_RECENT_ENTRIES);
    if (trim.removedEntries.length === 0) {
      return { removed: 0, removedTokens: 0 };
    }

    const note = `Trimmed ${trim.removedEntries.length} entries (~${trim.removedTokens} tok) to ${targetPercent}% budget (${reason}).`;
    ports.trimmed(note);
    ports.append({
      type: 'context_trim',
      reason,
      targetPercent,
      removedCount: trim.removedEntries.length,
      removedTokens: trim.removedTokens,
      totalAfter: trim.totalAfter,
    });
    // Persist the trim as an eviction so it survives reattach (context_trim
    // alone is informational — hydration doesn't replay it)
    recordEviction(
      'system',
      `trim: ${reason}`,
      trim.removedTokens,
      trim.removedEntries.map((e) => ({
        ...(e.eid !== undefined ? { eid: e.eid } : {}),
        hash: entryRefHash(e.role, e.content),
        role: e.role,
        source: e.source,
        preview: e.content.slice(0, 100),
      }))
    );

    return { removed: trim.removedEntries.length, removedTokens: trim.removedTokens };
  };

  // ── Token-budget auto-compaction ──
  // When the transcript approaches the context budget, summarize the oldest
  // entries into a dense brief via the backend and replace them with it. The
  // `compaction` transcript event is the pointer to the new start state —
  // hydration collapses everything before it on reattach. If summarization
  // fails, fall back to a hard trim so the turn can still proceed.
  let compactionInFlight = false;

  /**
   * Compact the ledger NOW: replace everything but the most recent entries
   * with a summary, write the `compaction` event, roll the provider session.
   *
   * Two callers. Auto-compaction (below) reaches it over the budget threshold
   * with the runtime summarizing. An agent reaches it through the
   * `compact_context` tool, usually with its OWN summary — the one thing a
   * long-lived SB could not do for itself (task 609b1833). The policy is
   * `runCompaction` (runtime/compaction.ts); this binds the summarizer spawn, the
   * transcript, the usage counters and the session roll to it.
   */
  const compactContextNow = async (opts: {
    reason: string;
    actor: 'system' | 'sb';
    summaryText?: string;
    keepRecent?: number;
    /** A named set to replace, instead of the oldest run. See CompactionRequest. */
    entryIds?: readonly number[];
    /** The turn's cancellation — aborts a running summarizer spawn. */
    signal?: AbortSignal;
  }): Promise<CompactionOutcome> => {
    if (compactionInFlight) return { ok: false, error: 'a compaction is already in progress' };
    compactionInFlight = true;
    try {
      const outcome = await runCompaction(opts, {
        ledger,
        keepRecentDefault: AUTO_COMPACT_KEEP_RECENT_ENTRIES,
        summarize: async (chunk, signal) => {
          // A handle, not a bare promise: the turn's Ctrl+C reaches this
          // spawn (it used to run on to its idle timeout).
          const summarizer = ports.startTurn({
            backend: runtime.backend,
            sbSlug,
            model: runtime.model,
            effort: runtime.effort,
            prompt: buildCompactionPrompt(chunk),
            // Compaction is a backend turn like any other, so it goes through
            // adapter.prepare() and would otherwise regenerate the default
            // identity prompt — handing a nascent SB "You are nascent, call
            // bootstrap" the moment its first conversation grew long enough to
            // compact (Lumen, PR #485 — finding 2).
            systemPromptOverride: runtime.systemPromptOverride,
            // Summarization is governed like any other turn: token-flow (idle)
            // is the reaper. An explicit
            // --backend-timeout-seconds still caps it, floored at 5 min —
            // summarizing a large chunk outlives short overrides.
            timeoutMs: runtime.backendTurnTimeoutMs
              ? Math.max(runtime.backendTurnTimeoutMs, 5 * 60 * 1000)
              : undefined,
            idleTimeoutMs: runtime.backendIdleTimeoutMs,
            stream: true,
            cliAttached,
            ...ports.spawnContext(),
          });
          const onAbort = (): void => summarizer.abort();
          signal?.addEventListener('abort', onAbort, { once: true });
          if (signal?.aborted) onAbort();
          let turn: BackendRunResult;
          try {
            turn = await summarizer.result;
          } finally {
            signal?.removeEventListener('abort', onAbort);
          }
          return {
            text: turn.success ? (turn.responseText ?? turn.stdout) : '',
            usage: turn.usage,
            error: turn.success
              ? undefined
              : turn.stderr.trim().slice(0, 200) || `exit code ${turn.exitCode}`,
          };
        },
        persist: (event) => ports.append(event),
        recordUsage: ports.recordUsage,
        hardTrim: (reason) => trimContextToPercent(DEFAULT_TRIM_TARGET_PCT, reason),
        log: (line) => ports.progress(line),
      });
      if (outcome.ok) {
        ports.compacted(outcome, opts.entryIds !== undefined);
        // ink just rolled the ledger — roll the provider session too so the
        // next spawn seeds a fresh native session with the summary (we compact
        // before the provider ever would). Mid-turn, the next continuation
        // re-seeds (decideContinuationSession). Only when the ledger actually
        // changed: a refusal or a failed marker leaves the session alone.
        sessionContext.clearProvider();
      }
      return outcome;
    } finally {
      compactionInFlight = false;
    }
  };

  // ── Token-budget auto-compaction ──
  const maybeCompactContext = async (reason: string): Promise<void> => {
    if (compactionInFlight) return;
    const bootstrapReserve = runtime.bootstrapContext
      ? estimateTokens(runtime.bootstrapContext)
      : 0;
    const effectiveBudget = Math.max(1, runtime.maxContextTokens - bootstrapReserve);
    const threshold = Math.floor(effectiveBudget * AUTO_COMPACT_THRESHOLD_PCT);
    // Two yardsticks (Lumen, PR #583 finding 3): ink's estimate covers the
    // ledger and is judged against its allowance; the provider's count covers
    // the whole request and is judged against the full window. A 300K
    // estimate over a 541K window never compacted (Myra, 2026-09-03; task
    // 9cf538a2).
    const pressure = assessContextPressure({
      ledgerTokens: ledger.totalTokens(),
      ledgerThreshold: threshold,
      providerTokens: sessionContext.measurement()?.contextTokens,
      providerThreshold: Math.floor(runtime.maxContextTokens * AUTO_COMPACT_THRESHOLD_PCT),
      hasProviderSession: sessionContext.provider.id !== undefined,
      format: ports.formatTokens,
    });
    if (pressure.action === 'none') return;
    if (pressure.action === 'reseed') {
      // The ledger is within its allowance; the excess is what the native
      // session accumulated and the ledger no longer holds. Compacting would
      // destroy history that is not the problem — roll the session instead.
      sessionContext.roll('provider-context-over-budget', pressure.reason);
      return;
    }

    // Claude reports its model on the first turn's init event, which may
    // RAISE the budget (1M-window models). Until that arrives — legacy
    // transcripts predate model_detected persistence — compacting would
    // irreversibly destroy history that the real budget may comfortably
    // hold. Defer: this fires at most once (the first pre-turn check); the
    // init event lands during that turn and enforcement resumes with the
    // real window (Lumen, PR #477 review — finding 2).
    if (
      runtime.backend === 'claude' &&
      !runtime.model &&
      !runtime.detectedModel &&
      ports.contextBudgetAuto()
    ) {
      ports.deferred();
      return;
    }

    const outcome = await compactContextNow({
      reason: `${reason}; ${pressure.reason}`,
      actor: 'system',
    });
    // A compaction that could not shrink the ledger (a protected tail, a
    // summarizer failure) must still roll a native session the provider says
    // is over the window, or the next spawn resumes the same oversize session.
    if (!outcome.ok && pressure.providerOver && sessionContext.provider.id !== undefined) {
      sessionContext.roll(
        'provider-context-over-budget',
        `compaction did not shrink the ledger; ${pressure.reason}`
      );
    }
  };

  /**
   * `compact_context` — the agent compacting its own window.
   *
   * Runs inside a tool iteration: the ledger rolls here, the continuation the
   * loop sends next re-seeds the provider session from the compacted ledger
   * (with the real tool results and the agent's own output so far), and the
   * agent carries on from its summary. Its result is client-local, so it is
   * never persisted back into the ledger it just compacted.
   */
  const runSbCompaction = async (
    args: Record<string, unknown>,
    ctx?: { signal?: AbortSignal }
  ): Promise<SessionCompactionToolResult> => {
    const asResult = (
      payload: Record<string, unknown>,
      isError = false
    ): SessionCompactionToolResult => ({
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      ...(isError ? { isError: true } : {}),
    });
    const parsed = parseCompactContextArgs(args);
    if ('error' in parsed) return asResult({ success: false, error: parsed.error }, true);
    // Refs resolve against the LIVE ledger, here, at call time. A ref is a
    // content hash, so one captured before an earlier eviction names the same
    // content or nothing at all — never a neighbour that inherited its
    // position (#570, #582). Resolution happens before the summarizer runs;
    // runCompaction then fixes the set by id, so appends during the await
    // survive rather than shifting the selection.
    const entryIds =
      parsed.refs !== undefined
        ? ledger.findEntriesByRefs(parsed.refs.map((hash) => ({ hash })))
        : undefined;
    if (entryIds !== undefined && entryIds.length === 0) {
      return asResult(
        {
          success: false,
          error:
            'none of those refs match an entry in the context right now — they may already have been evicted or consolidated. Call list_context for current refs.',
        },
        true
      );
    }
    const outcome = await compactContextNow({
      reason: parsed.refs
        ? 'agent: consolidate selected entries'
        : parsed.summary
          ? 'agent: own summary'
          : 'agent: runtime summary',
      actor: 'sb',
      summaryText: parsed.summary,
      keepRecent: parsed.keepRecent,
      entryIds,
      signal: ctx?.signal,
    });
    if (!outcome.ok) return asResult({ success: false, error: outcome.error }, true);
    return asResult({
      success: true,
      compacted: outcome.removed,
      tokensFreed: outcome.freedTokens,
      summaryTokens: outcome.summaryTokens,
      totalAfter: outcome.totalAfter,
      ...(parsed.refs !== undefined
        ? {
            requestedRefs: parsed.refs.length,
            matchedEntries: entryIds?.length ?? 0,
            summaryIndex: outcome.summaryIndex,
            // The ledger figure, and only the ledger figure. A tool result
            // enters the ledger as a stub while the provider read the whole
            // payload, so tokensFreed understates what the reseed actually
            // drops — reporting it as window reclaimed would be a number
            // nobody measured (task 44f2783e, acceptance 2).
            note: 'Those entries are replaced by your summary, in their place — the rest of the context is untouched. tokensFreed counts LEDGER tokens; what the window actually reclaims is decided by the re-seed on the next spawn and is not measured here.',
          }
        : {
            keptRecent: parsed.keepRecent ?? AUTO_COMPACT_KEEP_RECENT_ENTRIES,
            note: 'Your context now starts from the summary; the provider session is re-seeded from it on the next spawn. Continue from here.',
          }),
    });
  };

  return {
    recordEviction,
    trimContextToPercent,
    compactContextNow,
    maybeCompactContext,
    runSbCompaction,
    isInFlight: () => compactionInFlight,
  };
}
