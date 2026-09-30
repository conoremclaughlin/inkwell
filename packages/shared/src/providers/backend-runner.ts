import { spawnBackend } from '../runner/spawn-backend.js';
import { extractBackendTokenUsage, type BackendTokenUsage } from '../runtime/token-usage.js';
import { getBackend } from './registry.js';
import { PARENT_OWNED_TURN_ENV } from './turn-owner.js';
import type { BackendTurnEvent } from './stream.js';
import type { BackendHost, TurnMedia } from './types.js';

/**
 * Default absolute backstop for a single backend turn. Deliberately generous:
 * the idle/token-flow timeout is the primary reaper (it resets on every output
 * chunk, so an actively-working streamed turn never trips it). This ceiling
 * exists only to reap a truly runaway process, mirroring the outer InkRunner
 * 4-hour PROCESS_TIMEOUT_MS — a working turn should never die on wall-clock.
 */
export const DEFAULT_TURN_HARD_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/** Env names that say which session a child serves; only the request's ids set them. */
const ROUTING_ENV_NAMES = ['INK_SESSION_ID', 'INK_STUDIO_ID', 'INK_CONTEXT'] as const;

export interface BackendRunRequest {
  backend: string;
  sbSlug: string;
  model?: string;
  /** Reasoning effort for the spawn (claude: low | medium | high | xhigh | max). */
  effort?: string;
  prompt: string;
  verbose?: boolean;
  passthroughArgs?: string[];
  /**
   * Replace the generated identity prompt for this turn. See
   * BackendConfig.systemPromptOverride — awakening is the case it exists for.
   */
  systemPromptOverride?: string;
  /**
   * Hard ceiling (ms). Runaway backstop only — the idle timeout is the primary
   * reaper. Defaults to DEFAULT_TURN_HARD_TIMEOUT_MS (4 h).
   */
  timeoutMs?: number;
  /**
   * Idle/token-flow timeout (ms) — kill the turn only if NO output flows for
   * this long. With a streaming backend this is a true "tokens stopped" signal.
   */
  idleTimeoutMs?: number;
  /**
   * Directories containing turn attachments (--attach-file). Adapters
   * grant the backend read access to these (claude: --add-dir) so it can
   * view attached files natively.
   */
  attachmentDirs?: string[];
  /**
   * Resume an existing backend-native session (claude: --resume). When set,
   * only the delta prompt need be sent — the backend already holds the thread.
   */
  backendSessionId?: string;
  /**
   * Seed a NEW backend-native session with this id on a fresh spawn
   * (claude: --session-id). Pass this on the first spawn of a turn, then pass
   * the same id as `backendSessionId` on subsequent spawns to resume it.
   */
  backendSessionSeedId?: string;
  /**
   * Opt into structured streaming. When the adapter supports it
   * (`createStreamParser`), the turn is spawned in stream mode and each parsed
   * event is delivered to `onEvent` and drives the idle timeout + final-text
   * extraction. Adapters without a parser ignore this and run buffered.
   */
  stream?: boolean;
  /** Live sink for normalized turn events (streaming only). */
  onEvent?: (event: BackendTurnEvent) => void;
  /**
   * Tool routing for this turn — threaded to the adapter so ink-owned
   * ('local') routing withholds tool-bearing MCP servers from the provider.
   */
  toolRouting?: 'backend' | 'local';
  /**
   * Media files attached to this turn — injecting adapters embed them in
   * the prompt envelope (spec:provider-media-injection).
   */
  media?: TurnMedia[];
  /** True on delivery spawns (initial/reseed); omitted on same-turn continuations. */
  deliverMedia?: boolean;
  /**
   * Whether the chat process that owns this turn is attached — an
   * interactive REPL, not `--non-interactive`/`--message`. Required: the
   * spawned backend inherits the parent's INK_SESSION_ID, and its hooks
   * write this value onto that session (see BackendConfig.cliAttached).
   */
  cliAttached: boolean;
  /**
   * Where the child runs, and the directory its adapter reads `.mcp.json`,
   * skills and the channel plugin from. Required, with no default, so no
   * caller inherits a directory by accident: `ink chat` passes its own studio,
   * and a host serving several sessions passes each session's.
   */
  workingDirectory: string;
  /**
   * The session this turn serves, and the only source of the child's routing:
   * INK_CONTEXT, INK_SESSION_ID/INK_STUDIO_ID, and the MCP routing headers. The
   * key is required (the value may be undefined), so every caller decides; an
   * undefined id stays absent and never falls back to the host process's env
   * or to a header the project config carries.
   */
  inkSessionId: string | undefined;
  studioId: string | undefined;
  /**
   * Everything the spawn needs from the process making it (see BackendHost).
   * The child's credentials are `host.sessionEnv()`, asked for once per spawn
   * after preparation: `ink chat`'s host hands over its own session's, and a
   * host serving several sessions mints each spawn's, never its own. Routing
   * names in them (INK_SESSION_ID, INK_STUDIO_ID, INK_CONTEXT) are dropped in
   * favour of the ids above; the adapter's prepared env and the turn-owner
   * marker are applied on top.
   */
  host: BackendHost;
}

