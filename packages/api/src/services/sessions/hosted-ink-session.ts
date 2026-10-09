import type { BackendRunResult, SessionProviderPorts } from '@inklabs/shared/providers';
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
 * - The turn has one lifetime, which Stop (`config.signal`), the run's
 *   deadline and the turn's end each close. Closing shuts launch admission
 *   first, then stops every open launch, and the runner waits, bounded, for
 *   each one's actual result. A launch whose result did not arrive, rejected
 *   with anything but a refusal, or reported no child exit, leaves the turn
 *   stopUnconfirmed, and never a success.
 * - Preparation and execution each settle within a finite bound. A
 *   composition still running when a stopped turn's bound runs out is
 *   abandoned, reported unconfirmed, and fenced: when the turn ends, every
 *   port it was handed (launches, Inkwell calls, the log, replies) refuses.
 * - Replies leave by send_response, as they do from `ink chat`.
 *   `ports.output.onReply` only observes them; it is not a second sender.
 *
 * Every dependency is turn-scoped and frozen. Nothing here reads or changes
 * process.env or the working directory.
 */

import { formatInjectedContext } from './context-builder.js';
import { STOP_GIVE_UP_MS, STOP_GRACE_MS } from './stop-process.js';
import { inkSessionOptions, type InkSessionOptions } from './ink-session-options.js';
import type {
  ChannelResponse,
  ClaudeRunnerConfig,
  IRunner,
  MediaAttachment,
  RunnerResult,
  RunnerTurnReply,
  ToolCall,
  InjectedContext,
} from './types.js';

/** One provider launch the composition asks for: the shared BackendRunRequest, without its host. */
export type ProviderTurnRequest = { readonly inkSessionId: string } & Readonly<
  Record<string, unknown>
>;

/** What the runner needs from a launch: its settlement, and a way to stop it. */
export interface ProviderTurnHandle {
  readonly result: Promise<BackendRunResult>;
  abort(): void;
}

/**
 * The session's own log: the JSONL SessionLog the CLI keeps (shared runtime
 * session-log.ts), history and backend_session events included. It is the one
 * continuity source; there is no second state schema.
 * - `append`: SessionLog.append. Assigns the entry's eid and returns it
 *   synchronously, before the entry is durable, so a caller can reference it.
 *   Writes are queued in call order; once one fails, every later append
 *   throws.
 * - `flush`: SessionLog.flush. Resolves once every queued write has landed,
 *   which is not fsync; rejects if any failed.
 * - `read`: this session's entries, oldest first, as the history readers
 *   return them, for continuity (findLastBackendSession and hydration).
 * The composition writes the log; the runner never does.
 */
export interface HostedSessionLog {
  readonly path: string;
  seed(maxEid: number): void;
  append(event: Record<string, unknown>): number;
  flush(): Promise<void>;
  read(): Promise<Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>>;
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
  readonly options: InkSessionOptions;
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
  readonly provider: {
    startTurn(request: ProviderTurnRequest): ProviderTurnHandle;
    /** Explicit host of this admitted run. Missing composition context refuses execution. */
    context?: ReturnType<SessionProviderPorts['spawnContext']>;
  };
  readonly sessionLog: HostedSessionLog;
  /** Observes each outer turn's reply; it does not send it. */
  readonly output: { onReply?(reply: RunnerTurnReply): Promise<void> };
  /** Aborts on Stop, at the run's deadline, and when the turn ends. */
  readonly signal: AbortSignal;
  /** The run's one deadline, in this process's clock; `signal` aborts at it. */
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
  readonly providerContext?: ReturnType<SessionProviderPorts['spawnContext']>;
  /** The run's deadline, in this process's clock: finite, and still ahead. */
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
   * How long a stopped turn's composition, and then each open launch, gets to
   * settle. A stopped child gets its grace and the give-up wait; later is
   * unproven. Finite and positive.
   */
  settleMs?: number;
  /** How long preparing the turn (`forTurn`) may take. Finite and positive. */
  prepareMs?: number;
}

