/**
 * Gemini Runner
 *
 * Spawns Gemini CLI in non-interactive (headless) JSON mode.
 * Models after ClaudeRunner but adapts for Gemini CLI conventions:
 *   - Message via -p flag (not stdin)
 *   - JSON output via -o stream-json
 *   - Auto-approve via --yolo
 *   - Resume via -r (index-based, not UUID — session continuity is best-effort)
 *   - System prompt via --policy or prepended to message
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
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

/** Maximum time (ms) to wait for a Gemini CLI subprocess before killing it */
const PROCESS_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Idle timeout: no output for this long = stuck */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface GeminiUsageStats {
  contextTokens: number;
  inputTokens: number;
  outputTokens: number;
}

export class GeminiRunner implements IClaudeRunner {
  async run(
    message: string,
    options: {
      claudeSessionId?: string;
      injectedContext?: InjectedContext;
      config: ClaudeRunnerConfig;
    }
  ): Promise<ClaudeRunnerResult> {
    const { injectedContext, config } = options;

    // Gemini uses index-based session resume (-r), not UUID-based.
    // For now, always start fresh sessions — resume support is best-effort.
    const sessionId = randomUUID();

    // Build the message with injected context (prepended, like Codex runner)
    let fullMessage = message;
    if (injectedContext) {
      const contextBlock = formatInjectedContext(injectedContext);
      fullMessage = `${contextBlock}\n\n---\n\n${message}`;
    }

    // Optionally write system prompt to a temp policy file
    const { policyPath, cleanup } = this.createPolicyTempFile(
      config.appendSystemPrompt || config.systemPrompt || ''
    );

    try {
      const args = this.buildArgs(fullMessage, config, policyPath);
      logger.info('Spawning Gemini CLI', {
        sessionId,
        workingDirectory: config.workingDirectory,
        messageLength: fullMessage.length,
        hasPcpAccessToken: !!config.pcpAccessToken,
      });

      const result = await this.spawnProcess(args, config);

      return {
        success: true,
        claudeSessionId: sessionId,
        responses: result.responses,
        usage: result.usage,
        finalTextResponse: result.finalTextResponse,
        toolCalls: result.toolCalls,
      };
    } catch (error) {
      logger.error('Gemini process failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        claudeSessionId: sessionId,
        responses: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      cleanup();
    }
  }

  private buildArgs(message: string, config: ClaudeRunnerConfig, policyPath?: string): string[] {
    const args: string[] = ['-p', message, '-o', 'stream-json', '--yolo'];

    if (config.model) {
      args.push('-m', config.model);
    }

    if (policyPath) {
      args.push('--policy', policyPath);
    }

    return args;
  }

  private async spawnProcess(
    args: string[],
    config: ClaudeRunnerConfig
  ): Promise<{
    responses: ChannelResponse[];
    usage?: GeminiUsageStats;
    finalTextResponse?: string;
    toolCalls: ToolCall[];
  }> {
    return new Promise((resolve, reject) => {
      // Strip CLAUDECODE to prevent env leaking into subprocess
      const { CLAUDECODE, ...cleanEnv } = process.env;
      const proc = spawn('gemini', args, {
        cwd: config.workingDirectory,
        env: {
          ...cleanEnv,
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          ...(config.pcpAccessToken ? { PCP_ACCESS_TOKEN: config.pcpAccessToken } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      let stdoutRemainder = '';
      const responses: ChannelResponse[] = [];
      const toolCalls: ToolCall[] = [];
      let usage: GeminiUsageStats | undefined;
      let finalTextResponse: string | undefined;
      let settled = false;
      let lastActivityAt = Date.now();

      // Activity-based timeout
      let idleTimer: NodeJS.Timeout;
      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (!settled) {
            const idleSecs = Math.round((Date.now() - lastActivityAt) / 1000);
            logger.error('Gemini CLI process idle too long, killing', {
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

      // Hard ceiling timeout
      const timeout = setTimeout(() => {
        if (!settled) {
          logger.error('Gemini CLI process hit hard timeout, killing', {
            timeoutMs: PROCESS_TIMEOUT_MS,
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

        // Buffer-aware line splitting: a single chunk may contain a partial
        // JSON line at the end. We carry the remainder over to the next chunk.
        const combined = `${stdoutRemainder}${chunk}`;
        const lines = combined.split('\n');
        stdoutRemainder = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            this.handleStreamEvent(parsed, responses);
            this.captureToolCall(parsed, toolCalls);

            // Capture usage stats
            if (parsed.usageMetadata || parsed.usage) {
              const u = parsed.usageMetadata || parsed.usage;
              usage = {
                contextTokens: u.totalTokenCount || u.context_tokens || 0,
                inputTokens: u.promptTokenCount || u.input_tokens || 0,
                outputTokens: u.candidatesTokenCount || u.output_tokens || 0,
              };
            }

            // Capture final text from various Gemini output formats
            if (parsed.type === 'result' && parsed.result) {
              finalTextResponse =
                typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result);
            }

            // Gemini stream-json may emit text content differently
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

            // Also handle plain text events
            if (parsed.type === 'text' && typeof parsed.text === 'string') {
              finalTextResponse = (finalTextResponse || '') + parsed.text;
            }

            // Handle modelResponse format (Gemini-specific)
            if (parsed.type === 'modelResponse' && parsed.text) {
              finalTextResponse = parsed.text;
            }
          } catch {
            // Not JSON — could be plain text output
            // Accumulate as potential response text
            const trimmed = line.trim();
            if (
              trimmed &&
              !trimmed.startsWith('YOLO') &&
              !trimmed.startsWith('[ERROR]') &&
              !trimmed.startsWith('Loaded') &&
              !trimmed.startsWith('Found') &&
              !trimmed.startsWith('Server') &&
              !trimmed.startsWith('MCP')
            ) {
              finalTextResponse = (finalTextResponse || '') + trimmed + '\n';
            }
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
          reject(new Error(`Failed to spawn Gemini: ${error.message}`));
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        clearTimeout(idleTimer);
        if (settled) return;
        settled = true;

        // Flush any remaining buffered output
        if (stdoutRemainder.trim()) {
          try {
            const parsed = JSON.parse(stdoutRemainder);
            this.handleStreamEvent(parsed, responses);
            this.captureToolCall(parsed, toolCalls);
            if (parsed.usageMetadata || parsed.usage) {
              const u = parsed.usageMetadata || parsed.usage;
              usage = {
                contextTokens: u.totalTokenCount || u.context_tokens || 0,
                inputTokens: u.promptTokenCount || u.input_tokens || 0,
                outputTokens: u.candidatesTokenCount || u.output_tokens || 0,
              };
            }
            if (parsed.type === 'result' && parsed.result) {
              finalTextResponse =
                typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result);
            }
          } catch {
            // Non-JSON remainder — ignore
          }
        }

        if (code !== 0) {
          logger.warn('Gemini CLI exited with non-zero code', { code, stderr });
          if (responses.length === 0 && !finalTextResponse) {
            reject(new Error(`Gemini exited with code ${code}: ${stderr}`));
            return;
          }
        }

        resolve({ responses, usage, toolCalls, finalTextResponse });
      });
    });
  }

  /**
   * Kill a Gemini CLI subprocess gracefully, with escalation to SIGKILL.
   */
  private killProcess(proc: ChildProcess): void {
    try {
      proc.kill('SIGTERM');
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
    // Handle both Claude-style and Gemini-style tool call events
    if (event.type === 'tool_use' || event.type === 'toolCall') {
      toolCalls.push({
        toolUseId: (event.id as string) || (event.toolCallId as string) || '',
        toolName: (event.name as string) || (event.toolName as string) || '',
        input:
          (event.input as Record<string, unknown>) || (event.args as Record<string, unknown>) || {},
      });
    }
  }

  /**
   * Handle a streaming JSON event — capture send_response tool calls.
   */
  private handleStreamEvent(event: Record<string, unknown>, responses: ChannelResponse[]): void {
    // Look for send_response tool calls (same MCP tool as Claude/Codex)
    const toolName = (event.name as string) || (event.toolName as string);
    const isToolUse = event.type === 'tool_use' || event.type === 'toolCall';

    if (isToolUse && toolName === 'mcp__pcp__send_response') {
      const input =
        (event.input as Record<string, unknown>) || (event.args as Record<string, unknown>) || {};
      const channel = (input.channel as ChannelType) || 'telegram';
      const response: ChannelResponse = {
        channel,
        conversationId: (input.conversationId as string) || '',
        content: (input.content as string) || '',
        format: input.format as 'text' | 'markdown' | 'code' | 'json' | undefined,
        replyToMessageId: input.replyToMessageId as string | undefined,
        metadata: input.metadata as Record<string, unknown> | undefined,
      };
      responses.push(response);
      logger.debug('Captured send_response call from Gemini', { response });
    }
  }

  /**
   * Write system prompt / identity to a temp policy file for Gemini CLI.
   */
  private createPolicyTempFile(content: string): {
    policyPath: string | undefined;
    cleanup: () => void;
  } {
    if (!content) {
      return { policyPath: undefined, cleanup: () => {} };
    }

    const dir = mkdtempSync(join(tmpdir(), 'gemini-policy-'));
    const policyPath = join(dir, 'identity-policy.md');
    writeFileSync(policyPath, content, 'utf-8');

    return {
      policyPath,
      cleanup: () => {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Best effort cleanup
        }
      },
    };
  }
}
