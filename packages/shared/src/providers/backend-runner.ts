import {
  buildCleanEnv,
  LAUNCH_TAG,
  SPAWN_ENV_INHERITED_NAMES,
  spawnBackend,
} from '../runner/spawn-backend.js';
import { extractBackendTokenUsage, type BackendTokenUsage } from '../runtime/token-usage.js';
import { getBackend } from './registry.js';
import { PARENT_OWNED_TURN_ENV } from './turn-owner.js';
import type { BackendTurnEvent } from './stream.js';
import type { BackendHost, BackendSpawnReservation, TurnMedia } from './types.js';

/** Env names that say which session a child serves; only the request's ids set them. */
const ROUTING_ENV_NAMES = ['INK_SESSION_ID', 'INK_STUDIO_ID', 'INK_CONTEXT'] as const;

/** The most an adapter's effective-config check may take (BackendAdapter.checkEffectiveConfig). */
export const EFFECTIVE_CONFIG_CHECK_MS = 10_000;

/** What a spawn refused by its effective-config check reports: EX_CONFIG. */
export const CONFIG_REFUSED_EXIT_CODE = 78;

/**
 * The exit code a turn reports when its host withdrew the spawn
 * (BackendHost.admitSpawn): sysexits' EX_NOPERM. No child was started.
 */
export const SPAWN_NOT_ADMITTED_EXIT_CODE = 77;

