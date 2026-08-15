/**
 * Ink Runner
 *
 * Spawns `ink chat --non-interactive` as a subprocess. The ink runtime
 * manages the full context window, tools, permissions, credential
 * resolution, and skills — Claude Code is the LLM execution backend
 * underneath, just like when a user runs `ink chat` interactively.
 *
 * This follows the same subprocess pattern as ClaudeRunner but points
 * at the `ink` binary instead of `claude`.
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import type {
  InjectedContext,
  ClaudeRunnerConfig,
  RunnerResult,
  ChannelResponse,
  IRunner,
  ToolCall,
  MediaAttachment,
  ModelUsageTotals,
} from './types.js';
import { formatInjectedContext } from './context-builder.js';
import { logger } from '../../utils/logger.js';
import { sessionEventBus } from './session-event-bus.js';
import { resolveBinaryPath, buildSpawnPath } from './resolve-binary.js';
import { injectSessionHeaders, buildSessionEnv, writeRuntimeSessionHint } from '@inklabs/shared';

// Absolute wall-clock backstop for a single ink turn — a final safety net for a
// truly wedged process (dead loop, unkillable I/O), NOT a working limit. It
// can't distinguish a turn that's still legitimately working from a hung one,
// so it sits far above any realistic turn. The primary guard is the inactivity
// timeout below. Override with INK_PROCESS_TIMEOUT_MS.
//
// 4 hours: agents doing real multi-step work on the user's behalf can run a
// long time — the goal is to keep going wherever possible, not to reap eagerly.
export const PROCESS_TIMEOUT_MS =
  parseInt(process.env.INK_PROCESS_TIMEOUT_MS || '', 10) || 4 * 60 * 60 * 1000;

// Continuation-loop turn cap when the SB's dashboard settings don't specify
// one (agent_identities.metadata.runtimeConfig.maxTurns). Deliberately modest:
// signal_status is the sanctioned in-loop halt, so this only bounds runaway
// continuations — and each extra turn is a full provider spawn.
export const DEFAULT_MAX_TURNS = 5;

/** Clamp a dashboard-supplied turn cap to a sane range; default when absent. */
/**
 * Map the ink result line's per-model block. Keys stay exactly as reported —
 * grouping (e.g. by canonicalModel) belongs to the reporting layer, not here.
 *
 * Exported for tests.
 */
