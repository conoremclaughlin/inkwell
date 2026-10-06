/**
 * An `ink` session's turn run inside this server by the shared session
 * composition, instead of by an `ink chat` subprocess (spec:live-agent-surfaces;
 * pr:701, Lumen 829710f5).
 *
 * This file is the server's side of that boundary: the contract the shared
 * composition is called with (HostedInkSession*), and the IRunner that calls
 * it. The composition is injected (`execute`) and bound once it has been
 * extracted from the CLI. Until then nothing here can run a turn, and a turn
 * selected for it is refused: it is never handed to the subprocess runner
 * instead.
 *
 * What the runner owns, whatever the composition does:
 * - Every provider launch goes through `ports.provider.startTurn`, so the
 *   runner sees each one, asks the caller's admission before it, and learns
 *   from its result whether the launch was accepted and whether its child's
 *   exit was confirmed (`result.childExited`).
 * - A turn reports refusedBeforeSpawn only when no launch was ever accepted.
 *   A refusal after an accepted launch never erases that dispatch.
 * - Stop (`config.signal`) aborts every open launch, and the runner waits,
 *   bounded, for each one's actual result. A launch whose result did not
 *   arrive, rejected with anything but a refusal, or reported no child exit,
 *   leaves the turn stopUnconfirmed.
 * - Replies leave by send_response, as they do from `ink chat`.
 *   `ports.output.onReply` only observes them; it is not a second sender.
 *
 * Every dependency is turn-scoped and frozen. Nothing here reads or changes
 * process.env or the working directory.
 */

import { STOP_GIVE_UP_MS, STOP_GRACE_MS } from './stop-process.js';
import type {
  ChannelResponse,
  ClaudeRunnerConfig,
  IRunner,
  MediaAttachment,
  RunnerResult,
  RunnerTurnReply,
  ToolCall,
} from './types.js';

/** One provider launch the composition asks for: the shared BackendRunRequest, without its host. */
export type ProviderTurnRequest = { readonly inkSessionId: string } & Readonly<
  Record<string, unknown>
>;

/** What the runner needs from a launch: its settlement, and a way to stop it. */
export interface ProviderTurnHandle {
  readonly result: Promise<{ readonly childExited: boolean }>;
  abort(): void;
}

/**
 * The session's own log: the JSONL SessionLog the CLI keeps, history and
 * backend_session events included, as the composition reads and extends it.
 * It is the one continuity source; there is no second state schema.
 * - `read`: every entry, oldest first, as of the call.
 * - `append`: adds one entry after every earlier one. Appends are applied in
 *   call order and never reordered.
 * - `flush`: resolves once every entry appended before it is durable. The
 *   composition flushes before it reports; the runner never writes the log.
 */
export interface HostedSessionLog<Entry = unknown> {
  read(): Promise<ReadonlyArray<Entry>>;
  append(entry: Entry): Promise<void>;
  flush(): Promise<void>;
}

/** What the composition is told about the turn it runs. */
export interface HostedInkSessionInput {
  /** The ink session, which is also the turn's backendSessionId. */
  readonly sessionId: string;
  /** The admitted generation this turn runs under. */
  readonly turnEpoch: string;
  readonly sbSlug?: string;
  readonly studioId?: string;
  readonly workingDirectory: string;
  readonly message: string;
  readonly attachments: ReadonlyArray<{ readonly path: string; readonly mimeType?: string }>;
  /** The knobs InkRunner passes `ink chat` as flags today. */
  readonly options: Readonly<{
    model?: string;
    effort?: string;
    maxTurns?: number;
    toolRouting: 'backend' | 'local';
    profile: 'safe';
    away: true;
    messageLabel: string;
  }>;
}

