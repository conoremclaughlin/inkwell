/**
 * The session composition around Ink's existing loop. Hosts own authorization,
 * persistence I/O, tool effects, approvals, clones, intake and presentation.
 * This is not an ownership lease or a CPU/heap fault boundary.
 */
import {
  ContextLedger,
  CloneRegistry,
  deriveClonePolicy,
  SbHookRegistry,
  SessionContextState,
  SessionUsage,
  SessionTurnCoordinator,
  createSignalSink,
  registerBuiltinHooks,
  bootstrapSessionIdentity,
  hydrateLedgerFromEventStream,
  createProviderRecovery,
  resolveModelContextWindow,
  contextBudgetForWindow,
  createSessionTools,
  createToolParametersLookup,
  buildSessionPrompt,
  buildLocalToolInstruction,
  buildBackendToolPassthrough,
  turnContextOccupancy,
  screenIteration,
  MAX_TOOL_CALLS_PER_ITERATION,
  type SessionLog,
  type SessionTurnInput,
  type SessionTurnResult,
  type SessionTurnExecution,
  type ToolPolicyState,
  type AgentLoopPorts,
  type EvictedEntryRecord,
  type ToolCallResult,
} from '../runtime/index.js';
import type { createSessionToolHost } from './session-tool-host.js';
import { createSessionControls, type SessionControlsPorts } from './session-controls.js';
import { imagesToDeliver } from './tool-images.js';
import { localDeliveredSend } from '../runner/turn-reply.js';
import { createSessionClones, type SessionClonesPorts } from './session-clones.js';
import { backendTurnActivity } from './session-activity.js';
import { runSessionAgentTurn } from '../providers/session-agent-turn.js';
import {
  createSessionCompaction,
  type SessionCompactionPorts,
} from '../providers/session-compaction.js';
import { SessionStream, type SessionStreamPorts } from '../providers/session-stream.js';
import { applyDetectedModel } from '../providers/session-model.js';
import { acceptsContextImagesFor, promptTransportFor } from '../providers/registry.js';
import type {
  SessionProviderPorts,
  SessionProviderRuntime,
} from '../providers/session-provider.js';
import type { TurnMedia } from '../providers/types.js';
import type { SessionToolsPorts } from '../runtime/session-tools.js';

export interface ComposedSessionState extends SessionProviderRuntime {
  sessionId: string;
  studioId?: string;
  detectedModel?: string;
  backendTokenWindow: number;
  userTimezone: string;
}