export interface BackendRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  command: string;
  usage?: BackendTokenUsage;
  /**
   * Normalized final assistant text, when the turn streamed. Prefer this over
   * `stdout` (which is the raw event stream in streaming mode).
   */
  responseText?: string;
  /** The resumed provider session no longer exists — reseed a fresh one. */
  resumeFailedNoSession?: boolean;
  /** Whether the process was reaped by a timeout, and which kind. */
  timedOut?: boolean;
  timeoutType?: 'idle' | 'hard';
  /**
   * Whether the provider process is known to have stopped. False only when
   * a stop gave up waiting after SIGKILL; see SpawnBackendResult.childExited.
   */
  childExited: boolean;
}

export interface BackendTurnHandle {
  result: Promise<BackendRunResult>;
  abort: () => void;
}

/**
 * What an abort before the spawn reports: the SIGTERM exit an abort gives a
 * spawned child, so a caller sees one shape either way.
 */
const ABORTED_BEFORE_SPAWN_EXIT_CODE = 128 + 15;

export function startBackendTurn(request: BackendRunRequest): BackendTurnHandle {
  const adapter = getBackend(request.backend);
  const host = request.host;
  const promptParts = request.backend === 'codex' ? ['exec', request.prompt] : [request.prompt];
  const streaming = Boolean(request.stream && adapter.createStreamParser);
  const parser = streaming ? adapter.createStreamParser!() : null;
  const hardTimeoutMs = request.timeoutMs || DEFAULT_TURN_HARD_TIMEOUT_MS;

  // Streaming accumulators, populated as events arrive.
  let accumulatedText = '';
  let finalText: string | undefined;
  let streamedUsage: BackendTokenUsage | undefined;
  let resumeFailedNoSession = false;

  const drain = (events: BackendTurnEvent[]): void => {
    for (const e of events) {
      if (e.kind === 'text') {
        accumulatedText += e.text;
      } else if (e.kind === 'result') {
        if (e.text) finalText = e.text;
        if (e.usage) streamedUsage = e.usage;
        if (e.resumeFailedNoSession) resumeFailedNoSession = true;
      }
      request.onEvent?.(e);
    }
  };

  // Set once the child is spawned. An abort before then is remembered, and
  // the turn ends without spawning.
  let stop: ((graceMs?: number) => void) | undefined;
  let abortRequested = false;

  const run = async (): Promise<BackendRunResult> => {
    const prepared = await adapter.prepare(
      {
        sbSlug: request.sbSlug,
        model: request.model,
        effort: request.effort,
        prompt: request.prompt,
        promptParts,
        passthroughArgs: request.passthroughArgs || [],
        systemPromptOverride: request.systemPromptOverride,
        attachmentDirs: request.attachmentDirs,
        backendSessionId: request.backendSessionId,
        backendSessionSeedId: request.backendSessionSeedId,
        stream: streaming,
        toolRouting: request.toolRouting,
        media: request.media,
        deliverMedia: request.deliverMedia,
        cliAttached: request.cliAttached,
        cwd: request.workingDirectory,
        explicitSession: true,
        inkSessionId: request.inkSessionId,
        studioId: request.studioId,
      },
      host
    );
    try {
      // Asked for after preparation, so a credential minted for this spawn
      // starts its life as close to the spawn as it can. The request's ids
      // are the only source of the child's routing: the adapter writes
      // INK_CONTEXT, and INK_SESSION_ID/INK_STUDIO_ID when named, from them,
      // and the same names in the credentials are dropped, so an id the
      // caller left undefined stays absent rather than arriving from
      // wherever the credentials came.
      const credentials: Record<string, string> = { ...(await host.sessionEnv({ hardTimeoutMs })) };
      for (const name of ROUTING_ENV_NAMES) delete credentials[name];
      const binary = await host.resolveBinary(prepared.binary);
      const command = `${binary} ${prepared.args.join(' ')}`;

      if (abortRequested) {
        return {
          success: false,
          stdout: '',
          stderr: 'aborted before the backend was spawned',
          exitCode: ABORTED_BEFORE_SPAWN_EXIT_CODE,
          durationMs: 0,
          command,
          timedOut: false,
          childExited: true,
        };
      }

      const spawned = spawnBackend({
        binary,
        args: prepared.args,
        cwd: request.workingDirectory,
        // The caller owns the logical turn of the session this child serves
        // (turn-owner.ts), and its host hands over that session's
        // credentials; buildCleanEnv inherits none of them on its own.
        env: { ...credentials, ...prepared.env, ...PARENT_OWNED_TURN_ENV },
        stdinData: prepared.stdinData,
        timeoutMs: hardTimeoutMs,
        idleTimeoutMs: request.idleTimeoutMs,
        onStdout:
          streaming || request.verbose
            ? (chunk) => {
                if (request.verbose) process.stdout.write(chunk);
                if (parser) drain(parser.push(chunk));
              }
            : undefined,
        onStderr: request.verbose ? (chunk) => process.stderr.write(chunk) : undefined,
      });
      stop = spawned.stop;
      const spawnResult = await spawned.result;

      if (parser) drain(parser.end());
      // In streaming mode the parsed assistant text is authoritative (stdout is
      // the raw event stream). Fall back to accumulated deltas if no `result`
      // event arrived (e.g. the turn was reaped mid-flight).
      const responseText = streaming ? (finalText ?? accumulatedText) : undefined;
      return {
        success: spawnResult.exitCode === 0,
        stdout: spawnResult.stdout,
        stderr: spawnResult.stderr,
        exitCode: spawnResult.exitCode,
        durationMs: spawnResult.durationMs,
        command,
        usage:
          streamedUsage ??
          extractBackendTokenUsage(request.backend, spawnResult.stdout, spawnResult.stderr),
        ...(responseText !== undefined ? { responseText } : {}),
        ...(resumeFailedNoSession ? { resumeFailedNoSession: true } : {}),
        timedOut: spawnResult.timedOut,
        timeoutType: spawnResult.timeoutType,
        childExited: spawnResult.childExited,
      };
    } finally {
      // After the child has stopped (spawnBackend settles no sooner), or
      // after a failure before it was spawned.
      prepared.cleanup();
    }
  };

  return {
    result: run(),
    // The timeout's ladder with a shorter grace: an abort is a person or a
    // parent waiting. The close cancels the SIGKILL, and the result, the
    // temp-file cleanup with it, waits for the child to stop.
    abort: () => {
      if (stop) stop(3000);
      else abortRequested = true;
    },
  };
}

/**
 * The UTF-8 bytes of exactly what a spawn would hand the backend — every
 * argv element plus stdin — prepared through the adapter and cleaned up
 * without spawning. This is what a stateless parent's next request costs at
 * the byte bound: envelope, system prompt, tool instructions and media alike
 * (Lumen, PR #576 round 7).
 */
export async function runBackendTurn(request: BackendRunRequest): Promise<BackendRunResult> {
  return startBackendTurn(request).result;
}