/** What the server supplies the composition for one turn. */
export interface HostedInkSessionPorts {
  /** Every Inkwell tool, bootstrap, recall and send_response included, token-scoped to the session. */
  readonly inkwell: {
    callTool(
      name: string,
      args: Record<string, unknown>,
      options: { signal: AbortSignal }
    ): Promise<unknown>;
  };
  /** Each provider launch, through the server host and the runner's accounting. */
  readonly provider: { startTurn(request: ProviderTurnRequest): ProviderTurnHandle };
  readonly sessionLog: HostedSessionLog;
  /** Observes each outer turn's reply; it does not send it. */
  readonly output: { onReply?(reply: RunnerTurnReply): Promise<void> };
  /** Aborts on Stop or drain. */
  readonly signal: AbortSignal;
  /** The run's one deadline, in this process's clock. Nothing the composition does may outlast it. */
  readonly deadlineAt: number;
}

/** What the composition reports. The runner adds launch accounting and maps it onto RunnerResult. */
export interface HostedInkSessionResult {
  success: boolean;
  responses: ChannelResponse[];
  finalTextResponse?: string;
  /** Per-model usage, as InkRunner reports it. */
  usage?: RunnerResult['usage'];
  /** The model that served the conversation, from its own messages. */
  servedModel?: string;
  toolCalls?: ToolCall[];
  error?: string;
  classification?: RunnerResult['classification'];
}

export type ExecuteHostedInkSession = (
  input: HostedInkSessionInput,
  ports: HostedInkSessionPorts
) => Promise<HostedInkSessionResult>;

/** Built once per turn, then frozen. */
export interface HostedInkTurnDependencies {
  readonly inkwell: HostedInkSessionPorts['inkwell'];
  /** The server host: startHostedBackendTurn(hostInput, request). Throws with nothing started when refused. */
  startProviderTurn(request: ProviderTurnRequest): ProviderTurnHandle;
  /** Whether a launch's rejection is the host withholding credentials, so no child started. */
  isHostedRefusal(error: unknown): boolean;
  readonly sessionLog: HostedSessionLog;
  readonly deadlineAt: number;
}

export interface HostedInkRunnerOptions {
  /** The shared composition. Absent until it is bound: every turn is refused. */
  execute?: ExecuteHostedInkSession;
  /** The turn's dependencies. Absent means no turn can run: every turn is refused. */
  forTurn?: (turn: {
    sessionId: string;
    turnEpoch: string;
    config: Readonly<ClaudeRunnerConfig>;
  }) => HostedInkTurnDependencies | Promise<HostedInkTurnDependencies>;
  /**
   * How long, once the turn has returned, an open launch's result is waited
   * for. A stopped child gets its grace and the give-up wait; later is unproven.
   */
  settleMs?: number;
}

export const HOSTED_INK_REFUSALS = {
  noExecutor:
    'this agent is selected for the in-process ink runtime, but no composition is bound to run it; nothing was started',
  unadmitted:
    'a hosted ink turn needs its session and its admitted generation; nothing was started',
  dependencies: 'the hosted ink turn could not be prepared; nothing was started',
  stopped: 'the turn was stopped',
} as const;

const DEFAULT_SETTLE_MS = STOP_GRACE_MS + STOP_GIVE_UP_MS;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A launch the caller's admission refused, before anything started. */
export class HostedLaunchRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'HostedLaunchRefused';
  }
}

/**
 * Every provider launch of one turn, and what is known about it. A launch is
 * accepted once its result resolves, or rejects with anything but a refusal,
 * or is still open when the turn settles: in each case a child may have run.
 */
class ProviderLaunches {
  private readonly open = new Set<ProviderTurnHandle>();
  private readonly results: Promise<void>[] = [];
  private accepted = 0;
  private unconfirmed = 0;
  private refusal: string | undefined;

  constructor(
    private readonly startFn: (request: ProviderTurnRequest) => ProviderTurnHandle,
    private readonly isRefusal: (error: unknown) => boolean,
    private readonly admit: () => string | undefined
  ) {}

