/** Shared shadow-clone execution; hosts supply effects, identity and approval UI. */
import {
  runAgentLoop,
  createSignalSink,
  ContextLedger,
  compactForLedger,
  buildClonePrompt,
  boundSummary,
  classifyCloneOutcome,
  describeCloneToolResult,
  formatFanOutForLedger,
  selectOutcomesToLedger,
  parseSpawnAgentArgs,
  admitSpawn,
  MAX_CLONE_SUMMARY_CHARS,
  isForbiddenInClone,
  isClientLocalTool,
  handleClientLocalTool,
  executeToolCalls,
  createToolIntentCommitter,
  createLocalToolDispatcher,
  bareToolName,
  impossibleCallRefusal,
  buildBackendToolPassthrough,
  buildLocalToolInstruction,
  relayBudgetBytes,
  occupancyTokens,
  promptTokensOf,
  isSettled,
  type ToolPolicyState,
  type SessionContextState,
  type SessionLog,
  type CloneRegistry,
  type CloneRecord,
  type CloneStatus,
  type SpawnAgentTask,
  type CloneOutcomeSummary,
  type LocalToolCall,
  type ToolResultRecord,
  type SignalSink,
  type BackendTurnOutcome,
  type RuntimeToolCallResponse,
  type BackendTokenUsage,
  type ToolParametersLookup,
  createToolParametersLookup,
} from '../runtime/index.js';
import type { createSessionToolHost } from './session-tool-host.js';
import type {
  SessionProviderRuntime,
  SessionProviderPorts,
} from '../providers/session-provider.js';
import type { BackendRunRequest } from '../providers/backend-runner.js';

export const CLONE_HISTORY_SEPARATOR = '\n\n---\n\n';
const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;
type CloneLog = Pick<SessionLog, 'path' | 'append' | 'flush'>;
export interface CloneApprovalOrigin {
  origin: 'clone';
  cloneId: string;
  cloneLabel: string;
}
export interface SessionClonesPorts<P extends ToolPolicyState> {
  runtime: SessionProviderRuntime & { sessionId?: string; log: CloneLog };
  sbSlug: string;
  cliAttached: boolean;
  policy: P;
  ledger: ContextLedger;
  registry: CloneRegistry;
  sessionContext: SessionContextState;
  toolHost: ReturnType<typeof createSessionToolHost>;
  cwd: string;
  /** Freeze tool-call attribution with the provider shape at clone creation. */
  bindInk(
    context: ReturnType<SessionProviderPorts['spawnContext']>
  ): (name: string, args: Record<string, unknown>) => Promise<RuntimeToolCallResponse>;
  derivePolicy(parent: P, sessionId?: string): P;
  createLog(path: string): CloneLog;
  mintId(): string;
  spawnContext: SessionProviderPorts['spawnContext'];
  startTurn: SessionProviderPorts['startTurn'];
  approve(ticket: {
    tool: string;
    args: Record<string, unknown>;
    reason: string;
    sessionId?: string;
    origin: CloneApprovalOrigin;
    signal?: AbortSignal;
    policy: P;
  }): Promise<boolean>;
  recordUsage(usage: BackendTokenUsage): void;
  printEvent(text: string): void;
}

