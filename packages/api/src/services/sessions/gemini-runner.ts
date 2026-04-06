/**
 * Gemini Runner
 *
 * Spawns Gemini CLI in non-interactive (headless) JSON mode.
 * Models after ClaudeRunner but adapts for Gemini CLI conventions:
 *   - Message via -p flag (not stdin)
 *   - JSON output via -o stream-json
 *   - Auto-approve via --yolo
 *   - Resume via -r <uuid> (Gemini emits session_id in the init event)
 *   - System prompt via --policy
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
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
import { buildSessionEnv } from '@inklabs/shared';

/** Maximum time (ms) to wait for a Gemini CLI subprocess before killing it.
 *  Override with GEMINI_PROCESS_TIMEOUT_MS env var. */
const PROCESS_TIMEOUT_MS =
  parseInt(process.env.GEMINI_PROCESS_TIMEOUT_MS || '', 10) || 30 * 60 * 1000; // 30 minutes

/** Idle timeout: no output for this long = stuck */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface GeminiUsageStats {
  contextTokens: number;
  inputTokens: number;
  outputTokens: number;
}

export class GeminiRunner implements IRunner {
  async run(
    message: string,
    options: {
      backendSessionId?: string;
      injectedContext?: InjectedContext;
      config: ClaudeRunnerConfig;
    }
  ): Promise<RunnerResult> {
    const { backendSessionId, injectedContext, config } = options;
    const isResume = !!backendSessionId;

    // Build the message with injected context on first turn (same as Claude/Codex)
    let fullMessage = message;
    if (injectedContext && !isResume) {
      const contextBlock = formatInjectedContext(injectedContext);
      fullMessage = `${contextBlock}\n\n---\n\n${message}`;
    }

    // Optionally write system prompt to a temp policy file
    const { policyPath, cleanup } = this.createPolicyTempFile(
      config.appendSystemPrompt || config.systemPrompt || ''
    );

    // Build Gemini system settings with PCP MCP server config (including auth).
    // Gemini CLI reads MCP config from settings.json, NOT .mcp.json.
    // We use GEMINI_CLI_SYSTEM_SETTINGS_PATH to point to a temp settings file
    // that overrides the mcpServers section. Other user settings (model, auth,
    // etc.) are preserved since system settings only override matching keys.
    let geminiSettingsPath: string | undefined;
    if (config.pcpAccessToken) {
      const mcpJsonPath = join(config.workingDirectory, '.mcp.json');
      // Start from workspace .mcp.json servers (includes supabase, github, etc.)
      let mcpServers: Record<string, unknown> = {};
      if (existsSync(mcpJsonPath)) {
        try {
          const parsed = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
          mcpServers = parsed.mcpServers || {};
        } catch {
          // ignore parse errors
        }
      }

      // Ensure PCP server has auth + session headers
      const pcpConfig = (mcpServers.inkwell || {}) as Record<string, unknown>;
      const existingHeaders = (pcpConfig.headers || {}) as Record<string, string>;
      mcpServers.inkwell = {
        ...pcpConfig,
        type: pcpConfig.type || 'http',
        url: pcpConfig.url || 'http://localhost:3001/mcp',
        headers: {
          ...existingHeaders,
          Authorization: 'Bearer ${INK_ACCESS_TOKEN}',
          'x-ink-context': '${INK_CONTEXT_TOKEN}',
          'x-ink-session-id': '${INK_SESSION_ID}',
          'x-ink-studio-id': '${INK_STUDIO_ID}',
        },
      };

      const settingsDir = join(tmpdir(), 'sb-gemini');
      mkdirSync(settingsDir, { recursive: true });
      const settingsFile = join(settingsDir, `settings-${process.pid}-${Date.now()}.json`);
      try {
        writeFileSync(settingsFile, JSON.stringify({ mcpServers }, null, 2));
        geminiSettingsPath = settingsFile;
      } catch (err) {
        logger.warn('Failed to write Gemini system settings', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    try {
      const args = this.buildArgs(fullMessage, config, policyPath, backendSessionId);
      logger.info('Spawning Gemini CLI', {
        isResume,
        backendSessionId: backendSessionId || '(new)',
        workingDirectory: config.workingDirectory,
        messageLength: fullMessage.length,
        hasPcpAccessToken: !!config.pcpAccessToken,
        geminiSettingsOverride: !!geminiSettingsPath,
      });

      const result = await this.spawnProcess(
        args,
        config,
        geminiSettingsPath ? { GEMINI_CLI_SYSTEM_SETTINGS_PATH: geminiSettingsPath } : undefined
      );

      // Use session ID from Gemini's init event, fall back to the one we passed in
      const resolvedSessionId = result.sessionId || backendSessionId || undefined;

      return {
        success: true,
        backendSessionId: resolvedSessionId || null,
        responses: result.responses,
        usage: result.usage,
        finalTextResponse: result.finalTextResponse,
        toolCalls: result.toolCalls,
      };
    } catch (error) {
      logger.error('Gemini process failed', {
        backendSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        backendSessionId: backendSessionId || null,
        responses: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      // Clean up temp Gemini settings file
      if (geminiSettingsPath) {
        try {
          rmSync(geminiSettingsPath, { force: true });
        } catch {
          // best-effort cleanup
        }
      }
      cleanup();
    }
  }

  private buildArgs(
    message: string,
    config: ClaudeRunnerConfig,
    policyPath?: string,
    resumeSessionId?: string
  ): string[] {
    const args: string[] = ['-p', message, '-o', 'stream-json', '--yolo'];

    if (resumeSessionId) {
      args.push('-r', resumeSessionId);
    }

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
    config: ClaudeRunnerConfig,
    extraEnv?: Record<string, string>
  ): Promise<{
    responses: ChannelResponse[];
    usage?: GeminiUsageStats;
    finalTextResponse?: string;
    toolCalls: ToolCall[];
    sessionId?: string;
  }> {
    const geminiBin = await resolveBinaryPath('gemini');
    return new Promise((resolve, reject) => {
      // Strip CLAUDECODE to prevent env leaking into subprocess
      const { CLAUDECODE, ...cleanEnv } = process.env;
      const proc = spawn(geminiBin, args, {
        cwd: config.workingDirectory,
        env: {
          ...cleanEnv,
          HOME: process.env.HOME,
          PATH: buildSpawnPath(geminiBin),
          ...(config.agentId ? { AGENT_ID: config.agentId } : {}),
          ...(extraEnv || {}),
          ...buildSessionEnv({
            pcpSessionId: config.pcpSessionId,
            studioId: config.studioId,
            accessToken: config.pcpAccessToken,
            agentId: config.agentId,
            runtime: 'gemini',
            repoRoot: config.repoRoot,
          }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      let stdoutRemainder = '';
      const responses: ChannelResponse[] = [];
      const toolCalls: ToolCall[] = [];
      let usage: GeminiUsageStats | undefined;
      let finalTextResponse: string | undefined;
      let capturedStreamError: string | undefined;
      let resolvedSessionId: string | undefined;
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
              sessionId: resolvedSessionId,
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
            sessionId: resolvedSessionId,
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
            const extracted = this.extractToolData(parsed);
            responses.push(...extracted.responses);
            toolCalls.push(...extracted.toolCalls);

            // Capture session_id from init event (Gemini emits this on every session)
            if (parsed.type === 'init' && typeof parsed.session_id === 'string') {
              resolvedSessionId = parsed.session_id;
            }

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

            // Capture structured errors from Gemini stream-json
            if (parsed.type === 'result' && parsed.status === 'error' && parsed.error) {
              const errType = parsed.error.type || 'Error';
              const errMsg = parsed.error.message || 'Unknown error';
              capturedStreamError = `[${errType}] ${errMsg}`;
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
            const extracted = this.extractToolData(parsed);
            responses.push(...extracted.responses);
            toolCalls.push(...extracted.toolCalls);
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
            if (parsed.type === 'result' && parsed.status === 'error' && parsed.error) {
              const errType = parsed.error.type || 'Error';
              const errMsg = parsed.error.message || 'Unknown error';
              capturedStreamError = `[${errType}] ${errMsg}`;
            }
          } catch {
            // Non-JSON remainder — ignore
          }
        }

        if (code !== 0) {
          logger.warn('Gemini CLI exited with non-zero code', {
            code,
            stderr,
            capturedStreamError,
          });
          if (responses.length === 0 && !finalTextResponse) {
            reject(new Error(`Gemini exited with code ${code}: ${capturedStreamError || stderr}`));
            return;
          }
        }

        resolve({ responses, usage, toolCalls, finalTextResponse, sessionId: resolvedSessionId });
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
   * Extract tool calls and send_response calls from a streaming event.
   *
   * Uses BFS to find tool call data anywhere in the event structure,
   * matching the robust approach used by CodexRunner. Gemini's stream-json
   * format may nest tool info in various structures (functionCall, toolCall,
   * parts arrays, etc.) — BFS handles all of them.
   */
  private extractToolData(event: Record<string, unknown>): {
    responses: ChannelResponse[];
    toolCalls: ToolCall[];
  } {
    const responses: ChannelResponse[] = [];
    const toolCalls: ToolCall[] = [];
    const queue: unknown[] = [event];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || typeof current !== 'object') continue;
      const obj = current as Record<string, unknown>;

      // Look for a "name" field indicating a tool/function call
      const name = obj.name;
      if (typeof name === 'string' && name.length > 0) {
        const rawInput = obj.input ?? obj.args ?? obj.arguments ?? {};
        const input = this.normalizeInput(rawInput);

        if (input && typeof input === 'object') {
          toolCalls.push({
            toolUseId:
              typeof obj.id === 'string'
                ? obj.id
                : typeof obj.toolCallId === 'string'
                  ? obj.toolCallId
                  : '',
            toolName: name,
            input: input as Record<string, unknown>,
          });

          if (name === 'mcp__inkwell__send_response') {
            const typedInput = input as Record<string, unknown>;
            const channel = (typedInput.channel as ChannelType) || 'telegram';
            const conversationId = typedInput.conversationId as string | undefined;
            const content = typedInput.content as string | undefined;
            if (channel && conversationId && content) {
              responses.push({
                channel,
                conversationId,
                content,
                format: typedInput.format as 'text' | 'markdown' | 'code' | 'json' | undefined,
                replyToMessageId: typedInput.replyToMessageId as string | undefined,
                metadata: typedInput.metadata as Record<string, unknown> | undefined,
                media: typedInput.media as ChannelResponse['media'],
              });
              logger.debug('Captured send_response call from Gemini', { channel, conversationId });
            }
          }
        }
      }

      for (const value of Object.values(obj)) {
        if (value && typeof value === 'object') queue.push(value);
      }
    }

    return { responses, toolCalls };
  }

  private normalizeInput(raw: unknown): unknown {
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return {};
      }
    }
    return raw;
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
