/**
 * Claude Runner
 *
 * Spawns and manages Claude Code processes.
 * Handles message processing and response parsing.
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import type {
  InjectedContext,
  ClaudeRunnerConfig,
  RunnerResult,
  ChannelResponse,
  ChannelType,
  IRunner,
  ToolCall,
} from './types.js';
import { formatInjectedContext } from './context-builder.js';
import { logger } from '../../utils/logger.js';
import { resolveBinaryPath, buildSpawnPath } from './resolve-binary.js';
import {
  injectSessionHeaders,
  buildSessionEnv,
  writeRuntimeSessionHint,
  resolveSpawnTarget,
  CONTAINER_RUNNER_FILES,
} from '@inklabs/shared';
import { homedir } from 'os';
import { join } from 'path';
import { inkStudiosRoot, ensureInkStudiosRoot } from '../studio-paths.js';
import { ensureStudioSettings, applyPermissionOverlay } from '../studio-settings.js';

/** Maximum time (ms) to wait for a Claude Code subprocess before killing it.
 *  Override with CLAUDE_PROCESS_TIMEOUT_MS env var. */
const PROCESS_TIMEOUT_MS =
  parseInt(process.env.CLAUDE_PROCESS_TIMEOUT_MS || '', 10) || 30 * 60 * 1000; // 30 minutes

/**
 * Parse usage stats from Claude Code stream output.
 */
interface ClaudeUsageStats {
  /** Live context occupancy, measured per-step — omitted when unmeasured. */
  contextTokens?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Per-model breakdown as reported by Claude, keyed exactly as reported. */
  modelUsage?: Record<string, ModelUsageEntry>;
}

/** One model's contribution to a query, from `result.modelUsage`. */
export interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Claude's own cost figure for this model's share of the query. */
  costUSD: number;
  canonicalModel?: string;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Total prompt size for one API call: fresh + cached-read + cache-write.
 *
 * Claude names its cache fields `cache_read_input_tokens` and
 * `cache_creation_input_tokens`. `cache_read_tokens` / `cache_write_tokens`
 * do not exist on this path, so earlier reads yielded undefined every turn —
 * and because `input_tokens` carries only the NON-cached remainder while
 * Claude Code caches aggressively, recorded input collapsed to a few hundred
 * tokens against hundreds of thousands of output.
 */
function promptTokens(usage: Record<string, unknown>): number {
  return (
    num(usage.input_tokens) +
    num(usage.cache_read_input_tokens) +
    num(usage.cache_creation_input_tokens)
  );
}

/**
 * Map a `result.usage` object to BILLING totals for one `claude -p` query.
 *
 * `result.usage` aggregates every model step in the query — it carries an
 * `iterations[]` array, one entry per step — so it answers "what did this
 * query cost", NOT "how full is the context window". A 20-step run re-reads
 * the cached prompt each step, so its billed input is a multiple of the live
 * context. Context is tracked separately from per-step assistant messages;
 * conflating them made multi-step runs trip the compaction threshold early
 * (Lumen, PR #493 round 2).
 *
 * `contextTokens` is deliberately absent here — the caller supplies the
 * measured value, and omitting it means "unknown", never zero.
 *
 * Exported for tests.
 */
export function parseClaudeUsage(usage: Record<string, unknown>): Omit<
  ClaudeUsageStats,
  'contextTokens'
> & {
  contextTokens?: number;
} {
  return {
    inputTokens: promptTokens(usage),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheWriteTokens: num(usage.cache_creation_input_tokens),
  };
}

/**
 * Live context size from a top-level `assistant` message's usage.
 *
 * Each assistant message reports the prompt for that single API call, so the
 * most recent one is the current context window occupancy — the figure
 * compaction decisions need. Messages emitted by subagents carry
 * `parent_tool_use_id` and describe a different context, so they are skipped.
 *
 * Returns undefined when the event carries no usable usage.
 *
 * Exported for tests.
 */
export function parseAssistantContextTokens(event: Record<string, unknown>): number | undefined {
  if (event.parent_tool_use_id) return undefined;
  const message = event.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;
  if (!usage) return undefined;
  const total = promptTokens(usage);
  return total > 0 ? total : undefined;
}