/** The refusal when a check rejects instead of answering: it could not vouch for the config. */
export const EFFECTIVE_CONFIG_CHECK_FAILED =
  "the backend's configuration could not be checked before the spawn";

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
   * Explicit hard ceiling only. No default wall-clock kill for a working turn.
   * A host-admitted explicit deadline still bounds its run and credentials.
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
  /** Explicit per-host/request restriction, never process-global in shared. */
  withholdProviderTools?: boolean;
  /**
   * Media files attached to this turn — injecting adapters embed them in
   * the prompt envelope (spec:provider-media-injection).
   */
  media?: TurnMedia[];
  /** True on delivery spawns (initial/reseed); omitted on same-turn continuations. */
  deliverMedia?: boolean;
  /** Tool-captured images selected for this spawn by the host. */
  contextImages?: TurnMedia[];
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
  /** Only images the adapter actually carried, not everything offered. */
  contextImagesDelivered?: TurnMedia[];
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
  const withhold = request.withholdProviderTools === true;
  // Refuse before preparation, credentials or provider lookup. No other
  // adapter here can structurally remove every one of its native tools.
  if (withhold && request.backend !== 'claude') {
    return {
      result: Promise.resolve({
        success: false,
        stdout: '',
        stderr: `Refused: this chat runs with no provider tools, and the ${request.backend} backend can't withhold its own.`,
        exitCode: CONFIG_REFUSED_EXIT_CODE,
        durationMs: 0,
        command: `${request.backend} (refused)`,
        childExited: true,
      }),
      abort: () => undefined,
    };
  }
  const adapter = getBackend(request.backend);
  const host = request.host;
  const promptParts = request.backend === 'codex' ? ['exec', request.prompt] : [request.prompt];
  const streaming = Boolean(request.stream && adapter.createStreamParser);
  const parser = streaming ? adapter.createStreamParser!() : null;
  const requestedCeilingMs =
    request.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : Number.POSITIVE_INFINITY;
  // A spawn ends by the run's deadline, whatever ceiling it asked for: a
  // continuation late in a run gets what is left, never a fresh budget.
  const ceilingMs = (): number =>
    host.deadlineAt === undefined
      ? requestedCeilingMs
      : Math.min(requestedCeilingMs, host.deadlineAt - Date.now());

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
  // the turn ends without spawning; one during the effective-config check
  // also ends the check.
  let stop: ((graceMs?: number) => void) | undefined;
  let abortRequested = false;
  const preSpawn = new AbortController();

  const run = async (): Promise<BackendRunResult> => {
    let reservation: BackendSpawnReservation | undefined;
    // Once spawn is attempted, only its result can establish exit. A thrown
    // spawn or an unknown result must leave the record open for reconciliation.
    let childExited = true;
    const prepared = await adapter.prepare(
      {
        sbSlug: request.sbSlug,
        model: request.model,
        effort: request.effort,
        prompt: request.prompt,
        promptParts,
        passthroughArgs: withhold ? [] : request.passthroughArgs || [],
        systemPromptOverride: request.systemPromptOverride,
        attachmentDirs: request.attachmentDirs,
        backendSessionId: request.backendSessionId,
        backendSessionSeedId: request.backendSessionSeedId,
        stream: streaming,
        toolRouting: withhold ? 'local' : request.toolRouting,
        ...(withhold ? { withholdProviderTools: true } : {}),
        media: request.media,
        deliverMedia: request.deliverMedia,
        contextImages: request.contextImages,
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
      const deadlinePassed = (command: string): BackendRunResult => ({
        success: false,
        stdout: '',
        stderr: "the run's deadline passed before the backend was spawned",
        exitCode: 124,
        durationMs: 0,
        command,
        timedOut: true,
        timeoutType: 'hard',
        childExited: true,
      });
      const abortedBeforeSpawn = (command: string): BackendRunResult => ({
        success: false,
        stdout: '',
        stderr: 'aborted before the backend was spawned',
        exitCode: ABORTED_BEFORE_SPAWN_EXIT_CODE,
        durationMs: 0,
        command,
        timedOut: false,
        childExited: true,
      });
      // The adapter's fixed reason, never the backend's own output.
      const configRefused = (command: string, reason: string): BackendRunResult => ({
        success: false,
        stdout: '',
        stderr: reason,
        exitCode: CONFIG_REFUSED_EXIT_CODE,
        durationMs: 0,
        command,
        timedOut: false,
        childExited: true,
      });
      const notAdmitted = (command: string): BackendRunResult => ({
        success: false,
        stdout: '',
        stderr: 'the host withdrew admission before the backend was spawned',
        exitCode: SPAWN_NOT_ADMITTED_EXIT_CODE,
        durationMs: 0,
        command,
        timedOut: false,
        childExited: true,
      });
      // An abort during preparation ends the turn before anything is minted:
      // a minting host's credential would otherwise outlive the turn.
      if (abortRequested) {
        return abortedBeforeSpawn(`${prepared.binary} ${prepared.args.join(' ')}`);
      }
      const mintedCeilingMs = ceilingMs();
      if (mintedCeilingMs <= 0) {
        return deadlinePassed(`${prepared.binary} ${prepared.args.join(' ')}`);
      }
      const mintedAt = Date.now();
      const credentials: Record<string, string> = {
        ...(await host.sessionEnv({
          hardTimeoutMs: Number.isFinite(mintedCeilingMs) ? mintedCeilingMs : undefined,
        })),
      };
      for (const name of ROUTING_ENV_NAMES) delete credentials[name];
      const parentEnv = await host.baseEnv();
      const binary = await host.resolveBinary(prepared.binary);
      const command = `${binary} ${prepared.args.join(' ')}`;
      // Everything the runner adds for this session on top of the host's base
      // env. The caller owns the logical turn of the session this child
      // serves (turn-owner.ts), and its host hands over that session's
      // credentials; buildCleanEnv inherits none of them on its own.
      const sessionAdditions: Record<string, string> = {
        ...credentials,
        ...prepared.env,
        ...PARENT_OWNED_TURN_ENV,
      };

      if (adapter.checkEffectiveConfig) {
        // A budget the mint and the lookup already spent is a deadline passing,
        // not a configuration refusal (Myra, #701 c41d867e).
        const checkBudgetMs = Math.min(
          EFFECTIVE_CONFIG_CHECK_MS,
          mintedCeilingMs - (Date.now() - mintedAt)
        );
        if (checkBudgetMs <= 0) return deadlinePassed(command);
        // The names come from the very object the spawn gets, before anything
        // is trimmed for the probe: the credentials' names are what a server
        // outside the session must not draw (Myra, #701 5f569213). That
        // includes the adapter's own AGENT_ID and SB_SLUG. The allowlisted
        // names are left out, so a server drawing HOME is not refused.
        const inherited = new Set(SPAWN_ENV_INHERITED_NAMES);
        let refusal: string | undefined;
        try {
          refusal = await adapter.checkEffectiveConfig({
            binary,
            // By allowlist: the probe gets what the spawn inherits from the
            // host (HOME and CODEX_HOME included) and none of the session's
            // additions. So it carries none of the session's credentials and
            // nothing the spawn would not get; a host credential the
            // allowlist passes, an API key, reaches both alike.
            probeEnv: buildCleanEnv(undefined, parentEnv),
            adapterEnv: prepared.env,
            sessionEnvNames: Object.keys(sessionAdditions).filter((name) => !inherited.has(name)),
            cwd: request.workingDirectory,
            signal: preSpawn.signal,
            timeoutMs: checkBudgetMs,
            inkwellMcpUrl: host.inkwellMcpUrl,
            // What the spawn's own arguments change, so the check judges the
            // config the spawn runs with (Lumen, #701 cb80aa4b).
            launchConfig: prepared.launchConfig ?? { args: [] },
          });
        } catch {
          // A check that rejects has not vouched for the config.
          refusal = EFFECTIVE_CONFIG_CHECK_FAILED;
        }
        // An abort wins over any answer the check gave while it was ending.
        if (abortRequested) return abortedBeforeSpawn(command);
        if (refusal !== undefined) return configRefused(command, refusal);
      }

      if (host.admitSpawn && !host.admitSpawn()) return notAdmitted(command);
      if (host.reserveSpawn) {
        reservation = await host.reserveSpawn(request.backend);
        if (!reservation.launchId.trim()) throw new Error('the launch record has no tag');
        // A stale tag in credentials or adapter config cannot select another
        // attempt's row. buildCleanEnv puts this reserved tag first.
        sessionAdditions[LAUNCH_TAG] = reservation.launchId;
      }

      // Measured at the spawn, after the check and reservation: the child's ceiling is never
      // longer than what is left of the credentials it is handed, however
      // long the mint, the lookup and the check took.
      const hardTimeoutMs = Math.min(mintedCeilingMs - (Date.now() - mintedAt), ceilingMs());
      if (hardTimeoutMs <= 0) return deadlinePassed(command);

      // An abort during the mint or the lookup: the credential exists, but
      // no child ever holds it.
      if (abortRequested) return abortedBeforeSpawn(command);

      // The host's last word, with no await between it and the spawn: a run
      // whose admission was lost during the mint or the check (a takeover, a
      // shutdown closing intake) starts no child (Lumen, #701 873209b4).
      if (host.admitSpawn && !host.admitSpawn()) {
        return notAdmitted(command);
      }

      childExited = false;
      const spawned = spawnBackend({
        binary,
        args: prepared.args,
        cwd: request.workingDirectory,
        env: sessionAdditions,
        // What the child inherits comes from the host, never from this process.
        parentEnv,
        stdinData: prepared.stdinData,
        ...(Number.isFinite(hardTimeoutMs) ? { timeoutMs: hardTimeoutMs } : {}),
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
      if (spawned.child.pid !== undefined && reservation) {
        try {
          reservation.spawned({ pid: spawned.child.pid });
        } catch {
          // A bookkeeping callback cannot abandon a live child, or masquerade
          // as a refusal before spawn. Stop and wait for the real result.
          spawned.stop(3000);
          childExited = (await spawned.result).childExited;
          throw new Error('the provider started but its pid could not be recorded');
        }
      }
      const spawnResult = await spawned.result;
      childExited = spawnResult.childExited;

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
        ...(prepared.contextImagesDelivered
          ? { contextImagesDelivered: prepared.contextImagesDelivered }
          : {}),
      };
    } finally {
      if (reservation && childExited) {
        try {
          reservation.exited();
        } catch {
          // Leaving a stale open row is conservative. Do not replace the
          // provider's result with a best-effort record-cleanup failure.
          host.warn('the provider launch exit could not be recorded');
        }
      }
      // After the child has stopped (spawnBackend settles no sooner), or
      // after a failure before it was spawned.
      await prepared.cleanup();
    }
  };

  return {
    result: run(),
    // The timeout's ladder with a shorter grace: an abort is a person or a
    // parent waiting. The close cancels the SIGKILL, and the result, the
    // temp-file cleanup with it, waits for the child to stop.
    abort: () => {
      preSpawn.abort();
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