export const HOSTED_INK_REFUSALS = {
  noExecutor:
    'this agent is selected for the in-process ink runtime, but no composition is bound to run it; nothing was started',
  unadmitted:
    'a hosted ink turn needs its session and its admitted generation; nothing was started',
  dependencies: 'the hosted ink turn could not be prepared; nothing was started',
  stopped: 'the turn was stopped',
  deadline: "the run's deadline passed",
  retired: 'the turn has ended; nothing it was handed can act for it now',
  unsettled:
    'the composition had not returned when the stopped turn ran out of time; what it may still be doing is unconfirmed',
  exitUnconfirmed: "a provider launch's exit was not confirmed",
} as const;

const DEFAULT_SETTLE_MS = STOP_GRACE_MS + STOP_GIVE_UP_MS;
const DEFAULT_PREPARE_MS = 30_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function finitePositive(value: number, what: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${what} must be a finite, positive number of milliseconds`);
  }
  return value;
}

/** A launch the caller's admission, or the turn's closed lifetime, refused before anything started. */
export class HostedLaunchRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'HostedLaunchRefused';
  }
}

/** A port used after its turn ended. */
export class HostedTurnRetired extends Error {
  constructor() {
    super(HOSTED_INK_REFUSALS.retired);
    this.name = 'HostedTurnRetired';
  }
}

/**
 * One turn's lifetime, open from admission until the turn ends. Stop, the
 * run's deadline and the turn's end each close it. Closing shuts launch
 * admission (`reason` is set) before anything registered to run on close,
 * which stops the open launches, so nothing can start once a stop has begun.
 * Retiring also fences every port.
 */
class TurnLifetime {
  private readonly controller = new AbortController();
  private readonly onClose: Array<() => void> = [];
  private closeReason: string | undefined;
  private isRetired = false;
  readonly signal = this.controller.signal;

  get closed(): boolean {
    return this.closeReason !== undefined;
  }

  get retired(): boolean {
    return this.isRetired;
  }

  get reason(): string | undefined {
    return this.closeReason;
  }

  whenClosed(fn: () => void): void {
    if (this.closed) fn();
    else this.onClose.push(fn);
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closeReason = reason;
    this.controller.abort(reason);
    for (const fn of this.onClose.splice(0)) {
      try {
        fn();
      } catch {
        // Each one still runs.
      }
    }
  }

  retire(): void {
    this.isRetired = true;
    this.close(HOSTED_INK_REFUSALS.retired);
  }
}

type Settlement<T> =
  | { kind: 'done'; value: T }
  | { kind: 'failed'; error: unknown }
  | { kind: 'abandoned' };

/**
 * Wait for `work` until it settles, or until `maxMs` has passed, or until
 * `afterCloseMs` after the lifetime closes. Abandoning is not settlement: the
 * work may still be running, so the caller treats it as unconfirmed.
 */
function settleWithin<T>(
  work: () => T | Promise<T>,
  lifetime: TurnLifetime,
  bounds: { maxMs?: number; afterCloseMs: number }
): Promise<Settlement<T>> {
  return new Promise((resolve) => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let finished = false;
    const finish = (settlement: Settlement<T>) => {
      if (finished) return;
      finished = true;
      for (const timer of timers) clearTimeout(timer);
      resolve(settlement);
    };
    Promise.resolve()
      .then(work)
      .then(
        (value) => finish({ kind: 'done', value }),
        (error: unknown) => finish({ kind: 'failed', error })
      );
    if (bounds.maxMs !== undefined) {
      timers.push(setTimeout(() => finish({ kind: 'abandoned' }), bounds.maxMs));
    }
    lifetime.whenClosed(() => {
      if (!finished) {
        timers.push(setTimeout(() => finish({ kind: 'abandoned' }), bounds.afterCloseMs));
      }
    });
  });
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
    private readonly admit: () => string | undefined,
    private readonly lifetime: TurnLifetime
  ) {}

  start(request: ProviderTurnRequest): ProviderTurnHandle {
    // A closed turn starts nothing: stopped, past its deadline, or ended.
    const refusedNow = this.lifetime.reason ?? this.admit();
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
  // Only a bound composition can accept the service's authenticated upload grants.
  get uploadMedia(): 'grant' | 'refuse' {
    return this.options.execute && this.options.forTurn ? 'grant' : 'refuse';
  }

  private readonly settleMs: number;
  private readonly prepareMs: number;

  constructor(private readonly options: HostedInkRunnerOptions) {
    this.settleMs = finitePositive(options.settleMs ?? DEFAULT_SETTLE_MS, 'settleMs');
    this.prepareMs = finitePositive(options.prepareMs ?? DEFAULT_PREPARE_MS, 'prepareMs');
  }

  async run(
    message: string,
    options: {
      backendSessionId?: string;
      injectedContext?: InjectedContext;
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
    if (config.signal?.aborted) return refused(HOSTED_INK_REFUSALS.stopped);

    const lifetime = new TurnLifetime();
    const onStop = () => lifetime.close(HOSTED_INK_REFUSALS.stopped);
    config.signal?.addEventListener('abort', onStop, { once: true });
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Preparation starts nothing, so a Stop abandons it at once.
      const prepared = await settleWithin(
        () =>
          forTurn({
            sessionId,
            turnEpoch,
            config: Object.freeze({ ...config, signal: lifetime.signal }),
          }),
        lifetime,
        { maxMs: this.prepareMs, afterCloseMs: 0 }
      );
      if (prepared.kind === 'failed') {
        return refused(`${HOSTED_INK_REFUSALS.dependencies}: ${messageOf(prepared.error)}`);
      }
      if (prepared.kind === 'abandoned') {
        return refused(
          lifetime.reason ??
            `${HOSTED_INK_REFUSALS.dependencies}: not prepared within ${this.prepareMs} ms`
        );
      }
      const deps = Object.freeze(prepared.value);
      if (!Number.isFinite(deps.deadlineAt)) {
        return refused(`${HOSTED_INK_REFUSALS.dependencies}: the run has no finite deadline`);
      }
      const remainingMs = deps.deadlineAt - Date.now();
      if (remainingMs <= 0) return refused(HOSTED_INK_REFUSALS.deadline);
      deadlineTimer = setTimeout(() => lifetime.close(HOSTED_INK_REFUSALS.deadline), remainingMs);

      const launches = new ProviderLaunches(
        (request) => deps.startProviderTurn(request),
        (error) => deps.isHostedRefusal(error),
        () => config.admitSpawn?.(),
        lifetime
      );
      lifetime.whenClosed(() => launches.abortOpen());

      const input: HostedInkSessionInput = Object.freeze({
        sessionId,
        turnEpoch,
        ...(config.sbSlug ? { sbSlug: config.sbSlug } : {}),
        ...(config.studioId ? { studioId: config.studioId } : {}),
        workingDirectory: config.workingDirectory,
        message:
          options.injectedContext && !options.backendSessionId
            ? `${formatInjectedContext(options.injectedContext, { childCallsBootstrap: true })}\n\n---\n\n${message}`
            : message,
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
        options: inkSessionOptions(config),
      });
      // Every port refuses once the turn has ended, so nothing the composition
      // still holds can act for a finished turn.
      const onTurnReply = config.onTurnReply;
      const retiredRejection = () => Promise.reject(new HostedTurnRetired());
      const ports: HostedInkSessionPorts = Object.freeze({
        inkwell: Object.freeze({
          callTool: (name: string, args: Record<string, unknown>, opts: { signal: AbortSignal }) =>
            lifetime.retired ? retiredRejection() : deps.inkwell.callTool(name, args, opts),
        }),
        provider: Object.freeze({
          ...(deps.providerContext ? { context: Object.freeze({ ...deps.providerContext }) } : {}),
          startTurn: (request: ProviderTurnRequest) => launches.start(request),
        }),
        sessionLog: Object.freeze({
          path: deps.sessionLog.path,
          seed: (maxEid: number) => {
            if (lifetime.retired) throw new HostedTurnRetired();
            deps.sessionLog.seed(maxEid);
          },
          append: (event: Record<string, unknown>) => {
            if (lifetime.retired) throw new HostedTurnRetired();
            return deps.sessionLog.append(event);
          },
          flush: () => (lifetime.retired ? retiredRejection() : deps.sessionLog.flush()),
          read: () => (lifetime.retired ? retiredRejection() : deps.sessionLog.read()),
        }),
        output: Object.freeze(
          onTurnReply
            ? {
                onReply: (reply: RunnerTurnReply) =>
                  lifetime.retired ? retiredRejection() : onTurnReply(reply),
              }
            : {}
        ),
        signal: lifetime.signal,
        deadlineAt: deps.deadlineAt,
      });

      // A turn that closed before the composition starts never runs it. A
      // Stop that lands as preparation resolves reads as prepared, because
      // the abandon timer has not fired, and settleWithin starts the work a
      // microtask later still; so the check is made at the start itself.
      const notStarted = Symbol('not started');
      const executed = await settleWithin(
        () => (lifetime.closed ? Promise.reject(notStarted) : execute(input, ports)),
        lifetime,
        { afterCloseMs: this.settleMs }
      );
      if (executed.kind === 'failed' && executed.error === notStarted) {
        return refused(lifetime.reason ?? HOSTED_INK_REFUSALS.stopped);
      }
      // Why the turn stopped before it ended, if it did.
      const stoppedBy = lifetime.reason;
      // The turn ends here, whatever the composition still holds: admission
      // shuts, open launches are stopped, and every port refuses from now on.
      lifetime.retire();
      const settled = await launches.settle(this.settleMs);

      if (
        settled.accepted === 0 &&
        settled.refusal !== undefined &&
        executed.kind !== 'abandoned'
      ) {
        return refused(settled.refusal);
      }
      const exitUnconfirmed = settled.unconfirmed > 0;
      const unconfirmed =
        exitUnconfirmed || executed.kind === 'abandoned'
          ? { stopUnconfirmed: { leaderExited: false } }
          : {};

      if (executed.kind === 'abandoned') {
        return {
          success: false,
          backendSessionId: sessionId,
          responses: [],
          error: `${stoppedBy ?? HOSTED_INK_REFUSALS.stopped}; ${HOSTED_INK_REFUSALS.unsettled}`,
          ...unconfirmed,
        };
      }
      if (executed.kind === 'failed') {
        return {
          success: false,
          backendSessionId: sessionId,
          responses: [],
          error: messageOf(executed.error),
          ...unconfirmed,
        };
      }
      const outcome = executed.value;
      // As InkRunner: a stopped turn keeps what it reported and is never a
      // success; nor is one whose provider exit is unproven. Any other failure
      // reports nothing but its error.
      if (stoppedBy !== undefined || outcome.success) {
        const error =
          stoppedBy !== undefined
            ? (outcome.error ?? stoppedBy)
            : exitUnconfirmed
              ? (outcome.error ?? HOSTED_INK_REFUSALS.exitUnconfirmed)
              : undefined;
        return {
          success: outcome.success && stoppedBy === undefined && !exitUnconfirmed,
          backendSessionId: sessionId,
          responses: outcome.responses,
          ...(outcome.usage ? { usage: outcome.usage } : {}),
          ...(outcome.servedModel ? { servedModel: outcome.servedModel } : {}),
          ...(outcome.finalTextResponse !== undefined
            ? { finalTextResponse: outcome.finalTextResponse }
            : {}),
          ...(outcome.toolCalls ? { toolCalls: outcome.toolCalls } : {}),
          ...(error !== undefined ? { error } : {}),
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
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      config.signal?.removeEventListener('abort', onStop);
      lifetime.retire();
    }
  }
}
