/**
 * Existing runChat provider-session composition, shared by CLI and server hosts.
 * It owns prompt seed/resume/reseed decisions and continuation occupancy. It
 * never spawns directly: the host supplies every launch and cancellation handle.
 * Tools, live controls and session lifecycle are composed by the enclosing turn.
 */
import type { BackendRunRequest, BackendRunResult, BackendTurnHandle } from './backend-runner.js';
import type { TurnMedia } from './types.js';
import {
  buildDeltaPrompt,
  buildContinuationPrompt,
  buildMidTurnReseedBody,
  continuationSpawnArgs,
  decideContinuationSession,
  envelopeShapeKey,
  turnContextOccupancy,
  formatContextStamp,
  occupancyTokens,
  promptTokensOf,
  ledgerEntryPromptBytes,
  isResumeFailedNoSession,
  type SessionPromptState,
  type ContextLedger,
  type PreparedSessionTurn,
  type ProviderContextMeasurement,
  type ReseedDialogueEntry,
  type ContinuationSpawnArgs,
  type BackendTurnOutcome,
  type BackendTokenUsage,
} from '../runtime/index.js';

export interface SessionProviderState {
  id?: string;
  shape?: string;
}
export interface SessionProviderRuntime extends SessionPromptState {
  effort?: string;
  verbose: boolean;
  backendTurnTimeoutMs?: number;
  backendIdleTimeoutMs?: number;
}
export interface SessionProviderPorts {
  runtime: SessionProviderRuntime;
  state: SessionProviderState;
  ledger: ContextLedger;
  sbSlug: string;
  cliAttached: boolean;
  passthroughArgs: string[];
  /** Live dialogue: streaming adds assistant entries; continuation adds runtime entries. */
  dialogue: ReseedDialogueEntry[];
  mintId(): string;
  append(entry: Record<string, unknown>): number;
  /** Confirm queued history/seed writes before every provider launch. Not fsync. */
  flush(): Promise<void>;
  buildEnvelope(body: string, stamp?: string): string;
  measurement(): ProviderContextMeasurement | undefined;
  spawnContext(): Pick<
    BackendRunRequest,
    'workingDirectory' | 'inkSessionId' | 'studioId' | 'host' | 'withholdProviderTools'
  >;
  attachmentDirs(): string[] | undefined;
  /** Images this exact provider session has not received; absent for non-image hosts. */
  contextImagesFor?(targetSessionId: string | undefined): TurnMedia[] | undefined;
  /** Record only the images the adapter actually carried, not those offered to it. */
  noteImagesDelivered?(
    targetSessionId: string | undefined,
    result: Pick<BackendRunResult, 'success' | 'contextImagesDelivered'>
  ): void;
  startTurn(request: BackendRunRequest): BackendTurnHandle;
  onEvent: NonNullable<BackendRunRequest['onEvent']>;
  beginSpawn(): void;
  endSpawn(): void;
  onAbortHandle(abort: (() => void) | null): void;
  onInitialSettled(): void;
  onInitialResult(result: BackendRunResult): void;
  recordUsage(usage: BackendTokenUsage | undefined): void;
  sampleContext(usage: BackendTokenUsage | undefined): void;
  contextGeneration(): number;
  mutationsInFlight(): number;
  notice(reason: 'resume-missing' | 'mid-turn-roll'): void;
}