export interface SessionCompositionPorts {
  sbSlug: string;
  /** Live, instance-owned state; a host may apply existing controls between turns. */
  runtime: ComposedSessionState;
  cliAttached: boolean;
  contextBudgetAuto: boolean;
  history: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>;
  log: Pick<SessionLog, 'path' | 'append' | 'flush' | 'seed'>;
  policy: ToolPolicyState;
  toolHost: ReturnType<typeof createSessionToolHost>;
  cwd: string;
  /** Session-scoped, including bootstrap, passive recall and sends. */
  callInk: SessionToolsPorts['dispatch']['callInk'];
  /** Best-effort activity with a host-owned finite deadline; no turn continuation logs. */
  logActivity(activity: Record<string, unknown>): Promise<void>;
  prepareHost(): Promise<void>;
  unavailable(reason: string): void;
  mintId(): string;
  spawnContext: SessionProviderPorts['spawnContext'];
  startTurn: SessionProviderPorts['startTurn'];
  /** Required capabilities; no silent placeholder implementations in a host. */
  cloneLog: SessionClonesPorts<ToolPolicyState>['createLog'];
  approveClone: SessionClonesPorts<ToolPolicyState>['approve'];
  approve(
    tool: string,
    reason: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<boolean>;
  presentation: {
    ui: AgentLoopPorts['ui'];
    render: SessionStreamPorts['render'];
    progress: SessionStreamPorts['progress'];
    toolStarted: SessionStreamPorts['toolStarted'];
    modelReported(model: string, windowChanged: boolean): void;
    toolResult(result: ToolCallResult): void;
    compacted: SessionCompactionPorts['compacted'];
    notice(message: string): void;
  };
  observe?: AgentLoopPorts['observe'];
  controls?: Pick<SessionControlsPorts, 'skills' | 'assertCurrent' | 'receipt'>;
}

export interface ComposedTurnInput extends SessionTurnInput {
  media?: TurnMedia[];
  attachmentDirs?: string[];
}

/** Bootstrap and replay finish before this instance can accept a turn. */
export async function composeInkSession(ports: SessionCompositionPorts, signal?: AbortSignal) {
  const { runtime, log, policy, toolHost, presentation, sbSlug } = ports;
  const ledger = new ContextLedger();
  const hooks = new SbHookRegistry();
  const sessionSignal = createSignalSink();
  const usage = new SessionUsage();
  const { passiveRecall } = registerBuiltinHooks(hooks, {
    callRecall: async (query, limit) => {
      try {
        const result = await ports.callInk('recall', {
          query,
          limit,
          sbSlug,
          recallMode: 'hybrid',
        });
        if (!result.success || !Array.isArray(result.memories)) return [];
        return result.memories.map((memory: Record<string, unknown>) => ({
          id: memory.id as string,
          content: memory.content as string,
          summary: (memory.summary as string) || null,
          topics: (memory.topics as string[]) || [],
        }));
      } catch {
        return [];
      }
    },
  });
  await bootstrapSessionIdentity(
    { sbSlug, systemPromptOverride: runtime.systemPromptOverride },
    {
      load: (slug) => ports.callInk('bootstrap', { sbSlug: slug }),
      ledger,
      setTimezone: (timezone) => {
        runtime.userTimezone = timezone;
      },
      setContext: (context) => {
        runtime.bootstrapContext = context;
      },
      prepareHost: ports.prepareHost,
      seedMemoryIds: (ids) => passiveRecall.seedBootstrapIds(ids),
      unavailable: ports.unavailable,
    },
    signal
  );
  signal?.throwIfAborted();
  const context = new SessionContextState({
    runtime: () => runtime,
    append: (event) => log.append(event),
    rolled: presentation.notice,
  });
  const controls = createSessionControls({
    runtime,
    log,
    policy,
    contextBudgetAuto: ports.contextBudgetAuto,
    mintId: ports.mintId,
    assertCurrent:
      ports.controls?.assertCurrent ??
      (() => {
        signal?.throwIfAborted();
      }),
    skills: ports.controls?.skills,
    receipt: ports.controls?.receipt,
    notice: presentation.notice,
    invalidateProvider: () => context.clearProvider(),
  });
  const recovery = createProviderRecovery(runtime.backend);
  const hydrated = await hydrateLedgerFromEventStream(ledger, ports.history, sbSlug, (event) => {
    signal?.throwIfAborted();
    recovery.push(event);
    controls.replay(event);
  });
  log.seed(hydrated.maxEid);
  const evicted: EvictedEntryRecord[] = [...hydrated.evictedEntries];
  passiveRecall.seedBootstrapIds(hydrated.recoveredMemoryIds);
  if (runtime.backend === 'claude') {
    const recovered = recovery.session;
    if (recovered?.routing === runtime.toolRouting) context.provider.id = recovered.id;
  }
  await controls.restore(signal, recovery.session?.controlId);
  const recoveredModel = recovery.model;
  if (recoveredModel && !runtime.model) {
    runtime.detectedModel = recoveredModel;
    runtime.backendTokenWindow = resolveModelContextWindow(runtime.backend, recoveredModel);
    if (ports.contextBudgetAuto)
      runtime.maxContextTokens = contextBudgetForWindow(
        runtime.backendTokenWindow,
        promptTransportFor(runtime.backend)
      );
  }
  const sample = hydrated.providerSample;
  if (sample)
    context.sample.record(
      {
        backend: sample.scope.backend,
        source: 'json',
        contextTokens: sample.contextTokens,
        contextParts: {
          inputTokens: sample.inputTokens,
          cacheReadTokens: sample.cacheReadTokens,
          cacheWriteTokens: sample.cacheWriteTokens,
        },
      },
      sample.scope,
      sample.at
    );

  const modelState = Object.assign(runtime, { log });
  const stream = new SessionStream({
    toolRouting: () => runtime.toolRouting,
    append: (event) => log.append(event),
    render: presentation.render,
    progress: presentation.progress,
    toolStarted: presentation.toolStarted,
    modelReported: (model) => {
      if (model !== runtime.detectedModel && model !== runtime.model) {
        const { windowChanged } = applyDetectedModel(modelState, model, ports.contextBudgetAuto);
        presentation.modelReported(model, windowChanged);
      }
    },
  });
  const compaction = createSessionCompaction({
    runtime,
    ledger,
    sessionContext: context,
    sessionEvictedEntries: evicted,
    sbSlug,
    cliAttached: ports.cliAttached,
    contextBudgetAuto: () => ports.contextBudgetAuto,
    append: (event) => log.append(event),
    flush: () => log.flush(),
    spawnContext: ports.spawnContext,
    startTurn: ports.startTurn,
    recordUsage: (value) => usage.record(value),
    formatTokens: (value) => value.toLocaleString(),
    trimmed: presentation.notice,
    progress: presentation.notice,
    deferred: () =>
      presentation.notice('Context enforcement deferred until the provider reports its model'),
    compacted: presentation.compacted,
  });
  const parameters = createToolParametersLookup((tool) =>
    ports.callInk('describe_tool', { name: tool })
  );
  const cloneRegistry = new CloneRegistry();
  const clones = createSessionClones({
    runtime: modelState,
    sbSlug,
    cliAttached: ports.cliAttached,
    policy,
    ledger,
    registry: cloneRegistry,
    sessionContext: context,
    toolHost,
    cwd: ports.cwd,
    // This host instance already has immutable, session-scoped tool attribution.
    bindInk: () => ports.callInk,
    derivePolicy: (parent, sessionId) => deriveClonePolicy(parent, { sessionId }).policy,
    createLog: ports.cloneLog,
    mintId: ports.mintId,
    spawnContext: ports.spawnContext,
    startTurn: ports.startTurn,
    approve: ports.approveClone,
    recordUsage: (value) => usage.record(value),
    printEvent: presentation.notice,
  });
  const tools = createSessionTools({
    sessionId: () => runtime.sessionId,
    ledger,
    log,
    policy,
    signalState: sessionSignal,
    mintInvocationId: ports.mintId,
    beginContextMutation: (calls) => context.beginMutation(calls),
    takeImages: toolHost.images.takeCapturedImages,
    capture: (dispatch) =>
      toolHost.images.withImageCapture(dispatch, {
        cacheDir: toolHost.cacheDir,
        delivery: () =>
          acceptsContextImagesFor(runtime.backend)
            ? { deliverable: true }
            : {
                deliverable: false,
                reason: `this session's backend (${runtime.backend}) cannot receive images`,
              },
      }),
    dispatch: {
      cwd: ports.cwd,
      ...toolHost.dispatch,
      callInk: ports.callInk,
      toolParameters: parameters,
    },
    spawnAgent: clones.spawn,
    collectAgents: clones.collect,
    compact: compaction.runSbCompaction,
    measurement: () => context.measurement(),
    recordEviction: compaction.recordEviction,
  });
  const coordinator = new SessionTurnCoordinator({
    ledger,
    hooks,
    log,
    state: () => ({ ...runtime, sbSlug, compactionInFlight: compaction.isInFlight() }),
    occupancy: () => turnContextOccupancy(ledger, runtime, context.measurement()),
    compact: (reason) => compaction.maybeCompactContext(reason),
    recordEviction: compaction.recordEviction,
  });
  let consecutiveBackendFailures = 0;
  const activityWrites = new Set<Promise<void>>();
  let deliveredImages: { sessionId: string | undefined; refs: Set<string> } = {
    sessionId: undefined,
    refs: new Set(),
  };
  let running = false;
  const run = async (
    input: ComposedTurnInput,
    options: {
      signal?: AbortSignal;
      continueOnFailure: boolean;
      onOutcome?(execution: SessionTurnExecution<void>): void;
    }
  ): Promise<SessionTurnResult<void> | undefined> => {
    // Guard before resetting stream state: rejected concurrent input must not
    // erase the live turn's dialogue or duplicate-send receipts.
    if (running) throw new Error('Session turn already running');
    options.signal?.throwIfAborted();
    if (!input.raw.trim()) return undefined;
    running = true;
    try {
      await controls.drain(options.signal);
      stream.resetTurn();
      stream.resetSends();
      return await coordinator.run(
        input,
        async (prepared) => {
          const gate = buildBackendToolPassthrough(
            runtime.backend,
            runtime.toolRouting,
            policy.getBackendToolGate(),
            runtime.strictTools
          );
          if (gate.warning) presentation.notice(gate.warning);
          const execution = await runSessionAgentTurn(
            {
              raw: input.raw,
              turnMedia: input.media ?? [],
              prepared,
              signal: options.signal,
              continueOnFailure: options.continueOnFailure,
            },
            {
              ui: presentation.ui,
              tools: {
                execute: (calls, ctx) =>
                  tools(calls, {
                    signal: ctx.signal,
                    promptForApproval: (tool, reason, args) =>
                      ports.approve(tool, reason, args ?? {}, ctx.signal),
                    onResult: (result) => {
                      const delivered = localDeliveredSend(result);
                      if (delivered) stream.sends.push(delivered);
                      presentation.toolResult(result);
                    },
                  }),
                screen: (all) => {
                  const verdict = screenIteration(all, MAX_TOOL_CALLS_PER_ITERATION);
                  return verdict.ok ? { calls: verdict.calls } : { rejected: verdict.reason };
                },
              },
              provider: {
                runtime,
                state: context.provider,
                ledger,
                sbSlug,
                cliAttached: ports.cliAttached,
                passthroughArgs: gate.passthroughArgs,
                dialogue: stream.dialogue,
                mintId: ports.mintId,
                append: (event) => log.append(event),
                flush: () => log.flush(),
                buildEnvelope: (body, stamp) =>
                  buildSessionPrompt(
                    sbSlug,
                    runtime,
                    ledger,
                    body,
                    buildLocalToolInstruction({ audience: 'parent' }),
                    stamp
                  ),
                measurement: () => context.measurement(),
                spawnContext: ports.spawnContext,
                attachmentDirs: () => input.attachmentDirs,
                contextImagesFor: (target) => {
                  if (!acceptsContextImagesFor(runtime.backend)) return undefined;
                  const images = imagesToDeliver(ledger.listImages(), deliveredImages, target);
                  return images.length ? images : undefined;
                },
                noteImagesDelivered: (target, result) => {
                  if (
                    !result.success ||
                    target === undefined ||
                    !result.contextImagesDelivered?.length
                  )
                    return;
                  if (deliveredImages.sessionId !== target)
                    deliveredImages = { sessionId: target, refs: new Set() };
                  for (const image of result.contextImagesDelivered) {
                    const ref = (image as { ref?: unknown }).ref;
                    if (typeof ref === 'string') deliveredImages.refs.add(ref);
                  }
                },
                startTurn: ports.startTurn,
                onEvent: (event) => stream.handle(event),
                beginSpawn: () => stream.beginSpawn(),
                endSpawn: () => stream.endSpawn(),
                // Hosted cancellation follows the run signal; a terminal attaches
                // its own UI handler outside this composition.
                onAbortHandle: () => {},
                onInitialSettled: () => {},
                onInitialResult: (result) => {
                  consecutiveBackendFailures = result.success ? 0 : consecutiveBackendFailures + 1;
                  const write = Promise.resolve()
                    .then(() =>
                      ports.logActivity(
                        backendTurnActivity({
                          sbSlug,
                          sessionId: runtime.sessionId,
                          studioId: runtime.studioId,
                          backend: runtime.backend,
                          durationSeconds: Math.max(0, Math.round(result.durationMs / 1000)),
                          result,
                        })
                      )
                    )
                    .catch(() => undefined);
                  activityWrites.add(write);
                  void write.then(() => activityWrites.delete(write));
                },
                recordUsage: (value) => usage.record(value),
                sampleContext: (value) => context.sampleUsage(value),
                contextGeneration: () => context.generation,
                mutationsInFlight: () => context.mutationsInFlight,
                notice: (reason) => presentation.notice(reason),
              },
              rollProviderSession: (reason, detail) => context.roll(reason, detail),
              observe: {
                recordToolCall: (call) => ports.observe?.recordToolCall(call),
                recordProtocolViolation: (violation) => {
                  log.append({
                    type: 'protocol_violation',
                    kind: violation.kind,
                    phase: violation.phase,
                    iteration: violation.iteration,
                    header: violation.header,
                    discardedChars: violation.discarded.length,
                    discarded: violation.discarded,
                  });
                  ports.observe?.recordProtocolViolation?.(violation);
                },
              },
            }
          );
          return { ...execution, value: undefined };
        },
        options.onOutcome,
        options.signal
      );
    } finally {
      await Promise.all(activityWrites);
      running = false;
    }
  };
  return {
    runtime,
    ledger,
    hooks,
    context,
    stream,
    sessionSignal,
    usage,
    compaction,
    hydrated,
    evicted,
    passiveRecall,
    run,
    clones,
    cloneRegistry,
    controls,
    consecutiveBackendFailures: () => consecutiveBackendFailures,
  };
}
