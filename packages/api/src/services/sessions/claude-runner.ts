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
  ClaudeRunnerResult,
  ChannelResponse,
  ChannelType,
  IClaudeRunner,
  ToolCall,
} from './types.js';
import { formatInjectedContext } from './context-builder.js';
import { logger } from '../../utils/logger.js';
import { resolveBinaryPath, buildSpawnPath } from './resolve-binary.js';
import {
  injectSessionHeaders,
  buildSessionEnv,
  writeRuntimeSessionHint,
} from '@personal-context/shared';

/** Maximum time (ms) to wait for a Claude Code subprocess before killing it.
 *  Override with CLAUDE_PROCESS_TIMEOUT_MS env var. */
const PROCESS_TIMEOUT_MS =
  parseInt(process.env.CLAUDE_PROCESS_TIMEOUT_MS || '', 10) || 30 * 60 * 1000; // 30 minutes

/**
 * Parse usage stats from Claude Code stream output.
 */
interface ClaudeUsageStats {
  contextTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export class ClaudeRunner implements IClaudeRunner {
  async run(
    message: string,
    options: {
      claudeSessionId?: string;
      injectedContext?: InjectedContext;
      config: ClaudeRunnerConfig;
    }
  ): Promise<ClaudeRunnerResult> {
    const { claudeSessionId, injectedContext, config } = options;

    // Determine if resuming or starting new session
    const isResume = !!claudeSessionId;
    let sessionId = claudeSessionId || randomUUID();

    // Build the message with injected context
    let fullMessage = message;
    if (injectedContext && !isResume) {
      // Only inject full context on first message (not resume)
      const contextBlock = formatInjectedContext(injectedContext);
      fullMessage = `${contextBlock}\n\n---\n\n${message}`;
    }

    // Build Claude Code arguments
    let args = this.buildArgs(sessionId, isResume, config);

    logger.info('Spawning Claude Code', {
      sessionId,
      isResume,
      workingDirectory: config.workingDirectory,
      messageLength: fullMessage.length,
    });

    try {
      const result = await this.spawnProcess(args, fullMessage, config);

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
        }

        logger.info('Retrying with fresh session', { sessionId });
        const retryResult = await this.spawnProcess(args, fullMessage, config);

        return {
          success: true,
          claudeSessionId: sessionId,
          responses: retryResult.responses,
          usage: retryResult.usage,
          finalTextResponse: retryResult.finalTextResponse,
          toolCalls: retryResult.toolCalls,
        };
      }

      return {
        success: true,
        claudeSessionId: sessionId,
        responses: result.responses,
        usage: result.usage,
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
        claudeSessionId: sessionId,
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

    // MCP config
    if (config.mcpConfigPath) {
      args.push('--mcp-config', config.mcpConfigPath);
    }

    // System prompt override (survives compaction)
    if (config.appendSystemPrompt) {
      args.push('--append-system-prompt', config.appendSystemPrompt);
    }

    return args;
  }

  private async spawnProcess(
    args: string[],
    message: string,
    config: ClaudeRunnerConfig
  ): Promise<{
    responses: ChannelResponse[];
    usage?: ClaudeUsageStats;
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
          })
        : null;

    // If headers were injected, patch the --mcp-config arg to point to the temp file
    if (mcpInjection?.modified) {
      const mcpIdx = args.indexOf('--mcp-config');
      if (mcpIdx !== -1 && args[mcpIdx + 1]) {
        args[mcpIdx + 1] = mcpInjection.mcpConfigPath;
      }
    }

    return new Promise((resolve, reject) => {
      // Strip CLAUDECODE to prevent "nested session" detection when PCP is
      // launched from inside a Claude Code session (e.g., via PM2).
      const { CLAUDECODE, ...cleanEnv } = process.env;
      const proc = spawn(claudeBin, args, {
        cwd: config.workingDirectory,
        env: {
          ...cleanEnv,
          // Ensure Claude Code uses correct paths
          HOME: process.env.HOME,
          PATH: buildSpawnPath(claudeBin),
          // Session env vars: PCP_SESSION_ID for ${VAR} interpolation in
          // .mcp.json headers, PCP_RUNTIME_LINK_ID for hook hint matching.
          ...buildSessionEnv({
            pcpSessionId: config.pcpSessionId,
            runtimeLinkId: config.pcpSessionId ? runtimeLinkId : undefined,
            studioId: config.studioId,
          }),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';
      const responses: ChannelResponse[] = [];
      const toolCalls: ToolCall[] = [];
      let usage: ClaudeUsageStats | undefined;
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

      proc.stdout.on('data', (data) => {
        lastActivityAt = Date.now();
        resetIdleTimer();
        const chunk = data.toString();

        // Parse streaming JSON lines (don't accumulate raw stdout - avoid memory bloat)
        const lines = chunk.split('\n').filter((line: string) => line.trim());
        for (const line of lines) {
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

            // Extract usage stats and final text response from result
            if (parsed.type === 'result') {
              if (parsed.usage) {
                usage = {
                  contextTokens: parsed.usage.context_tokens || 0,
                  inputTokens: parsed.usage.input_tokens || 0,
                  outputTokens: parsed.usage.output_tokens || 0,
                  cacheReadTokens: parsed.usage.cache_read_tokens,
                  cacheWriteTokens: parsed.usage.cache_write_tokens,
                };
              }
              // Capture the final text response from the result
              if (parsed.result && typeof parsed.result === 'string') {
                finalTextResponse = parsed.result;
              }
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
      });

      proc.stderr.on('data', (data) => {
        lastActivityAt = Date.now();
        resetIdleTimer();
        stderr += data.toString();
      });

      proc.on('error', (error) => {
        clearTimeout(timeout);
        clearTimeout(idleTimer);
        if (!settled) {
          settled = true;
          reject(new Error(`Failed to spawn Claude: ${error.message}`));
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        clearTimeout(idleTimer);
        mcpInjection?.cleanup();
        if (settled) return; // Already resolved by timeout
        settled = true;

        // Handle resume failure gracefully - don't reject, let caller retry
        if (resumeFailedNoSession) {
          resolve({ responses, usage, toolCalls, resumeFailedNoSession: true, finalTextResponse });
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

        resolve({ responses, usage, toolCalls, finalTextResponse });
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

      if (toolName === 'mcp__pcp__send_response') {
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

Do NOT read \`.pcp/identity.json\` — your identity is set by this system prompt.
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