/**
 * Per-model usage from `result.modelUsage` — the authoritative record of
 * which models actually served the query, including subagents, aliases and
 * fallbacks, with Claude's own cost figure.
 *
 * Entries are kept under the keys Claude reports and are never summed across
 * keys: the same query can list both a dated id and its alias, and whether
 * those are one model or two is not decidable here. Preserving the reported
 * shape lets the reporting layer group by `canonicalModel` without this layer
 * inventing a total (Lumen, PR #493 round 2).
 *
 * Exported for tests.
 */
export function parseModelUsage(modelUsage: unknown): Record<string, ModelUsageEntry> | undefined {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined;
  const out: Record<string, ModelUsageEntry> = {};
  for (const [model, raw] of Object.entries(modelUsage as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    out[model] = {
      inputTokens: num(entry.inputTokens),
      outputTokens: num(entry.outputTokens),
      cacheReadTokens: num(entry.cacheReadInputTokens),
      cacheWriteTokens: num(entry.cacheCreationInputTokens),
      costUSD: num(entry.costUSD),
      ...(typeof entry.canonicalModel === 'string' ? { canonicalModel: entry.canonicalModel } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The model serving the main conversation, read off a top-level `assistant`
 * message rather than inferred.
 *
 * Output volume cannot identify the parent: a chatty subagent or side model
 * routinely out-writes it, and picking the largest entry would then record the
 * wrong model on the session (Lumen, PR #493 round 3). Claude states the
 * answer on every assistant event, and top-level events are exactly the ones
 * without `parent_tool_use_id`.
 *
 * Exported for tests.
 */
export function parseAssistantModel(event: Record<string, unknown>): string | undefined {
  if (event.parent_tool_use_id) return undefined;
  const message = event.message as Record<string, unknown> | undefined;
  const model = message?.model;
  return typeof model === 'string' && model.trim() ? model : undefined;
}

/**
 * Prefer the stable alias when the backend also reports one for this model —
 * a dated id like `claude-haiku-4-5-20251001` and its alias `claude-haiku-4-5`
 * describe the same model, and grouping usage by a rotating date is useless.
 *
 * Exported for tests.
 */
export function canonicalizeModel(
  model: string | undefined,
  modelUsage: Record<string, ModelUsageEntry> | undefined
): string | undefined {
  if (!model) return undefined;
  return modelUsage?.[model]?.canonicalModel || model;
}

/**
 * Newline-delimited reader over a stream that arrives in arbitrary slices.
 *
 * stdout chunk boundaries have nothing to do with line boundaries, so a JSON
 * event can straddle two chunks. Splitting each chunk on its own left both
 * halves unparseable and the surrounding try/catch swallowed them silently.
 * The result line is the longest event and therefore the likeliest to split,
 * so the entire turn's usage and model attribution could vanish with no error
 * (Lumen, PR #493 round 2).
 *
 * `flush` exists because the final line often has no trailing newline.
 *
 * Exported for tests.
 */
export function createLineReader(onLine: (line: string) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buffer = '';
  return {
    push(chunk: string) {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) onLine(line);
      }
    },
    flush() {
      const remainder = buffer;
      buffer = '';
      if (remainder.trim()) onLine(remainder);
    },
  };
}

export class ClaudeRunner implements IRunner {
  async run(
    message: string,
    options: {
      backendSessionId?: string;
      injectedContext?: InjectedContext;
      config: ClaudeRunnerConfig;
    }
  ): Promise<RunnerResult> {
    const { backendSessionId, injectedContext, config } = options;

    // Determine if resuming or starting new session
    const isResume = !!backendSessionId;
    let sessionId = backendSessionId || randomUUID();

    // Build the message with injected context
    let fullMessage = message;
    let runConfig = config;
    if (injectedContext && !isResume) {
      // Only inject full context on first message (not resume)
      const contextBlock = formatInjectedContext(injectedContext);
      fullMessage = `${contextBlock}\n\n---\n\n${message}`;
      runConfig = { ...config, constitutionInjected: true };
    }

    // The grant below requires the directory to exist; async so the server's
    // event loop is never blocked (PR #544 r1 P2 — buildArgs ran mkdirSync
    // per turn/retry).
    await ensureInkStudiosRoot();

    // Build Claude Code arguments
    let args = this.buildArgs(sessionId, isResume, config);

    logger.info('Spawning Claude Code', {
      sessionId,
      isResume,
      workingDirectory: config.workingDirectory,
      messageLength: fullMessage.length,
    });

    try {
      const result = await this.spawnProcess(args, fullMessage, runConfig);

      // Check if resume failed because session doesn't exist
      if (result.resumeFailedNoSession && isResume) {
        logger.warn('Resume failed - session not found locally. Starting fresh session.', {
          oldSessionId: sessionId,
        });

        // Generate a new session ID and retry without resume
        sessionId = randomUUID();
        args = this.buildArgs(sessionId, false, config);

        // Rebuild message with full context for new session
        if (injectedContext) {
          const contextBlock = formatInjectedContext(injectedContext);
          fullMessage = `${contextBlock}\n\n---\n\n${message}`;
          runConfig = { ...config, constitutionInjected: true };
        }

        logger.info('Retrying with fresh session', { sessionId });
        const retryResult = await this.spawnProcess(args, fullMessage, runConfig);

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
      logger.error('Claude Code process failed', {
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

  private buildArgs(sessionId: string, isResume: boolean, config: ClaudeRunnerConfig): string[] {
    const args: string[] = ['--print', '--output-format', 'stream-json', '--verbose'];

    // Session handling
    if (isResume) {
      args.push('--resume', sessionId);
    } else {
      args.push('--session-id', sessionId);
    }

    // Model
    if (config.model) {
      args.push('--model', config.model);
    }

    // MCP config — use --strict-mcp-config so the injected temp file
    // (with auth headers) takes exclusive precedence over the workspace
    // .mcp.json (which has no auth). Without this, Claude Code merges
    // both configs and the workspace version wins for duplicate servers.
    if (config.mcpConfigPath) {
      args.push('--strict-mcp-config', '--mcp-config', config.mcpConfigPath);
    }

    // System prompt override (survives compaction)
    if (config.appendSystemPrompt) {
      args.push('--append-system-prompt', config.appendSystemPrompt);
    }

    // Allow access to ~/.ink/files (Telegram/Discord/Slack media downloads, Gmail attachments)
    const inkFilesDir = join(homedir(), '.ink', 'files');
    args.push('--add-dir', inkFilesDir);

    // Allow access to the ephemeral-studio root (spec:studio-materialization
    // v8): granting it at spawn is the whole point of a static root — a live
    // session can never be granted a new directory, so every future
    // create_studio/overflow worktree must land somewhere already in scope.
    // run() ensures the directory exists (async) before args are built.
    args.push('--add-dir', inkStudiosRoot());

    return args;
  }

  private async spawnProcess(
    args: string[],
    message: string,
    config: ClaudeRunnerConfig
  ): Promise<{
    responses: ChannelResponse[];
    usage?: ClaudeUsageStats;
    servedModel?: string;
    resumeFailedNoSession?: boolean;
    finalTextResponse?: string;
    toolCalls: ToolCall[];
  }> {
    const claudeBin = await resolveBinaryPath('claude');

    // Write runtime hint files before spawning so the on-session-start hook
    // picks up the correct PCP session ID (not the last sb-launched session).
    const runtimeLinkId = randomUUID();
    if (config.pcpSessionId && config.workingDirectory) {
      writeRuntimeSessionHint(
        config.workingDirectory,
        config.pcpSessionId,
        config.agentId || 'unknown',
        'claude',
        runtimeLinkId,
        config.studioId
      );
    }

    // Inject PCP session headers into MCP config so the spawned agent's
    // MCP calls carry session identity back to the PCP server.
    const mcpInjection =
      config.mcpConfigPath && config.pcpSessionId
        ? injectSessionHeaders({
            mcpConfigPath: config.mcpConfigPath,
            pcpSessionId: config.pcpSessionId,
            studioId: config.studioId,
            accessToken: config.pcpAccessToken,
            outputDir: config.container?.runtimeDir,
          })
        : null;

    // Safety net: ensure .claude/settings.local.json exists before spawning.
    // Non-fatal — if it fails, Claude still spawns with default permissions.
    if (config.workingDirectory) {
      try {
        await ensureStudioSettings(config.workingDirectory);
      } catch (err) {
        logger.debug('ensureStudioSettings pre-spawn check failed (non-fatal)', {
          cwd: config.workingDirectory,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Apply per-session permission overlay (from strategy config or 2FA grant).
    // The restore function is called after the process exits to revert the overlay.
    let restoreOverlay: (() => Promise<void>) | null = null;
    if (config.workingDirectory && config.permissionOverlay) {
      try {
        restoreOverlay = await applyPermissionOverlay(
          config.workingDirectory,
          config.permissionOverlay
        );
      } catch (err) {
        logger.warn('Failed to apply permission overlay (non-fatal)', {
          cwd: config.workingDirectory,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // If headers were injected, patch the --mcp-config arg to point to the temp file.
    // When containerized, translate host path to the container-side mount point.
    if (mcpInjection?.modified) {
      const mcpIdx = args.indexOf('--mcp-config');
      if (mcpIdx !== -1 && args[mcpIdx + 1]) {
        if (config.container?.runtimeDir) {
          const filename = mcpInjection.mcpConfigPath.split('/').pop()!;
          args[mcpIdx + 1] = `${CONTAINER_RUNNER_FILES}/${filename}`;
        } else {
          args[mcpIdx + 1] = mcpInjection.mcpConfigPath;
        }
      }
    }

    return new Promise((resolve, reject) => {
      // Strip CLAUDECODE to prevent "nested session" detection when PCP is
      // launched from inside a Claude Code session (e.g., via PM2).
      const { CLAUDECODE, ...cleanEnv } = process.env;
      const spawnEnv: Record<string, string> = {
        // Ensure Claude Code uses correct paths
        HOME: process.env.HOME || '',
        PATH: buildSpawnPath(claudeBin),
        // Agent identity — hooks resolve identity from $AGENT_ID.
        ...(config.agentId ? { AGENT_ID: config.agentId } : {}),
        // Tells the session-start hook the constitution is already in the
        // prompt, so it does not inject a second copy.
        ...(config.constitutionInjected ? { INK_CONSTITUTION_INJECTED: '1' } : {}),
        // Session env vars
        ...buildSessionEnv({
          pcpSessionId: config.pcpSessionId,
          runtimeLinkId: config.pcpSessionId ? runtimeLinkId : undefined,
          studioId: config.studioId,
          accessToken: config.pcpAccessToken,
          agentId: config.agentId,
          runtime: 'claude',
          repoRoot: config.repoRoot,
        }),
      };

      // Route through container or host — resolveSpawnTarget handles the
      // docker exec wrapping transparently.
      const target = resolveSpawnTarget({
        binary: claudeBin,
        args,
        cwd: config.workingDirectory,
        env: spawnEnv,
        pipeStdin: true,
        container: config.container,
      });

      const proc = spawn(target.binary, target.args, {
        cwd: target.cwd,
        env: config.container ? target.env : { ...cleanEnv, ...spawnEnv },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';
      const responses: ChannelResponse[] = [];
      const toolCalls: ToolCall[] = [];
      let usage: ClaudeUsageStats | undefined;
      let servedModel: string | undefined;
      let measuredContextTokens: number | undefined;
      let reportedModel: string | undefined;
      let resumeFailedNoSession = false;
      let finalTextResponse: string | undefined;
      let settled = false;
      let lastActivityAt = Date.now();

      // Activity-based timeout: reset every time we get output from the process.
      // This distinguishes "Claude is working and streaming output" from "Claude is stuck."
      const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min with no output = stuck
      let idleTimer: NodeJS.Timeout;

      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (!settled) {
            const idleSecs = Math.round((Date.now() - lastActivityAt) / 1000);
            logger.error('Claude Code process idle too long, killing', {
              idleSeconds: idleSecs,
              hasResponses: responses.length > 0,
              hasFinalText: !!finalTextResponse,
            });
            this.killProcess(proc);
            settled = true;
            resolve({
              responses,
              usage,
              toolCalls,
              finalTextResponse: finalTextResponse || `[Process timed out after ${idleSecs}s idle]`,
            });
          }
        }, IDLE_TIMEOUT_MS);
      };
      resetIdleTimer();

      // Hard ceiling: no process should run longer than this regardless of activity
      const timeout = setTimeout(() => {
        if (!settled) {
          logger.error('Claude Code process hit hard timeout, killing', {
            timeoutMs: PROCESS_TIMEOUT_MS,
            hasResponses: responses.length > 0,
            hasFinalText: !!finalTextResponse,
          });
          this.killProcess(proc);
          settled = true;
          resolve({
            responses,
            usage,
            toolCalls,
            finalTextResponse: finalTextResponse || '[Process hit hard timeout]',
          });
        }
      }, PROCESS_TIMEOUT_MS);

      const consumeLine = (line: string) => {
        {
          try {
            const parsed = JSON.parse(line);
            this.handleStreamEvent(parsed, responses);
            this.captureToolCall(parsed, toolCalls);

            // Check for resume failure due to missing session
            if (parsed.type === 'result' && parsed.subtype === 'error_during_execution') {
              const errors = parsed.errors as string[] | undefined;
              if (
                errors?.some((e: string) => e.includes('No conversation found with session ID'))
              ) {
                resumeFailedNoSession = true;
              }
            }

            // Extract usage stats and final text response from result.
            if (parsed.type === 'result') {
              if (parsed.usage) {
                const billed = parseClaudeUsage(parsed.usage as Record<string, unknown>);
                const modelUsage = parseModelUsage(parsed.modelUsage);
                servedModel = canonicalizeModel(reportedModel, modelUsage);
                usage = {
                  ...billed,
                  // Measured per-step, never taken from the query aggregate.
                  ...(measuredContextTokens !== undefined
                    ? { contextTokens: measuredContextTokens }
                    : {}),
                  ...(modelUsage ? { modelUsage } : {}),
                };
              }
              // Capture the final text response from the result
              if (parsed.result && typeof parsed.result === 'string') {
                finalTextResponse = parsed.result;
              }
            }

            // Live context occupancy: the newest top-level assistant message
            // reports the prompt for that one API call, which is what the
            // compaction threshold is about.
            if (parsed.type === 'assistant') {
              const stepContext = parseAssistantContextTokens(parsed as Record<string, unknown>);
              if (stepContext !== undefined) measuredContextTokens = stepContext;
              const stepModel = parseAssistantModel(parsed as Record<string, unknown>);
              if (stepModel) reportedModel = stepModel;
            }

            // Also capture text from assistant messages (streaming)
            if (parsed.type === 'assistant' && parsed.message?.content) {
              const content = parsed.message.content as Array<{ type: string; text?: string }>;
              const textContent = content
                .filter((c: { type: string }) => c.type === 'text')
                .map((c: { text?: string }) => c.text || '')
                .join('');
              if (textContent) {
                finalTextResponse = textContent;
              }
            }
          } catch {
            // Not JSON, likely plain text
          }
        }
      };

      // Only the unterminated remainder is held, never the whole stream.
      const stdoutReader = createLineReader(consumeLine);

      proc.stdout.on('data', (data) => {
        lastActivityAt = Date.now();
        resetIdleTimer();
        stdoutReader.push(data.toString());
      });

      proc.stderr.on('data', (data) => {
        lastActivityAt = Date.now();
        resetIdleTimer();
        stderr += data.toString();
      });

      proc.on('error', (error) => {
        clearTimeout(timeout);
        clearTimeout(idleTimer);
        restoreOverlay?.().catch(() => {});
        if (!settled) {
          settled = true;
          reject(new Error(`Failed to spawn Claude: ${error.message}`));
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        clearTimeout(idleTimer);
        mcpInjection?.cleanup();
        restoreOverlay?.().catch(() => {});
        if (settled) return; // Already resolved by timeout
        settled = true;
        // Before resolving: the stream's last line may have arrived without a
        // trailing newline, and it is usually the result line.
        stdoutReader.flush();

        // Handle resume failure gracefully - don't reject, let caller retry
        if (resumeFailedNoSession) {
          resolve({
            responses,
            usage,
            servedModel,
            toolCalls,
            resumeFailedNoSession: true,
            finalTextResponse,
          });
          return;
        }

        if (code !== 0) {
          logger.warn('Claude Code exited with non-zero code', { code, stderr });
          // Don't reject on non-zero exit if we got responses or text
          if (responses.length === 0 && !finalTextResponse) {
            reject(new Error(`Claude exited with code ${code}: ${stderr}`));
            return;
          }
        }

        resolve({ responses, usage, servedModel, toolCalls, finalTextResponse });
      });

      // Send the message
      proc.stdin.write(message);
      proc.stdin.end();
    });
  }

  /**
   * Kill a Claude Code subprocess gracefully, with escalation to SIGKILL.
   */
  private killProcess(proc: ChildProcess): void {
    try {
      proc.kill('SIGTERM');
      // If it doesn't die in 5s, force kill
      setTimeout(() => {
        try {
          if (!proc.killed) {
            proc.kill('SIGKILL');
          }
        } catch {
          // Process already dead
        }
      }, 5000);
    } catch {
      // Process already dead
    }
  }

  /**
   * Capture tool_use events for activity stream logging.
   */
  private captureToolCall(event: Record<string, unknown>, toolCalls: ToolCall[]): void {
    if (event.type === 'tool_use') {
      toolCalls.push({
        toolUseId: (event.id as string) || '',
        toolName: (event.name as string) || '',
        input: (event.input as Record<string, unknown>) || {},
      });
    }
  }

  /**
   * Handle a streaming JSON event from Claude Code.
   */
  private handleStreamEvent(event: Record<string, unknown>, responses: ChannelResponse[]): void {
    // Look for tool calls, specifically send_response
    if (event.type === 'tool_use') {
      const toolName = event.name as string;
      const input = event.input as Record<string, unknown>;

      if (toolName === 'mcp__inkwell__send_response') {
        const channel = (input.channel as ChannelType) || 'telegram';
        const response: ChannelResponse = {
          channel,
          conversationId: (input.conversationId as string) || '',
          content: (input.content as string) || '',
          format: input.format as 'text' | 'markdown' | 'code' | 'json' | undefined,
          replyToMessageId: input.replyToMessageId as string | undefined,
          metadata: input.metadata as Record<string, unknown> | undefined,
          media: input.media as ChannelResponse['media'],
        };
        responses.push(response);
        logger.debug('Captured send_response call', { response });
      }
    }

    // Also check for assistant text responses (fallback if no tool call)
    if (event.type === 'text' && event.text) {
      // We could capture this as a default response
      // but for now, we only route explicit send_response calls
    }
  }
}

/**
 * Build an identity prompt for append-system-prompt.
 * This survives context compaction.
 */
export function buildIdentityPrompt(
  agentId: string,
  agentName: string,
  soul?: string,
  timezone?: string,
  heartbeat?: string,
  sessionIds?: { pcpSessionId?: string; studioId?: string; threadKey?: string }
): string {
  let prompt = `## Identity Override (CRITICAL)

**You are ${agentName}. Your agent ID is \`${agentId}\`.**

When calling PCP tools (bootstrap, remember, recall, start_session, etc.), use \`agentId: "${agentId}"\`.

Do NOT read \`.ink/identity.json\` — your identity is set by this system prompt.
Do NOT run \`echo $AGENT_ID\` — you are running headlessly without shell access.`;

  // Session identity — always in context for debugging and routing verification
  if (sessionIds?.pcpSessionId) {
    const idParts = [`- PCP Session: \`${sessionIds.pcpSessionId}\``];
    if (sessionIds.studioId) idParts.push(`- Studio: \`${sessionIds.studioId}\``);
    if (sessionIds.threadKey) idParts.push(`- Thread: \`${sessionIds.threadKey}\``);
    prompt += `\n\n### Session Identity\n${idParts.join('\n')}`;
  }

  if (soul) {
    prompt += `\n\n### Soul\n${soul}`;
  }

  if (heartbeat) {
    prompt += `\n\n### Heartbeat Instructions\nFollow these instructions on every heartbeat wake-up. If this document is not immediately available, fetch it via \`get_identity(agentId: "${agentId}", file: "heartbeat")\`.\n\n${heartbeat}`;
  }

  // Add timezone handling guidance if timezone is provided
  if (timezone) {
    prompt += `

## Timezone Handling (CRITICAL)

**User's timezone: ${timezone}**

ALWAYS convert UTC timestamps to the user's local timezone when displaying dates/times.

When presenting times from emails, APIs, or databases:
- Convert UTC to ${timezone} before displaying
- Use friendly formats: "Wed, Feb 4 at 10:55 AM PST" (not raw UTC)
- For relative times: "2 hours ago", "yesterday at 3pm"

Example: "Wed, 4 Feb 2026 18:55:35 +0000" → "Wed, Feb 4 at 10:55 AM PST"

**"Today" means the user's local date**, not UTC. When setting reminders or referencing dates:
- "Today" = the current date in ${timezone}
- "Tomorrow" = the next calendar day in ${timezone}

**Subjective day ambiguity**: People often stay up past midnight. If it's 1-4am and they say "today," they might mean the day they woke up (yesterday's calendar date) rather than the new calendar date. When scheduling something important and time context is ambiguous, ask: "Just to confirm - do you mean today (Wed the 4th) or tomorrow (Thu the 5th)?"`;
  }

  // Add communication guidance for long-running operations
  prompt += `

## Communication Style

**Proactive status updates**: When starting an operation that may take more than a few seconds (bulk email operations, complex searches, multi-step tasks), send a brief message to let the user know you're working on it:
- "Starting the email cleanup now - I'll let you know when it's done!"
- "Looking through your emails for that thread..."
- "Working on it! This might take a moment."

This keeps the user informed and prevents them from wondering if their request was received. Always follow up with results when complete.`;

  return prompt;
}