export function createSessionClones<P extends ToolPolicyState>(ports: SessionClonesPorts<P>) {
  const {
    runtime,
    sbSlug,
    cliAttached,
    policy: toolPolicy,
    ledger,
    registry: cloneRegistry,
    sessionContext,
  } = ports;
  const cloneRuns = new Set<Promise<unknown>>();
  /**
   * Run ONE shadow clone to completion.
   *
   * The clone shares the loop and nothing else: its own narrowed policy, its own
   * transcript, its own provider session, no ledger of the parent's, and no
   * `observe` port (its tool calls are its business, not the Ctrl+T inspector's).
   * What comes back is its final message — the summary the parent asked for.
   */
  const runOneClone = async (
    record: CloneRecord,
    task: SpawnAgentTask,
    ctx: { index: number; total: number; signal?: AbortSignal }
  ): Promise<void> => {
    // Derived per clone, never shared: canCallInkTool mutates, so two clones on
    // one policy object would consume the parent's grants by interleaving.
    const clonePolicy = ports.derivePolicy(toolPolicy, record.parentSessionId);
    const cloneOrigin: CloneApprovalOrigin = {
      origin: 'clone',
      cloneId: record.id,
      cloneLabel: record.label,
    };
    // Its own log, with its own eid sequence and no observer: a clone's entries
    // never reach the parent's live stream, whatever their type.
    const cloneLog = ports.createLog(record.transcriptPath);

    /**
     * Snapshot the provider at launch.
     *
     * A background clone outlives the turn that spawned it, so reading
     * `runtime.backend` / `.model` / `.toolRouting` per turn would let a slash
     * command switch a running clone's provider mid-flight — and resume a
     * session id against a CLI that never created it.
     */
    const cloneBackend = runtime.backend;
    const cloneModel = runtime.model;
    const cloneRouting = runtime.toolRouting;
    // Frozen with the rest of the clone's shape: its budget must describe
    // the window IT was spawned into, not whatever the parent switches to
    // while it runs (Lumen, PR #576 round 4).
    const cloneMaxContextTokens = runtime.maxContextTokens;
    const cloneEffort = runtime.effort;
    const cloneSystemPromptOverride = runtime.systemPromptOverride;
    const cloneTimeoutMs = runtime.backendTurnTimeoutMs;
    const cloneIdleTimeoutMs = runtime.backendIdleTimeoutMs;
    const cloneSpawnContext = { ...ports.spawnContext() };
    const callInk = ports.bindInk(cloneSpawnContext);
    const toolParameters = createToolParametersLookup((tool) =>
      callInk('describe_tool', { name: tool })
    );
    /**
     * Only Claude actually honours a seeded provider session — the parent host
     * gates on exactly this (`canReuseBackendSession`). Codex and Gemini ignore
     * the seed, so handing them `--resume <uuid>` on the second turn resumes a
     * session that never existed and fails the moment a clone uses a tool.
     */
    const cloneCanReuseSession = cloneBackend === 'claude';
    /**
     * What a stateless clone has to be re-told each turn, because its provider
     * remembers nothing: its opening brief, then every exchange since.
     */
    const cloneHistory: string[] = [];

    // Recomputed from the CLONE's gate, over the snapshotted backend.
    // Inheriting the parent's passthroughArgs would hand a narrowed clone the
    // parent's full backend tool surface.
    const clonePassthrough = buildBackendToolPassthrough(
      cloneBackend,
      cloneRouting,
      clonePolicy.getBackendToolGate(),
      runtime.strictTools
    ).passthroughArgs;

    let cloneProviderSessionId: string | undefined;
    let cloneToolCalls = 0;
    // This clone's own signal state — never the parent's global.
    const cloneSignal = createSignalSink();
    /** What the clone's window holds beyond its ledger — see relayBudgetBytes. */
    let cloneOccupancyTokens: number | undefined;
    let cloneGenerationAtReport = 0;
    /** The clone spawn's request; the budget measures the same shape. */
    const cloneRequest = (
      prompt: string,
      sessionArgs: Record<string, string> = {}
    ): BackendRunRequest => ({
      backend: cloneBackend,
      sbSlug,
      model: cloneModel,
      effort: cloneEffort,
      prompt,
      verbose: false,
      passthroughArgs: clonePassthrough,
      systemPromptOverride: cloneSystemPromptOverride,
      timeoutMs: cloneTimeoutMs,
      idleTimeoutMs: cloneIdleTimeoutMs,
      stream: true,
      toolRouting: cloneRouting,
      cliAttached,
      ...cloneSpawnContext,
      ...sessionArgs,
    });

    const cloneRunTurn = async (
      body: string,
      turnCtx: { isContinuation: boolean }
    ): Promise<BackendTurnOutcome> => {
      let sessionArgs: Record<string, string> = {};
      if (cloneCanReuseSession) {
        const isFirst = cloneProviderSessionId === undefined;
        const seedId = cloneProviderSessionId ?? ports.mintId();
        cloneProviderSessionId = seedId;
        sessionArgs = isFirst ? { backendSessionSeedId: seedId } : { backendSessionId: seedId };
      }

      // Stateless providers get the whole thread re-packed; stateful ones get
      // the delta, because they already hold the history — and so do not need it
      // accumulated in memory for the life of the clone either.
      const prompt =
        cloneCanReuseSession || !turnCtx.isContinuation
          ? body
          : [...cloneHistory, body].join(CLONE_HISTORY_SEPARATOR);
      if (!cloneCanReuseSession) cloneHistory.push(body);

      ctx.signal?.throwIfAborted();
      await cloneLog.flush();
      ctx.signal?.throwIfAborted();
      const generationBeforeSpawn = sessionContext.generation;
      const turn = ports.startTurn(cloneRequest(prompt, sessionArgs));

      // Ctrl+C on the parent turn kills the clone's child too, not just the
      // parent's — otherwise a cancelled turn leaves backends running.
      const onAbort = () => turn.abort();
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      if (ctx.signal?.aborted) onAbort();

      const result = await turn.result.finally(() =>
        ctx.signal?.removeEventListener('abort', onAbort)
      );
      const text = result.responseText ?? result.stdout;
      // A native session accumulates every body and reply; a stateless one
      // re-packs its history into each prompt, so the latest prompt IS the
      // window. Either way this is what the next relay must fit beside.
      // A native clone session: the report covers everything so far; a spawn
      // that reported nothing leaves it unknown (the floor) until the next
      // report. A stateless clone re-packs its history: the report's prompt
      // covered the history and body sent, and the reply now joins the
      // history, so it is added at the byte bound.
      cloneOccupancyTokens = cloneCanReuseSession
        ? occupancyTokens(cloneBackend, result.usage)
        : (() => {
            const prompt = promptTokensOf(cloneBackend, result.usage);
            // The reply joins the history with a separator on each side of
            // the next body (Lumen, PR #576 round 11).
            return prompt === undefined
              ? undefined
              : prompt + utf8Bytes(text) + 2 * utf8Bytes(CLONE_HISTORY_SEPARATOR);
          })();
      cloneGenerationAtReport = generationBeforeSpawn;
      if (!cloneCanReuseSession && text.trim()) cloneHistory.push(text.trim());
      cloneLog.append({
        type: 'backend_turn',
        continuation: turnCtx.isContinuation,
        success: result.success,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        // The clone's actual output, not just its timing. boundSummary promises
        // the full transcript is on disk; without this it is not.
        responseText: text,
        ...(result.stderr?.trim() ? { stderr: result.stderr.slice(0, 4000) } : {}),
      });
      // Cost is the session's; the WINDOW is the clone's own. Its usage never
      // becomes the parent's provider sample.
      if (result.usage) ports.recordUsage(result.usage);
      return {
        success: result.success,
        responseText: result.responseText,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    };

    try {
      cloneLog.append({
        type: 'clone_start',
        id: record.id,
        label: record.label,
        parentSessionId: record.parentSessionId,
        prompt: task.prompt,
      });

      const result = await runAgentLoop(
        {
          // The clone starts from nothing, so its prompt has to carry the tool
          // protocol itself — it never sees the parent's envelope.
          prompt: [
            buildClonePrompt(task, { id: record.id, index: ctx.index, total: ctx.total }),
            ...(cloneRouting === 'local'
              ? ['', buildLocalToolInstruction({ audience: 'clone' })]
              : []),
          ].join('\n'),
          toolRouting: cloneRouting,
          signal: ctx.signal,
          // Nobody is watching a clone's scrollback, so a refusal it is not told
          // about becomes silent abandonment of the task.
          continueOnBlocked: true,
          // The clone's window is its own: the same model window, its identity
          // prompt in place of the parent's bootstrap, its own ledger of
          // local-tool summaries, and what its session (or re-packed history)
          // holds. Without this it took the static 200K default (Lumen, PR
          // #576 round 3).
          relayBudgetBytes: () =>
            relayBudgetBytes(
              { maxContextTokens: cloneMaxContextTokens },
              // A stateless clone's count is trusted only within the generation
              // it was reported in — its own mutators and a concurrent parent's
              // both bump it (Lumen, PR #576 round 13).
              cloneCanReuseSession ||
                (sessionContext.mutationsInFlight === 0 &&
                  cloneGenerationAtReport === sessionContext.generation)
                ? cloneOccupancyTokens
                : undefined
            ),
        },
        {
          ui: {
            // A clone's progress belongs to the clone, not the parent's
            // scrollback — the parent gets one summary, which is the point.
            printLine: (text) => cloneLog.append({ type: 'clone_line', text }),
            printEvent: (text) => cloneLog.append({ type: 'clone_event', text }),
            startWaiting: () => () => {},
          },
          tools: {
            // No `screen` port: nesting is refused at the executor below, and a
            // clone has no fan-out rule of its own to enforce.
            execute: async (calls, execCtx) => {
              cloneToolCalls += calls.length;
              cloneRegistry.update(record.id, {
                iterations: execCtx.iteration + 1,
                toolCalls: cloneToolCalls,
              });
              return runCloneTools(calls, {
                policy: clonePolicy,
                origin: cloneOrigin,
                signal: execCtx.signal,
                log: cloneLog,
                callInk,
                toolParameters,
                sessionId: record.parentSessionId,
                signalSink: cloneSignal,
              });
            },
          },
          backend: { runTurn: (body, turnCtx) => cloneRunTurn(body, turnCtx) },
        }
      );

      const fullText = result.assistantDisplayText || result.responseText;
      const summary = boundSummary(fullText);
      cloneLog.append({
        type: 'clone_end',
        stopReason: result.stopReason,
        iterations: result.iterations,
        summary,
        // Bounded for the parent, whole on disk — otherwise "full transcript on
        // disk" is a promise the transcript cannot keep.
        ...(fullText.length > summary.length ? { fullText } : {}),
      });
      // A clone that ran out of road is not a clone that finished. The backend
      // exiting 0 says the process worked, not that the work happened — and the
      // parent only sees this status and the summary, so a false green here
      // means acting on a preamble as if it were an answer.
      await cloneLog.flush();
      const { status, error } = classifyCloneOutcome(result);
      cloneRegistry.update(record.id, {
        status,
        stopReason: result.stopReason,
        iterations: result.iterations,
        toolCalls: cloneToolCalls,
        summary,
        ...(error ? { error } : {}),
      });
      await logCloneActivity(record.id, status, cloneSpawnContext.studioId, callInk, {
        stopReason: result.stopReason,
        iterations: result.iterations,
        toolCalls: cloneToolCalls,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        cloneLog.append({ type: 'clone_error', error: message });
        await cloneLog.flush();
      } catch {
        /* A broken sink cannot confirm the error record either. */
      }
      cloneRegistry.update(record.id, { status: 'failed', error: message });
      await logCloneActivity(record.id, 'failed', cloneSpawnContext.studioId, callInk, {
        error: message,
      });
    } finally {
      cloneLedgers.delete(cloneLog.path);
    }
  };

  /**
   * Publish a clone's outcome to the activity stream.
   *
   * `sessionId` is the PARENT's, and `payload.cloneId` names the fork. That is
   * what lets the graph show a clone's work hanging off the turn that asked for
   * it, rather than as orphan activity from nowhere. Best-effort: a clone's
   * result is already safe on disk and in the registry, so a failed log line
   * must never take the clone down with it.
   */
  const logCloneActivity = async (
    cloneId: string,
    status: CloneStatus,
    studioId: string | undefined,
    callInk: ReturnType<SessionClonesPorts<P>['bindInk']>,
    payload: Record<string, unknown>
  ): Promise<void> => {
    const record = cloneRegistry.get(cloneId);
    if (!record || !record.parentSessionId) return;
    await callInk('log_activity', {
      sbSlug,
      type: status === 'completed' ? 'agent_complete' : 'error',
      subtype: 'shadow_clone',
      content: `🌀 ${record.id} (${record.label}) — ${status}`,
      sessionId: record.parentSessionId,
      status,
      payload: {
        cloneId: record.id,
        cloneLabel: record.label,
        parentSessionId: record.parentSessionId,
        transcriptPath: record.transcriptPath,
        studioId,
        ...payload,
      },
    }).catch(() => {
      // Activity logging is observability, not the work.
    });
  };

  /**
   * A clone's tool executor: the parent's pipeline, over the clone's policy.
   *
   * Deliberately NOT `runIterationTools` — that one writes to the parent's
   * ledger, its transcript, and the Ctrl+T inspector, all of which would leak the
   * clone's working detail into exactly the context the clone exists to protect.
   */
  const runCloneTools = async (
    calls: LocalToolCall[],
    opts: {
      policy: P;
      origin: CloneApprovalOrigin;
      signal?: AbortSignal;
      log: CloneLog;
      sessionId?: string;
      callInk: ReturnType<SessionClonesPorts<P>['bindInk']>;
      toolParameters: ToolParametersLookup;
      signalSink: SignalSink;
    }
  ): Promise<ToolResultRecord[]> => {
    const results: ToolResultRecord[] = [];
    const settleContextMutation = sessionContext.beginMutation(calls);
    try {
      await executeToolCalls(calls, {
        policy: opts.policy,
        commitIntent: createToolIntentCommitter(opts.log),
        mintInvocationId: ports.mintId,
        impossibleCallRefusal,
        sessionId: opts.sessionId,
        signal: opts.signal,
        // A clone's turns never carry an image block, so an image one of its
        // reads returns is replaced by a note saying so — never left as base64
        // for its relay to stringify.
        callTool: ports.toolHost.images.withImageCapture(
          createLocalToolDispatcher({
            cwd: ports.cwd,
            ...ports.toolHost.dispatch,
            callInk: (bare, resolved) => opts.callInk(bare, resolved),
            toolParameters: opts.toolParameters,
            // The clone's own policy, not the parent's: a clone that may not
            // describe tools gets no parameter help, cached or fresh.
            mayLookUpParameters: () => {
              const decision = opts.policy.inspectInkTool('describe_tool', opts.sessionId);
              return decision.allowed && !decision.wouldConsumeGrant;
            },
            resolveCredentials: (args) => ports.toolHost.dispatch.resolveCredentials(args),
            // A clone asking what it can call gets its own narrower surface —
            // the same one its prompt described, not the parent's.
            audience: 'clone',
            // And what its OWN policy will refuse, which is not the same thing:
            // a derived clone policy inherits the parent's denials on top of the
            // clone's, so a parent that denies `read` yields a clone that cannot
            // read. inspectInkTool, never canCallInkTool — asking what exists must
            // not spend the parent's one-use grants.
            isHardDenied: (tool) => {
              const decision = opts.policy.inspectInkTool(bareToolName(tool), opts.sessionId);
              return !decision.allowed && !decision.promptable;
            },
            head: (tool, args) => {
              // Non-nesting is enforced HERE, not by omitting spawn_agent from the
              // clone's prompt: tool calls travel as text, so a model can name any
              // tool it likes regardless of what it was told.
              if (isForbiddenInClone(tool)) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: `${tool} is not available to a shadow clone. Report what you found and let your parent act on it.`,
                    },
                  ],
                  isError: true,
                } as RuntimeToolCallResponse;
              }
              if (isClientLocalTool(tool)) {
                // A clone owns its ledger and signal state. Neither completion
                // nor cancellation may change the parent's continuation decision.
                return handleClientLocalTool(
                  tool,
                  args,
                  cloneLedgerFor(opts.log.path),
                  opts.signalSink
                );
              }
              return null;
            },
          }),
          {
            cacheDir: ports.toolHost.cacheDir,
            delivery: () => ({
              deliverable: false,
              reason:
                'a shadow clone cannot receive images; name the file in your summary so your parent can view it',
            }),
          }
        ),
        promptForApproval: (tool, reason, args) =>
          ports.approve({
            tool,
            args: args ?? {},
            reason,
            sessionId: opts.sessionId,
            origin: opts.origin,
            signal: opts.signal,
            // The clone's own policy: what gets re-checked, and what a grant
            // applies to. The parent stays untouched.
            policy: opts.policy,
          }),
        onResult: (result) => {
          // WHOLE, not a 20K slice: a truncated relay tells the agent the full
          // payload survives in this session's transcript, and for a clone this
          // file IS that transcript (Lumen, PR #576). A promise about durable
          // detail has to hold for the caller reading it, not just the parent.
          const resultJson =
            result.result === undefined ? undefined : JSON.stringify(result.result);
          opts.log.append({
            type: 'clone_tool_call',
            invocationId: result.invocationId,
            dispatchState: result.dispatchState,
            tool: result.tool,
            args: result.args,
            status: result.status,
            reason: result.reason,
            error: result.error,
            // The payload, not just the verdict. /clones <id> and the truncation
            // note both promise the working detail survives on disk.
            result: resultJson,
          });
          results.push({
            tool: result.tool,
            // A thrown tool reports through `error`, a refused one through
            // `reason` — they are different fields. Reading only `reason` feeds
            // the clone `Tool read (error): undefined`, which tells it nothing
            // about what went wrong and invites a blind retry.
            result: describeCloneToolResult(result),
            status: result.status,
            args: result.args,
          });
        },
      });
    } finally {
      settleContextMutation();
    }
    return results;
  };

  /**
   * Per-clone throwaway ledgers, keyed by transcript path.
   *
   * Client-local context tools need *a* ledger to operate on. A clone's is
   * discarded when the clone ends — its whole context is one bounded task, so
   * there is nothing to carry forward.
   */
  const cloneLedgers = new Map<string, ContextLedger>();
  const cloneLedgerFor = (transcriptPath: string): ContextLedger => {
    const existing = cloneLedgers.get(transcriptPath);
    if (existing) return existing;
    const fresh = new ContextLedger();
    cloneLedgers.set(transcriptPath, fresh);
    return fresh;
  };

  /**
   * Fan out a `spawn_agent` call.
   *
   * `allSettled`, never `all`: one clone failing to start must not discard the
   * summaries its siblings already produced.
   */
  const runSpawnAgent = async (
    args: Record<string, unknown>,
    ctx: { signal?: AbortSignal }
  ): Promise<RuntimeToolCallResponse> => {
    const parsed = parseSpawnAgentArgs(args);
    if (!parsed.ok) {
      return {
        content: [{ type: 'text', text: parsed.error }],
        isError: true,
      } as RuntimeToolCallResponse;
    }

    const { tasks, wait } = parsed.request;

    // The parse cap bounds ONE fan-out; this bounds what is alive.
    const admission = admitSpawn(cloneRegistry.runningCount, tasks.length);
    if (!admission.ok) {
      return {
        content: [{ type: 'text', text: admission.reason }],
        isError: true,
      } as RuntimeToolCallResponse;
    }

    if (!runtime.log.path.endsWith('.jsonl'))
      throw new Error('Clone parent log must end in .jsonl');
    const records: CloneRecord[] = tasks.map((task) => {
      const id = cloneRegistry.nextId();
      return cloneRegistry.register({
        id,
        label: task.label,
        prompt: task.prompt,
        parentSessionId: runtime.sessionId,
        transcriptPath: runtime.log.path.replace(/\.jsonl$/, `.${id}.jsonl`),
      });
    });

    try {
      ports.printEvent(
        `  🌀 spawning ${records.length} shadow clone(s): ${records.map((r) => `${r.id} (${r.label})`).join(', ')}`
      );
    } catch {
      /* presentation does not own execution */
    }

    // Each clone gets its own controller, chained from the turn's signal.
    //
    // Chained rather than shared because the lifetimes differ: Ctrl+C during the
    // spawning turn must still kill them, but a background clone outlives that
    // turn, after which the turn's handler can no longer reach it. Its own
    // controller is what `/clones cancel` and session-end teardown pull on —
    // without which a runaway clone is unstoppable, and a still-running one at
    // exit keeps its backend child (and therefore the process) alive.
    const running = Promise.allSettled(
      records.map((record, index) => {
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
        if (ctx.signal?.aborted) onAbort();
        cloneRegistry.attachCanceller(record.id, () => controller.abort());
        return runOneClone(record, tasks[index], {
          index,
          total: records.length,
          signal: controller.signal,
        })
          .catch((error: unknown) => {
            // Even a failed log factory or policy snapshot must settle waiters.
            cloneRegistry.update(record.id, { status: 'failed', error: String(error) });
          })
          .finally(() => ctx.signal?.removeEventListener('abort', onAbort));
      })
    );

    cloneRuns.add(running);
    void running.then(() => cloneRuns.delete(running));

    if (!wait) {
      // Background: the clones keep running in this process while the parent
      // moves on. Nothing awaits `running` here on purpose — the registry is the
      // handle, and `collect_agents` (or the TUI) picks the work up later.
      void running.then(() => {
        try {
          ports.printEvent(
            `  🌀 background clone(s) finished: ${records.map((r) => r.id).join(', ')}`
          );
        } catch {
          /* presentation only */
        }
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              spawned: records.map((r) => ({ id: r.id, label: r.label })),
              mode: 'background',
              note: 'Clones are running. Call collect_agents to read their summaries, or continue and collect later.',
            }),
          },
        ],
      } as RuntimeToolCallResponse;
    }

    await running;
    return summarizeClones(records.map((r) => r.id));
  };

  /**
   * Collect background clones.
   *
   * Separate from `spawn_agent` so the parent can fire a fan-out, keep working,
   * and pick the results up when it actually needs them — including in a later
   * turn, since the registry outlives the turn that spawned them.
   */
  const runCollectAgents = async (
    args: Record<string, unknown>
  ): Promise<RuntimeToolCallResponse> => {
    const requested = Array.isArray(args.ids)
      ? args.ids.filter((id): id is string => typeof id === 'string')
      : undefined;
    const ids = requested?.length ? requested : cloneRegistry.list().map((r) => r.id);

    if (ids.length === 0) {
      return {
        content: [{ type: 'text', text: 'No shadow clones have been spawned in this session.' }],
      } as RuntimeToolCallResponse;
    }

    const unknown = ids.filter((id) => !cloneRegistry.get(id));
    if (unknown.length > 0) {
      return {
        content: [{ type: 'text', text: `Unknown clone id(s): ${unknown.join(', ')}` }],
        isError: true,
      } as RuntimeToolCallResponse;
    }

    if (args.wait !== false) {
      await Promise.all(ids.map((id) => waitForClone(id)));
    }
    return summarizeClones(ids);
  };

  /** Resolve when a clone reaches a terminal state. */
  const waitForClone = (id: string): Promise<void> =>
    new Promise((resolve) => {
      const record = cloneRegistry.get(id);
      if (!record || isSettled(record.status)) {
        resolve();
        return;
      }
      const unsubscribe = cloneRegistry.onChange((change) => {
        if (change.record.id !== id || !isSettled(change.record.status)) return;
        unsubscribe();
        resolve();
      });
    });

  /**
   * Stop anything still running, on the way out.
   *
   * A background clone keeps a backend child process alive, and Node will not
   * exit while that handle is open — so without this, quitting `ink chat` with a
   * clone still working hangs the terminal rather than closing it.
   */
  const cancelRunningClones = (): void => {
    const stopped = cloneRegistry.cancelAll();
    if (stopped > 0) {
      ports.printEvent(`  🌀 cancelled ${stopped} running clone(s) on exit`);
    }
  };

  /** Clones whose summary has already entered the parent's ledger. */
  const ledgeredClones = new Set<string>();

  /** Read back what clones produced, as one bounded payload. */
  const summarizeClones = (ids: string[]): RuntimeToolCallResponse => {
    const outcomes: CloneOutcomeSummary[] = ids.map((id) => {
      const record = cloneRegistry.get(id);
      if (!record) return { id, label: '(unknown)', status: 'missing' };
      return {
        id: record.id,
        label: record.label,
        status: record.status,
        summary: record.summary,
        error: record.error,
        iterations: record.iterations,
        stopReason: record.stopReason,
        transcriptPath: record.transcriptPath,
      };
    });

    // ONE ledger entry per clone, ever. Per-clone entries would put the clones'
    // working detail back into the parent's context, and re-collecting (polling
    // a background fan-out, or calling collect_agents again later) would inject
    // the same completed work over and over.
    const fresh = selectOutcomesToLedger(outcomes, ledgeredClones);
    if (fresh.length > 0) {
      const rendered = formatFanOutForLedger(fresh);
      ledger.addEntry(
        'system',
        compactForLedger(rendered, MAX_CLONE_SUMMARY_CHARS),
        'shadow-clone'
      );
      runtime.log.append({ type: 'clone_fanout', outcomes: fresh });
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ clones: outcomes }) }],
    } as RuntimeToolCallResponse;
  };

  return {
    spawn: runSpawnAgent,
    collect: runCollectAgents,
    cancel: cancelRunningClones,
    async drain() {
      await Promise.allSettled([...cloneRuns]);
    },
  };
}