  start(request: ProviderTurnRequest): ProviderTurnHandle {
    const refusedNow = this.admit();
    if (refusedNow !== undefined) {
      this.refusal ??= refusedNow;
      throw new HostedLaunchRefused(refusedNow);
    }
    let handle: ProviderTurnHandle;
    try {
      handle = this.startFn(request);
    } catch (error) {
      // The host throws with nothing started and nothing owned.
      this.refusal ??= messageOf(error);
      throw error;
    }
    this.open.add(handle);
    this.results.push(
      handle.result.then(
        (result) => {
          this.open.delete(handle);
          this.accepted += 1;
          if (result.childExited !== true) this.unconfirmed += 1;
        },
        (error: unknown) => {
          this.open.delete(handle);
          if (this.isRefusal(error)) {
            this.refusal ??= messageOf(error);
            return;
          }
          // A rejection says nothing about the child.
          this.accepted += 1;
          this.unconfirmed += 1;
        }
      )
    );
    return handle;
  }

  abortOpen(): void {
    for (const handle of this.open) {
      try {
        handle.abort();
      } catch {
        // Its result still decides whether it exited.
      }
    }
  }

  async settle(ms: number): Promise<{ accepted: number; unconfirmed: number; refusal?: string }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(this.results),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
    if (timer) clearTimeout(timer);
    // Still open: a child may be running, and its exit is unproven.
    return {
      accepted: this.accepted + this.open.size,
      unconfirmed: this.unconfirmed + this.open.size,
      ...(this.refusal !== undefined ? { refusal: this.refusal } : {}),
    };
  }
}

/** The in-process runner, and the agents (by canonical sbId) it is for. */
export interface HostedInkSelection {
  runner: IRunner;
  sbIds: ReadonlySet<string>;
}