export function parseInkModelUsage(raw: unknown): Record<string, ModelUsageTotals> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, ModelUsageTotals> = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    const numeric = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    const fields = {
      inputTokens: numeric(entry.inputTokens),
      outputTokens: numeric(entry.outputTokens),
      cacheReadTokens: numeric(entry.cacheReadTokens),
      cacheWriteTokens: numeric(entry.cacheWriteTokens),
      costUSD: numeric(entry.costUSD),
    };
    // Unreadable entries stay absent rather than becoming zeros — a zero cost
    // reads as measured, and "we don't know" is the honest value.
    if (Object.values(fields).every((v) => v === undefined)) continue;
    out[model] = {
      inputTokens: fields.inputTokens ?? 0,
      outputTokens: fields.outputTokens ?? 0,
      cacheReadTokens: fields.cacheReadTokens ?? 0,
      cacheWriteTokens: fields.cacheWriteTokens ?? 0,
      ...(fields.costUSD !== undefined ? { costUSD: fields.costUSD } : {}),
      // The CLI already knows whether its per-run figure is complete — it saw
      // every invocation. Dropping the marker here silently promoted a lower
      // bound back to a total at the process boundary (Lumen, PR #500 round 4).
      ...(entry.costPartial === true ? { costPartial: true } : {}),
      ...(typeof entry.canonicalModel === 'string' ? { canonicalModel: entry.canonicalModel } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function clampMaxTurns(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_TURNS;
  return Math.min(25, Math.max(1, Math.round(value)));
}

// Inactivity timeout — the primary liveness guard. The countdown resets on any
// stdout/stderr activity from the ink subprocess. A working turn emits a steady
// stream of events (one NDJSON line per tool call, plus status chrome), so it
// never trips no matter how long the whole turn runs — a 350-file download that
// takes 40 minutes keeps resetting the timer. A genuinely hung turn (provider
// stalled, network dead, wedged) goes silent and is reaped here, ~12x faster
// than the absolute backstop.
//
// The window must exceed the longest *legitimate* silent gap. With the ink
// claude adapter now on stream-json, a turn emits events continuously while it
// works, so the old buffered-generation silent gap is gone — the only remaining
// silent gap is away-mode approval polling (requestToolApproval polls silently
// for up to 300s, DEFAULT_TIMEOUT_SECONDS in approval-api.ts).
//
// 1 hour: deliberately generous. A working turn keeps resetting this the whole
// time (a 40-minute download or a long research task never trips it); the window
// only bites a genuinely wedged process, and we'd rather let real work finish
// than reap it early. Clears the 300s approval poll with enormous margin.
// Override with INK_INACTIVITY_TIMEOUT_MS.
export const INACTIVITY_TIMEOUT_MS =
  parseInt(process.env.INK_INACTIVITY_TIMEOUT_MS || '', 10) || 60 * 60 * 1000;

// stderr substrings that mark a model-provider stall (vs. local work) — the same
// family the trigger-retry classifier keys on. Logged when an idle turn is
// reaped so provider stalls are distinguishable from local hangs in the logs.
const PROVIDER_STALL_SIGNATURES = [
  'stream disconnected',
  'error sending request',
  'models refresh timeout',
  'request timed out',
  'econnreset',
  'etimedout',
  'fetch failed',
];

/** Max --attach-file args forwarded per spawn (matches the channel-side media cap) */
const MAX_ATTACHMENT_ARGS = 10;

export class InkRunner implements IRunner {
  async run(
    message: string,
    options: {
      backendSessionId?: string;
      injectedContext?: InjectedContext;
      config: ClaudeRunnerConfig;
      mediaAttachments?: MediaAttachment[];
    }
  ): Promise<RunnerResult> {
    const { backendSessionId, injectedContext, config, mediaAttachments } = options;

    const isResume = !!backendSessionId;
    const sessionId = config.pcpSessionId || backendSessionId || randomUUID();

    let fullMessage = message;
    if (injectedContext && !isResume) {
      const contextBlock = formatInjectedContext(injectedContext);
      fullMessage = `${contextBlock}\n\n---\n\n${message}`;
    }

    const args = this.buildArgs(sessionId, config, mediaAttachments);

    logger.info('Spawning ink chat (non-interactive)', {
      sessionId,
      pcpSessionId: config.pcpSessionId,
      isResume,
      workingDirectory: config.workingDirectory,
      messageLength: fullMessage.length,
    });

    try {
      const result = await this.spawnProcess(args, fullMessage, config);

      if (result.resumeFailedNoSession && isResume) {
        logger.warn('Resume failed - session not found locally. Starting fresh session.', {
          oldSessionId: sessionId,
        });

        if (injectedContext) {
          const contextBlock = formatInjectedContext(injectedContext);
          fullMessage = `${contextBlock}\n\n---\n\n${message}`;
        }

        const freshArgs = this.buildArgs(sessionId, config, mediaAttachments);
        const retryResult = await this.spawnProcess(freshArgs, fullMessage, config);
        return {
          success: true,
          backendSessionId: sessionId,
          responses: retryResult.responses,
          usage: retryResult.usage,
          servedModel: retryResult.servedModel,
          finalTextResponse: retryResult.finalTextResponse,
          toolCalls: retryResult.toolCalls,
        };
      }

      return {
        success: true,
        backendSessionId: sessionId,
        responses: result.responses,
        usage: result.usage,
        servedModel: result.servedModel,
        finalTextResponse: result.finalTextResponse,
        toolCalls: result.toolCalls,
      };
    } catch (error) {
      logger.error('ink chat process failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        backendSessionId: sessionId,
        responses: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private buildArgs(
    sessionId: string,
    config: ClaudeRunnerConfig,
    mediaAttachments?: MediaAttachment[]
  ): string[] {
    const args: string[] = ['chat', '--non-interactive'];

    if (config.agentId) {
      args.push('--agent', config.agentId);
    }

    args.push('--session-id', sessionId);

    if (config.model) {
      args.push('--model', config.model);
    }

    // Turn backstop only — the real limit is the CLI's token budget
    // (200K default), which auto-compacts the transcript when approached.
    // Per-SB tunable from the dashboard (runtimeConfig.maxTurns); the chat
    // loop halts earlier when the model signals completion via signal_status.
    args.push('--max-turns', String(clampMaxTurns(config.maxTurns)));

    // Tool routing is ALWAYS explicit for server spawns — the headless
    // boundary must not depend on worktree .ink/identity.json preferences or
    // the chat loop's own defaults. session-service resolves the SB's
    // dashboard setting (runtimeConfig.toolRouting) and fails closed to
    // 'local' (ink-owned, provider withheld).
    args.push('--tool-routing', config.toolRouting ?? 'local');

    // Use the safe profile with away mode for non-interactive spawns.
    // Safe profile allows read tools freely but requires approval for
    // write/comms tools. Away mode routes approval prompts to the user's
    // inbox (2FA) instead of auto-denying.
    args.push('--profile', 'safe', '--away');

    // Label the delivered message with its originating channel so the
    // transcript renders it as a system message (not "you").
    args.push('--message-label', config.channel || 'server');

    // Forward media attachments as file paths. ink chat appends an
    // attachment block to the turn and grants its provider backend
    // directory access (e.g., --add-dir for claude) so the files can be
    // read natively. Cap defensively — argv space is finite.
    if (mediaAttachments && mediaAttachments.length > 0) {
      for (const attachment of mediaAttachments.slice(0, MAX_ATTACHMENT_ARGS)) {
        if (attachment.path) {
          args.push('--attach-file', attachment.path);
        }
      }
    }

    return args;
  }

  private async spawnProcess(
    args: string[],
    message: string,
    config: ClaudeRunnerConfig
  ): Promise<{
    responses: ChannelResponse[];
    usage?: {
      contextTokens: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      modelUsage?: Record<string, ModelUsageTotals>;
    };
    servedModel?: string;
    resumeFailedNoSession?: boolean;
    finalTextResponse?: string;
    toolCalls: ToolCall[];
  }> {
    const inkBin = await resolveBinaryPath('ink');

    if (config.pcpSessionId && config.workingDirectory) {
      writeRuntimeSessionHint(
        config.workingDirectory,
        config.pcpSessionId,
        config.agentId || 'unknown',
        'ink',
        randomUUID(),
        config.studioId
      );
    }

    const mcpInjection =
      config.mcpConfigPath && config.pcpSessionId
        ? injectSessionHeaders({
            mcpConfigPath: config.mcpConfigPath,
            pcpSessionId: config.pcpSessionId,
            studioId: config.studioId,
            accessToken: config.pcpAccessToken,
          })
        : null;

    // Pass --message via args (not stdin) so ink chat gets it directly
    const fullArgs = [...args, '--message', message];

    const spawnPath = buildSpawnPath(inkBin);
    const sessionEnv = buildSessionEnv({
      pcpSessionId: config.pcpSessionId,
      studioId: config.studioId,
      agentId: config.agentId,
    });

    const env: Record<string, string> = {
      ...process.env,
      ...sessionEnv,
      PATH: spawnPath,
      AGENT_ID: config.agentId || '',
      // Production mode disables React Reconciler profiling (perf_hooks measure accumulation)
      NODE_ENV: 'production',
      // Server-minted access token so the ink CLI's PcpClient can call /mcp
      // (bootstrap, tools) without depending on the human's ~/.ink/auth.json.
      // getValidAccessToken() checks INK_ACCESS_TOKEN before any file source.
      ...(config.pcpAccessToken ? { INK_ACCESS_TOKEN: config.pcpAccessToken } : {}),
    } as Record<string, string>;

    // Strip CLAUDECODE to prevent nested-session detection
    delete env.CLAUDECODE;

    // Turn-scope the observer replay tail: drop anything buffered from a prior
    // turn so an attach mid-turn replays only THIS turn's events, and an attach
    // while idle replays nothing (a finished turn must never re-render as live).
    if (config.pcpSessionId) sessionEventBus.clearReplay(config.pcpSessionId);

    return new Promise((resolve, reject) => {
      const child: ChildProcess = spawn(inkBin, fullArgs, {
        cwd: config.workingDirectory,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let killed = false;
      let idleTimer: NodeJS.Timeout;
      // Carries a partial trailing line between stdout chunks so we only parse
      // complete NDJSON events for live fan-out.
      let stdoutLineBuffer = '';

      // Live fan-out: the worker emits one NDJSON event per line as it works
      // (tool_call, result, status chrome). Parse complete lines as they arrive
      // and republish to the session event bus so attached terminals and the
      // dashboard can watch the turn live — instead of the stream dead-ending
      // here as a mere liveness signal. Best-effort: partial lines and
      // human-readable chrome are ignored; the authoritative RunnerResult is
      // still assembled from the full stdout in parseOutput on close.
      const publishStreamEvents = (text: string): void => {
        if (!config.pcpSessionId) return;
        stdoutLineBuffer += text;
        let nl: number;
        while ((nl = stdoutLineBuffer.indexOf('\n')) >= 0) {
          const line = stdoutLineBuffer.slice(0, nl).trim();
          stdoutLineBuffer = stdoutLineBuffer.slice(nl + 1);
          if (!line) continue;
          let evt: unknown;
          try {
            evt = JSON.parse(line);
          } catch {
            continue; // CLI chrome / status text, not a structured event
          }
          if (
            evt &&
            typeof evt === 'object' &&
            typeof (evt as { type?: unknown }).type === 'string'
          ) {
            const typed = evt as { type: string } & Record<string, unknown>;
            if (typed.type === 'obs' && typed.entry && typeof typed.entry === 'object') {
              // Canonical ledger entry (spec:observer-attach §4.2) — the exact
              // appended transcript object, ledger eid included. Publish on the
              // observer channel, preserving the eid; the bus never mints one.
              sessionEventBus.publishObserverEntry(
                config.pcpSessionId,
                typed.entry as import('./session-event-bus.js').ObserverEntry
              );
            } else if (typed.type === 'session_meta') {
              // The runtime announces its own ledger location at startup —
              // the server-owned locator for durable observer replay.
              if (typeof typed.transcriptPath === 'string') {
                sessionEventBus.registerLedgerPath(config.pcpSessionId, typed.transcriptPath);
              }
            } else {
              sessionEventBus.publish(config.pcpSessionId, typed.type, typed);
            }
          }
        }
      };

      const killProcess = (reason: string, detail?: Record<string, unknown>) => {
        if (killed) return;
        killed = true;
        logger.warn(`ink chat process ${reason}, killing`, {
          sessionId: config.pcpSessionId,
          inactivityMs: INACTIVITY_TIMEOUT_MS,
          absoluteMs: PROCESS_TIMEOUT_MS,
          ...detail,
        });
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000);
      };

      // Inactivity guard — reset on every byte the subprocess emits. A turn
      // that's still working (tool calls, status lines) keeps this alive; a
      // silent, hung one is reaped.
      const resetIdleTimer = () => {
        if (killed) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          const lower = stderr.toLowerCase();
          const stallSignature = PROVIDER_STALL_SIGNATURES.find((s) => lower.includes(s));
          killProcess(`idle for ${Math.round(INACTIVITY_TIMEOUT_MS / 1000)}s`, {
            cause: stallSignature ? 'provider-stall' : 'unknown-hang',
            ...(stallSignature ? { stallSignature } : {}),
            stderrTail: stderr.slice(-500) || undefined,
          });
        }, INACTIVITY_TIMEOUT_MS);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        publishStreamEvents(text);
        resetIdleTimer();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        resetIdleTimer();
      });

      // Absolute backstop — fires regardless of activity, for a process wedged
      // in a way that still emits output (or none at all).
      const absoluteTimer = setTimeout(() => {
        killProcess(`exceeded ${Math.round(PROCESS_TIMEOUT_MS / 1000)}s absolute backstop`);
      }, PROCESS_TIMEOUT_MS);

      // Start the inactivity countdown immediately so a process that never
      // emits anything (wedged at startup) is still reaped.
      resetIdleTimer();

      const clearTimers = () => {
        clearTimeout(idleTimer);
        clearTimeout(absoluteTimer);
      };

      child.on('close', (code) => {
        clearTimers();
        mcpInjection?.cleanup();
        // Turn over: the buffered tail now describes a COMPLETED turn, so drop
        // it. A later idle attach must not replay it as live activity.
        if (config.pcpSessionId) {
          sessionEventBus.clearReplay(config.pcpSessionId);
          // Observer channel: start the retention window; observers detach
          // after it unless a new turn re-registers the session. The durable
          // ledger remains the replay source regardless.
          sessionEventBus.releaseObserverSession(config.pcpSessionId);
        }

        if (code !== 0) {
          // Check for resume failure
          if (stderr.includes('session not found') || stderr.includes('No such session')) {
            resolve({
              responses: [],
              resumeFailedNoSession: true,
              toolCalls: [],
            });
            return;
          }

          const errorText = stderr.trim() || stdout.trim() || `exit code ${code}`;
          reject(new Error(`ink chat exited with code ${code}: ${errorText.slice(0, 1000)}`));
          return;
        }

        const result = this.parseOutput(stdout, stderr);
        resolve(result);
      });

      child.on('error', (err) => {
        clearTimers();
        mcpInjection?.cleanup();
        reject(new Error(`Failed to spawn ink: ${err.message}`));
      });

      // Close stdin — message is passed via --message arg
      child.stdin?.end();
    });
  }

  private parseOutput(
    stdout: string,
    _stderr: string
  ): {
    responses: ChannelResponse[];
    usage?: {
      contextTokens: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      modelUsage?: Record<string, ModelUsageTotals>;
    };
    servedModel?: string;
    finalTextResponse?: string;
    toolCalls: ToolCall[];
  } {
    const responses: ChannelResponse[] = [];
    const toolCalls: ToolCall[] = [];
    let finalTextResponse: string | undefined;
    let exitPhase: string | undefined;
    let exitSignal: string | undefined;
    let exitReason: string | undefined;
    let usage:
      | {
          contextTokens: number;
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
          modelUsage?: Record<string, ModelUsageTotals>;
        }
      | undefined;
    let servedModel: string | undefined;

    // ink chat routes responses via MCP send_response — stdout may contain
    // CLI chrome, status lines, or other noise that must NOT be treated as
    // routeable content. Only parse structured JSON lines:
    //   - type: "send_response" → explicit channel routing
    //   - type: "tool_call"     → tool invocation tracking
    //   - type: "result"        → assistant's final text (emitted by --non-interactive)
    const lines = stdout.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'send_response') {
          responses.push({
            channel: parsed.channel || 'api',
            conversationId: parsed.conversationId || '',
            content: parsed.content || '',
            format: parsed.format,
          });
        } else if (parsed.type === 'tool_call') {
          toolCalls.push({
            toolUseId: parsed.toolUseId || parsed.id || '',
            toolName: parsed.toolName || parsed.name || '',
            input: parsed.input || {},
          });
        } else if (parsed.type === 'result') {
          if (parsed.text) finalTextResponse = parsed.text;
          if (parsed.phase) exitPhase = parsed.phase;
          if (parsed.signal) exitSignal = parsed.signal;
          if (parsed.reason) exitReason = parsed.reason;
          // Usage from the ink CLI's budget view (transcript + identity).
          // Without this, sessions report contextTokens=0 and token-based
          // lifecycle decisions never fire for the ink backend.
          if (parsed.usage && typeof parsed.usage === 'object') {
            // The CLI reports fresh input and the cache split separately;
            // input is their sum, since cached tokens are still input that
            // was sent and billed. Older ink builds omit the cache fields —
            // those degrade to the previous fresh-only figure rather than
            // failing.
            const cacheReadTokens = Number(parsed.usage.cacheReadTokens) || 0;
            const cacheWriteTokens = Number(parsed.usage.cacheWriteTokens) || 0;
            // Per-model breakdown with the backend's own costUSD. Older ink
            // builds omit it; the field is simply absent then, never faked.
            const modelUsage = parseInkModelUsage(parsed.modelUsage);
            usage = {
              contextTokens: Number(parsed.usage.contextTokens) || 0,
              inputTokens:
                (Number(parsed.usage.inputTokens) || 0) + cacheReadTokens + cacheWriteTokens,
              outputTokens: Number(parsed.usage.outputTokens) || 0,
              cacheReadTokens,
              cacheWriteTokens,
              ...(modelUsage ? { modelUsage } : {}),
            };
          }
          if (typeof parsed.model === 'string' && parsed.model.trim()) {
            servedModel = parsed.model.trim();
          }
        }
      } catch {
        // Non-JSON line — CLI noise, ignore
      }
    }

    if (exitPhase || exitSignal) {
      logger.info('ink chat non-interactive exit', {
        exitPhase,
        exitSignal,
        exitReason,
        hasResponse: !!finalTextResponse,
        responseCount: responses.length,
        toolCallCount: toolCalls.length,
        contextTokens: usage?.contextTokens,
      });
    }

    return {
      responses,
      usage,
      servedModel,
      finalTextResponse,
      toolCalls,
    };
  }
}
