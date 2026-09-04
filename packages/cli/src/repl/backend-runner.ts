import { spawnBackend } from '@inklabs/shared';
import { getBackend } from '../backends/index.js';
import type { BackendTurnEvent } from '../backends/stream.js';
import type { TurnMedia } from '../backends/types.js';
import { statSync } from 'fs';
import { extractBackendTokenUsage, type BackendTokenUsage } from './token-usage.js';

/**
 * Default absolute backstop for a single backend turn. Deliberately generous:
 * the idle/token-flow timeout is the primary reaper (it resets on every output
 * chunk, so an actively-working streamed turn never trips it). This ceiling
 * exists only to reap a truly runaway process, mirroring the outer InkRunner
 * 4-hour PROCESS_TIMEOUT_MS — a working turn should never die on wall-clock.
 */
export const DEFAULT_TURN_HARD_TIMEOUT_MS = 4 * 60 * 60 * 1000;

export interface BackendRunRequest {
  backend: string;
  agentId: string;
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
}

export interface BackendTurnHandle {
  result: Promise<BackendRunResult>;
  abort: () => void;
}

export function startBackendTurn(request: BackendRunRequest): BackendTurnHandle {
  const adapter = getBackend(request.backend);
  const promptParts = request.backend === 'codex' ? ['exec', request.prompt] : [request.prompt];
  const streaming = Boolean(request.stream && adapter.createStreamParser);
  const parser = streaming ? adapter.createStreamParser!() : null;

  const prepared = adapter.prepare({
    agentId: request.agentId,
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
  });

  const command = `${prepared.binary} ${prepared.args.join(' ')}`;

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

  const { child, result } = spawnBackend({
    binary: prepared.binary,
    args: prepared.args,
    env: prepared.env,
    stdinData: prepared.stdinData,
    timeoutMs: request.timeoutMs || DEFAULT_TURN_HARD_TIMEOUT_MS,
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

  return {
    result: result.then((spawnResult) => {
      if (parser) drain(parser.end());
      prepared.cleanup();
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
      };
    }),
    abort: () => {
      try {
        child.kill('SIGTERM');
      } catch {}
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, 3000);
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
export function measurePreparedPromptBytes(request: BackendRunRequest): number {
  const adapter = getBackend(request.backend);
  const promptParts = request.backend === 'codex' ? ['exec', request.prompt] : [request.prompt];
  const prepared = adapter.prepare({
    agentId: request.agentId,
    model: request.model,
    effort: request.effort,
    prompt: request.prompt,
    promptParts,
    passthroughArgs: request.passthroughArgs || [],
    systemPromptOverride: request.systemPromptOverride,
    attachmentDirs: request.attachmentDirs,
    backendSessionId: request.backendSessionId,
    backendSessionSeedId: request.backendSessionSeedId,
    stream: Boolean(request.stream && adapter.createStreamParser),
    toolRouting: request.toolRouting,
    media: request.media,
    deliverMedia: request.deliverMedia,
  });
  try {
    // argv and stdin carry paths for what the adapter wrote to files — an
    // identity/instructions file, attached media — and the backend reads
    // those whole. Their bytes count too (Lumen, PR #576 round 8); media is
    // counted by file size, which overstates image tokens and is therefore
    // the safe direction.
    const fileBytes = [
      ...(prepared.promptFiles ?? []),
      ...(request.media ?? []).map((m) => m.path),
    ].reduce((n, f) => {
      try {
        return n + statSync(f).size;
      } catch {
        return n;
      }
    }, 0);
    return (
      prepared.args.reduce((n, a) => n + Buffer.byteLength(a, 'utf8'), 0) +
      Buffer.byteLength(prepared.stdinData ?? '', 'utf8') +
      fileBytes
    );
  } finally {
    prepared.cleanup();
  }
}

export async function runBackendTurn(request: BackendRunRequest): Promise<BackendRunResult> {
  return startBackendTurn(request).result;
}