/** An `ink` turn's runner: the hosted one for an agent opted in, else `ink chat`. */
export function selectInkRunner(
  hosted: HostedInkSelection | undefined,
  subprocess: IRunner,
  sbId: string | null | undefined
): IRunner {
  return hosted && sbId && hosted.sbIds.has(sbId.toLowerCase()) ? hosted.runner : subprocess;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * INK_RUNTIME_IN_PROCESS_SB_IDS: comma-separated canonical sbIds. Empty or
 * unset selects no one. Anything that is not a UUID throws, so a typo fails
 * the start rather than quietly selecting nobody, or the wrong agent.
 */
export function parseHostedInkSbIds(value: string | undefined): ReadonlySet<string> {
  const ids = (value ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const invalid = ids.filter((id) => !UUID.test(id));
  if (invalid.length > 0) {
    throw new Error(
      `INK_RUNTIME_IN_PROCESS_SB_IDS must list canonical sbIds (UUIDs); ${invalid.length} entr${invalid.length === 1 ? 'y is' : 'ies are'} not`
    );
  }
  return new Set(ids.map((id) => id.toLowerCase()));
}

export class HostedInkSessionRunner implements IRunner {
  constructor(private readonly options: HostedInkRunnerOptions) {}

  async run(
    message: string,
    options: {
      backendSessionId?: string;
      config: ClaudeRunnerConfig;
      mediaAttachments?: MediaAttachment[];
    }
  ): Promise<RunnerResult> {
    const { config } = options;
    const sessionId = config.inkSessionId;
    const refused = (error: string): RunnerResult => ({
      success: false,
      backendSessionId: sessionId ?? null,
      responses: [],
      error,
      refusedBeforeSpawn: true,
    });

    const { execute, forTurn } = this.options;
    if (!execute || !forTurn) return refused(HOSTED_INK_REFUSALS.noExecutor);
    const turnEpoch = config.turnEpoch;
    if (!sessionId || !turnEpoch) return refused(HOSTED_INK_REFUSALS.unadmitted);
    const atEntry = config.admitSpawn?.();
    if (atEntry !== undefined) return refused(atEntry);

    let deps: HostedInkTurnDependencies;
    try {
      deps = Object.freeze(
        await forTurn({ sessionId, turnEpoch, config: Object.freeze({ ...config }) })
      );
    } catch (error) {
      return refused(`${HOSTED_INK_REFUSALS.dependencies}: ${messageOf(error)}`);
    }

    const launches = new ProviderLaunches(
      (request) => deps.startProviderTurn(request),
      (error) => deps.isHostedRefusal(error),
      () => config.admitSpawn?.()
    );
    const stop = new AbortController();
    const onStop = () => stop.abort(config.signal?.reason);
    if (config.signal?.aborted) onStop();
    else config.signal?.addEventListener('abort', onStop, { once: true });
    stop.signal.addEventListener('abort', () => launches.abortOpen(), { once: true });

    const input: HostedInkSessionInput = Object.freeze({
      sessionId,
      turnEpoch,
      ...(config.sbSlug ? { sbSlug: config.sbSlug } : {}),
      ...(config.studioId ? { studioId: config.studioId } : {}),
      workingDirectory: config.workingDirectory,
      message,
      attachments: Object.freeze(
        (options.mediaAttachments ?? [])
          .filter((attachment) => typeof attachment.path === 'string')
          .map((attachment) =>
            Object.freeze({
              path: attachment.path as string,
              ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
            })
          )
      ),
      options: Object.freeze({
        ...(config.model ? { model: config.model } : {}),
        ...(config.effort ? { effort: config.effort } : {}),
        ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
        toolRouting: config.toolRouting ?? 'local',
        profile: 'safe' as const,
        away: true as const,
        messageLabel: config.channel || 'server',
      }),
    });
    const ports: HostedInkSessionPorts = Object.freeze({
      inkwell: deps.inkwell,
      provider: Object.freeze({
        startTurn: (request: ProviderTurnRequest) => launches.start(request),
      }),
      sessionLog: deps.sessionLog,
      output: Object.freeze(config.onTurnReply ? { onReply: config.onTurnReply } : {}),
      signal: stop.signal,
      deadlineAt: deps.deadlineAt,
    });

    let outcome: HostedInkSessionResult | undefined;
    let failure: unknown;
    try {
      outcome = await execute(input, ports);
    } catch (error) {
      failure = error;
    } finally {
      config.signal?.removeEventListener('abort', onStop);
    }
    // Nothing the composition left open outlives its turn.
    launches.abortOpen();
    const settled = await launches.settle(this.options.settleMs ?? DEFAULT_SETTLE_MS);

    if (settled.accepted === 0 && settled.refusal !== undefined) return refused(settled.refusal);
    const unconfirmed = settled.unconfirmed > 0 ? { stopUnconfirmed: { leaderExited: false } } : {};
    const stopped = stop.signal.aborted;

    if (failure !== undefined || !outcome) {
      return {
        success: false,
        backendSessionId: sessionId,
        responses: [],
        error: failure !== undefined ? messageOf(failure) : HOSTED_INK_REFUSALS.stopped,
        ...unconfirmed,
      };
    }
    // As InkRunner: a stopped turn keeps what it reported and is never a
    // success; any other failure reports nothing but its error.
    if (stopped || outcome.success) {
      return {
        success: outcome.success && !stopped,
        backendSessionId: sessionId,
        responses: outcome.responses,
        ...(outcome.usage ? { usage: outcome.usage } : {}),
        ...(outcome.servedModel ? { servedModel: outcome.servedModel } : {}),
        ...(outcome.finalTextResponse !== undefined
          ? { finalTextResponse: outcome.finalTextResponse }
          : {}),
        ...(outcome.toolCalls ? { toolCalls: outcome.toolCalls } : {}),
        ...(stopped ? { error: outcome.error ?? HOSTED_INK_REFUSALS.stopped } : {}),
        ...(outcome.classification ? { classification: outcome.classification } : {}),
        ...unconfirmed,
      };
    }
    return {
      success: false,
      backendSessionId: sessionId,
      responses: [],
      error: outcome.error ?? 'the hosted ink turn failed',
      ...(outcome.classification ? { classification: outcome.classification } : {}),
      ...unconfirmed,
    };
  }
}