export function createSessionProviderTurn(
  ports: SessionProviderPorts,
  raw: string,
  turnMedia: TurnMedia[],
  prepared: PreparedSessionTurn
) {
  const {
    runtime,
    state,
    ledger,
    sbSlug,
    cliAttached,
    passthroughArgs,
    dialogue: turnDialogue,
  } = ports;
  const promptHookResult = prepared.promptHooks;
  const contextStamp = formatContextStamp(prepared.occupancy);
  // Provider session seed/resume decision (claude only). The first backend
  // spawn of the session SEEDS a fresh provider session (--session-id) with
  // the FULL envelope; every later turn RESUMES it (--resume) sending only
  // this turn's delta — the new user message plus any passive-recall surfaced
  // this turn — because the provider already holds the system prompt, tools,
  // bootstrap, and prior turns. The tool-loop continuations below always
  // resume the same session. This collapses the whole conversation into ONE
  // coherent Claude jsonl and stops re-piping the transcript window on every
  // round-trip. Stateless backends (codex/gemini) always get the full
  // envelope.
  //
  // `canReuseBackendSession` is computed PER-TURN against the current backend
  // so a mid-session /backend switch is honored (not captured once at
  // startup). And a live session is invalidated when the envelope's static
  // SHAPE has drifted since it was seeded — /backend, /model, /tool-routing,
  // /skill-use, /skill-clear, /refresh, profile changes. Otherwise the resumed
  // native session would be stale (e.g. seeded with backend tool-routing, then
  // /tool-routing local leaves it without ink-tool instructions while native
  // tools are disabled). On drift we reseed fresh with the new envelope.
  const canReuseBackendSession = runtime.backend === 'claude';
  const currentEnvelopeShape = envelopeShapeKey(runtime);
  if (state.id !== undefined) {
    if (state.shape === undefined) {
      // Recovered from a prior process — adopt this turn's shape as the
      // baseline (no invalidation). Cross-process bootstrap drift is
      // tolerated; only in-process drift from here triggers a reseed.
      state.shape = currentEnvelopeShape;
    } else if (state.shape !== currentEnvelopeShape) {
      // In-process envelope drift — the resumed native session would be
      // stale, so invalidate and reseed fresh with the new envelope.
      state.id = undefined;
      state.shape = undefined;
    }
  }
  const resumeProviderSession = canReuseBackendSession && state.id !== undefined;
  let seedProviderSessionId: string | undefined;
  if (canReuseBackendSession && !resumeProviderSession) {
    seedProviderSessionId = ports.mintId();
    state.id = seedProviderSessionId;
    state.shape = currentEnvelopeShape;
    // Persist the seed so a later process (next heartbeat / reattach) recovers
    // and RESUMES this native session instead of fragmenting into a new jsonl.
    // routing rides along so cross-process recovery can refuse a session
    // seeded under the other instruction envelope.
    ports.append({
      type: 'backend_session',
      id: seedProviderSessionId,
      routing: runtime.toolRouting,
    });
  }

  let prompt: string;
  if (resumeProviderSession) {
    const recallDelta = promptHookResult.injectedEntries
      .filter((e) => e.source === 'passive-recall')
      .map((e) => e.content)
      .join('\n\n');
    // The stamp rides the DELTA, not just the envelope. A resumed native
    // session never re-reads the envelope, so anything that lives only there
    // is sent once at seed time and is stale for every turn after — and the
    // long-running resumed session is exactly the seat whose window fills.
    prompt = buildDeltaPrompt(contextStamp, recallDelta, raw);
  } else {
    prompt = ports.buildEnvelope(raw, contextStamp);
  }

  // ── Backend port for this turn ──
  // The loop (@inklabs/shared/runtime) decides WHAT to send and whether to send
  // again. This shared composition owns session seeding and reuse, recovery
  // when a resumed session vanished, and media delivery flags. The injected
  // host owns launches, cancellation, debug and activity logging. A shadow clone
  // supplies a far simpler runTurn and shares the loop unchanged.
  let lastRunResult!: BackendRunResult;
  // What this turn's loop has already put in the provider's context that the
  // ledger cannot see yet: every continuation body sent and every reply
  // received. The relay budget shrinks by it, or each iteration re-grants
  // the same allowance while the window fills (Lumen, PR #576 round 3).
  let loopOccupancyTokens: number | undefined;
  // A stateless parent: the last report's prompt tokens and the highest
  // ledger entry id at that moment, so every entry added since is charged at
  // its rendered bytes — by id, never as a net total an eviction could hide.
  let statelessPromptTokens: number | undefined;
  let ledgerMaxIdAtReport = -1;
  let statelessGenerationAtReport = 0;
  const maxLedgerId = (): number => ledger.listEntries().reduce((m, e) => Math.max(m, e.id), -1);
  const nativeSession = (): boolean => Boolean(canReuseBackendSession && state.id);
  /**
   * After each spawn. NATIVE session: the provider's own occupancy when it
   * reported one — everything sent and received so far, hidden thinking
   * included — else UNKNOWN until the next report (what an unreported spawn
   * added cannot be recovered from visible text). STATELESS parent: the
   * report's prompt tokens — the provider's own count of the envelope, with
   * discovered files, tool schemas and media inside it — and the ledger
   * size at that moment; the reply is not re-sent and is not counted
   * (Lumen, PR #576 rounds 5–10).
   */
  const noteSpawn = (
    result: BackendRunResult,
    ledgerIdBeforeSpawn: number,
    generationBeforeSpawn: number
  ): void => {
    if (nativeSession()) {
      loopOccupancyTokens = occupancyTokens(runtime.backend, result.usage);
      return;
    }
    statelessPromptTokens = promptTokensOf(runtime.backend, result.usage);
    // The high-water id from BEFORE the spawn: an entry polled in while the
    // backend ran (inbox, activity) is absent from the reported prompt and
    // must be charged, not marked covered (Lumen, PR #576 round 12).
    ledgerMaxIdAtReport = ledgerIdBeforeSpawn;
    statelessGenerationAtReport = generationBeforeSpawn;
  };
  /** The continuation spawn's request; the budget measures the same shape. */
  const continuationRequest = (
    prompt: string,
    spawn: ContinuationSpawnArgs = { sessionArgs: {}, deliverMedia: false },
    contextImages?: TurnMedia[]
  ): BackendRunRequest => ({
    backend: runtime.backend,
    sbSlug,
    model: runtime.model,
    effort: runtime.effort,
    prompt,
    verbose: runtime.verbose,
    passthroughArgs,
    systemPromptOverride: runtime.systemPromptOverride,
    timeoutMs: runtime.backendTurnTimeoutMs,
    idleTimeoutMs: runtime.backendIdleTimeoutMs,
    stream: true,
    onEvent: ports.onEvent,
    attachmentDirs: ports.attachmentDirs(),
    toolRouting: runtime.toolRouting,
    // Same logical turn — media rides along so the adapter's boundary
    // disposition (--tools gate) cannot flap between the delivery spawn and
    // tool-loop continuations. A RESUME never re-delivers it (the session
    // holds it); a mid-turn SEED must (the fresh session has never seen it);
    // stateless adapters re-attach from `media` regardless.
    media: turnMedia.length > 0 ? turnMedia : undefined,
    ...(spawn.deliverMedia ? { deliverMedia: true } : {}),
    ...(contextImages && contextImages.length > 0 ? { contextImages } : {}),
    cliAttached,
    ...ports.spawnContext(),
    // The session argument is the DECISION's, never derived from the live id:
    // a seed assigns the minted id before spawning, and deriving from it sent
    // a resume of a session that did not exist yet (Lumen, PR #577).
    ...spawn.sessionArgs,
  });
  /**
   * What the window holds for the next relay — see relayBudgetBytes. A
   * stateless parent's next envelope is the last report's prompt plus the
   * rendered bytes of every entry added to the ledger since (by id).
   */
  const relayOccupancy = (): number | undefined => {
    if (nativeSession()) return loopOccupancyTokens;
    if (statelessPromptTokens === undefined) return undefined;
    // A mutator ran since the report, or is still running (parent or
    // clone): the next fresh spawn may discover a different context —
    // unknown, the floor.
    if (
      ports.mutationsInFlight() > 0 ||
      statelessGenerationAtReport !== ports.contextGeneration()
    ) {
      return undefined;
    }
    const addedBytes = ledger
      .listEntries()
      .filter((e) => e.id > ledgerMaxIdAtReport)
      .reduce((n, e) => n + ledgerEntryPromptBytes(e), 0);
    return statelessPromptTokens + addedBytes;
  };

  const beforeDispatch = async (signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    await ports.flush();
    signal?.throwIfAborted();
  };

  const runTurnForLoop = async (
    body: string,
    ctx: { isContinuation: boolean; signal?: AbortSignal }
  ): Promise<BackendTurnOutcome> => {
    if (!ctx.isContinuation) {
      const openingSessionId =
        seedProviderSessionId ?? (resumeProviderSession ? state.id : undefined);
      const openingImages = ports.contextImagesFor?.(openingSessionId);
      const ledgerIdBeforeSpawn = maxLedgerId();
      const generationBeforeSpawn = ports.contextGeneration();
      let runResult: BackendRunResult;
      await beforeDispatch(ctx.signal);
      ports.beginSpawn();
      try {
        const turn = ports.startTurn({
          backend: runtime.backend,
          sbSlug,
          model: runtime.model,
          effort: runtime.effort,
          prompt: body,
          verbose: runtime.verbose,
          passthroughArgs,
          systemPromptOverride: runtime.systemPromptOverride,
          timeoutMs: runtime.backendTurnTimeoutMs,
          idleTimeoutMs: runtime.backendIdleTimeoutMs,
          stream: true,
          onEvent: ports.onEvent,
          attachmentDirs: ports.attachmentDirs(),
          toolRouting: runtime.toolRouting,
          // Delivery spawn: embed this turn's media even when resuming a
          // recovered provider session — new media on an existing conversation
          // must reach the provider (heartbeat/reattach path).
          media: turnMedia.length > 0 ? turnMedia : undefined,
          ...(turnMedia.length > 0 ? { deliverMedia: true } : {}),
          ...(openingImages ? { contextImages: openingImages } : {}),
          // Seed a fresh provider session (first spawn) OR resume the live one
          // (subsequent turns). Tool-loop continuations always resume it.
          ...(seedProviderSessionId ? { backendSessionSeedId: seedProviderSessionId } : {}),
          ...(resumeProviderSession && state.id ? { backendSessionId: state.id } : {}),
          cliAttached,
          ...ports.spawnContext(),
        });
        ports.onAbortHandle(turn.abort);

        runResult = await turn.result;
      } finally {
        try {
          ports.onAbortHandle(null);
          ports.onInitialSettled();
        } finally {
          ports.endSpawn();
        }
      }
      ports.noteImagesDelivered?.(openingSessionId, runResult);
      // Recorded here, not after the reseed branch: a failed resume that
      // reported usage still spent those tokens, and the retry below
      // REASSIGNS runResult — recording once at the end would silently drop
      // the first attempt (Lumen, PR #494 round 3).
      ports.recordUsage(runResult.usage);
      ports.sampleContext(runResult.usage);

      // A vanished native session (cleanup or another machine) gets one full
      // reseed in this turn, preserving both attempts' usage and media delivery.
      if (
        resumeProviderSession &&
        !ctx.signal?.aborted &&
        !runResult.success &&
        (runResult.resumeFailedNoSession || isResumeFailedNoSession(runResult.stderr))
      ) {
        // Mint a fresh native session, re-send the FULL envelope (the ledger
        // already holds the history), and retry once so a server heartbeat still
        // produces output instead of dying on a stale id. Mirrors
        // ClaudeRunner/InkRunner's resume-not-found recovery.
        const reseedId = ports.mintId();
        state.id = reseedId;
        state.shape = currentEnvelopeShape;
        ports.append({
          type: 'backend_session',
          id: reseedId,
          routing: runtime.toolRouting,
        });
        ports.notice('resume-missing');
        // Regenerated HERE, after the new id is assigned, and never the
        // opening's contextStamp reused. The stamped resume died before a
        // model read it; THIS seed is the first request of the turn anything
        // answers. The reassignment above is what makes the reading honest:
        // providerScope() keys on state.id, so the failed
        // session's measurement no longer matches and the stamp falls back to
        // the estimate instead of describing a window that no longer exists.
        const reseedStamp = formatContextStamp(
          turnContextOccupancy(ledger, runtime, ports.measurement())
        );
        const reseedImages = ports.contextImagesFor?.(reseedId);
        await beforeDispatch(ctx.signal);
        ports.beginSpawn();
        try {
          const reseedTurn = ports.startTurn({
            backend: runtime.backend,
            sbSlug,
            model: runtime.model,
            effort: runtime.effort,
            prompt: ports.buildEnvelope(raw, reseedStamp),
            verbose: runtime.verbose,
            passthroughArgs,
            systemPromptOverride: runtime.systemPromptOverride,
            timeoutMs: runtime.backendTurnTimeoutMs,
            idleTimeoutMs: runtime.backendIdleTimeoutMs,
            stream: true,
            onEvent: ports.onEvent,
            attachmentDirs: ports.attachmentDirs(),
            toolRouting: runtime.toolRouting,
            // The reseeded provider session is fresh — re-inject this turn's
            // media so the full envelope carries the images too.
            media: turnMedia.length > 0 ? turnMedia : undefined,
            ...(turnMedia.length > 0 ? { deliverMedia: true } : {}),
            ...(reseedImages ? { contextImages: reseedImages } : {}),
            backendSessionSeedId: reseedId,
            cliAttached,
            ...ports.spawnContext(),
          });
          ports.onAbortHandle(reseedTurn.abort);
          runResult = await reseedTurn.result;
        } finally {
          try {
            ports.onAbortHandle(null);
          } finally {
            ports.endSpawn();
          }
        }
        ports.noteImagesDelivered?.(reseedId, runResult);
        ports.recordUsage(runResult.usage);
        ports.sampleContext(runResult.usage);
      }

      ports.onInitialResult(runResult);

      lastRunResult = runResult;
      noteSpawn(runResult, ledgerIdBeforeSpawn, generationBeforeSpawn);
      return runResult;
    }

    // ── Continuation ──
    // When resuming the same Claude session the model already holds the full
    // transcript + tool instructions from the seeded turn, so send ONLY the
    // delta. When the session was rolled mid-turn, SEED a fresh one now —
    // full envelope, the model's own output so far, and a persisted id so
    // the rest of this turn and the next resume it (#572). Stateless
    // backends re-pack the full envelope every time.
    const decision = decideContinuationSession(canReuseBackendSession, state.id, ports.mintId);
    if (decision.mode === 'seed') {
      state.id = decision.id;
      // Recomputed HERE, not the pre-spawn snapshot: the opening spawn's
      // model init may have changed the budget (applyDetectedModel), and
      // the envelope built below uses the new one. Recording the stale
      // shape made the NEXT turn roll this session again — the very
      // fragmentation this fix exists to stop (Lumen, PR #577).
      state.shape = envelopeShapeKey(runtime);
      ports.append({
        type: 'backend_session',
        id: decision.id,
        routing: runtime.toolRouting,
        reason: 'mid-turn-roll',
      });
      ports.notice('mid-turn-roll');
    }
    // Regenerated per continuation, never the opening's stamp reused: the
    // preceding spawn's usage has since been sampled, so THIS is the first
    // reading of the turn backed by a provider measurement. A run whose whole
    // job happens inside the tool loop would otherwise never see one.
    const continuationStamp = formatContextStamp(
      turnContextOccupancy(ledger, runtime, ports.measurement())
    );
    const continuationPrompt = buildContinuationPrompt(
      decision.mode,
      continuationStamp,
      body,
      (promptBody, stamp) => ports.buildEnvelope(promptBody, stamp),
      () => buildMidTurnReseedBody([...turnDialogue, { role: 'runtime', text: body }])
    );

    // Recorded for a later reseed in this same turn; the seed above already
    // rendered this body itself.
    turnDialogue.push({ role: 'runtime', text: body });

    const contSpawn = continuationSpawnArgs(decision, turnMedia.length > 0);
    const contSessionId =
      contSpawn.sessionArgs.backendSessionId ?? contSpawn.sessionArgs.backendSessionSeedId;
    const contImages = ports.contextImagesFor?.(contSessionId);
    let contResult: BackendRunResult;
    const ledgerIdBeforeSpawn = maxLedgerId();
    const generationBeforeSpawn = ports.contextGeneration();
    await beforeDispatch(ctx.signal);
    ports.beginSpawn();
    try {
      const contTurn = ports.startTurn(
        continuationRequest(continuationPrompt, contSpawn, contImages)
      );
      ports.onAbortHandle(contTurn.abort);

      contResult = await contTurn.result;
    } finally {
      try {
        ports.onAbortHandle(null);
      } finally {
        ports.endSpawn();
      }
    }
    ports.noteImagesDelivered?.(contSessionId, contResult);

    lastRunResult = contResult;
    ports.recordUsage(contResult.usage);
    ports.sampleContext(contResult.usage);
    noteSpawn(contResult, ledgerIdBeforeSpawn, generationBeforeSpawn);
    return contResult;
  };

  return {
    prompt,
    runTurn: runTurnForLoop,
    relayOccupancy,
    get lastRunResult(): BackendRunResult {
      return lastRunResult;
    },
  };
}
