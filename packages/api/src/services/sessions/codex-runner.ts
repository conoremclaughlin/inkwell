/**
 * Codex Runner
 *
 * Spawns Codex CLI in non-interactive JSON mode.
 * Supports fresh runs and resume runs for session continuity.
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

const PROCESS_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

interface CodexUsageStats {
  contextTokens: number;
  inputTokens: number;
  outputTokens: number;
}

export class CodexRunner implements IClaudeRunner {
  async run(
    message: string,
    options: {
      claudeSessionId?: string;
      injectedContext?: InjectedContext;
      config: ClaudeRunnerConfig;
    }
  ): Promise<ClaudeRunnerResult> {
    const { claudeSessionId, injectedContext, config } = options;
    const isResume = !!claudeSessionId;

    let sessionId = claudeSessionId || randomUUID();

    let fullMessage = message;
    if (injectedContext && !isResume) {
      const contextBlock = formatInjectedContext(injectedContext);
      fullMessage = `${contextBlock}\n\n---\n\n${message}`;
    }

    const { promptPath, cleanup } = this.createIdentityPromptTempFile(
      config.appendSystemPrompt || config.systemPrompt || ''
    );

    try {
      const args = this.buildArgs(sessionId, isResume, fullMessage, config, promptPath);
      logger.info('Spawning Codex CLI', {
        sessionId,
        isResume,
        workingDirectory: config.workingDirectory,
        messageLength: fullMessage.length,
        hasPcpAccessToken: !!config.pcpAccessToken,
      });

      const result = await this.spawnProcess(args, config);
      if (result.sessionId) {
        sessionId = result.sessionId;
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
      logger.error('Codex process failed', {
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

  private buildArgs(
    sessionId: string,
    isResume: boolean,
    message: string,
    config: ClaudeRunnerConfig,
    promptPath: string
  ): string[] {
    const args: string[] = ['exec'];
    if (isResume) {
      args.push('resume');
    }

    args.push('--json');
    args.push('-c', `model_instructions_file=${promptPath}`);

    if (config.model) {
      args.push('-m', config.model);
    }

    if (isResume) {
      args.push(sessionId);
      args.push(message);
    } else {
      args.push(message);
    }

    return args;
  }

  private async spawnProcess(
    args: string[],
    config: ClaudeRunnerConfig
  ): Promise<{
    responses: ChannelResponse[];
    usage?: CodexUsageStats;
    finalTextResponse?: string;
    toolCalls: ToolCall[];
    sessionId?: string;
  }> {
    return new Promise((resolve, reject) => {
      // Strip CLAUDECODE to prevent env leaking into subprocess
      const { CLAUDECODE, ...cleanEnv } = process.env;
      const proc = spawn('codex', args, {
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
      const nonJsonLines: string[] = [];
      const responses: ChannelResponse[] = [];
      const toolCalls: ToolCall[] = [];
      let usage: CodexUsageStats | undefined;
      let finalTextResponse: string | undefined;
      let resolvedSessionId: string | undefined;

      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.killProcess(proc);
          resolve({
            responses,
            usage,
            finalTextResponse: finalTextResponse || '[Codex process timed out]',
            toolCalls,
            sessionId: resolvedSessionId,
          });
        }
      }, PROCESS_TIMEOUT_MS);

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        const lines = chunk.split('\n').filter((line: string) => line.trim());

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;

            const maybeSessionId = this.extractSessionId(parsed);
            if (maybeSessionId) resolvedSessionId = maybeSessionId;

            const maybeUsage = this.extractUsage(parsed);
            if (maybeUsage) usage = maybeUsage;

            const maybeText = this.extractFinalText(parsed);
            if (maybeText) finalTextResponse = maybeText;

            const extracted = this.extractToolData(parsed);
            responses.push(...extracted.responses);
            toolCalls.push(...extracted.toolCalls);
          } catch {
            // Capture non-JSON lines as diagnostic context
            if (line.trim()) nonJsonLines.push(line.trim());
          }
        }
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('error', (error) => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(new Error(`Failed to spawn Codex: ${error.message}`));
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (settled) return;
        settled = true;

        if (code !== 0 && !finalTextResponse && responses.length === 0) {
          const diagnostic = stderr || nonJsonLines.join('\n') || '(no output)';
          reject(new Error(`Codex exited with code ${code}: ${diagnostic}`));
          return;
        }

        resolve({
          responses,
          usage,
          finalTextResponse,
          toolCalls,
          sessionId: resolvedSessionId,
        });
      });
    });
  }

  private killProcess(proc: ChildProcess): void {
    try {
      proc.kill('SIGTERM');
      setTimeout(() => {
        try {
          if (!proc.killed) proc.kill('SIGKILL');
        } catch {
          // already dead
        }
      }, 5000);
    } catch {
      // already dead
    }
  }

  private createIdentityPromptTempFile(content: string): {
    promptPath: string;
    cleanup: () => void;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'pcp-codex-'));
    const promptPath = join(dir, 'identity.md');
    writeFileSync(promptPath, content || 'Follow system identity instructions.');
    return {
      promptPath,
      cleanup: () => {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      },
    };
  }

  private extractSessionId(event: Record<string, unknown>): string | undefined {
    const queue: unknown[] = [event];
    const sessionKeys = new Set([
      'session_id',
      'sessionId',
      'conversation_id',
      'conversationId',
      'thread_id',
      'threadId',
    ]);

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || typeof current !== 'object') continue;
      const obj = current as Record<string, unknown>;

      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string' && sessionKeys.has(key)) {
          return value;
        }
        if (value && typeof value === 'object') queue.push(value);
      }
    }
    return undefined;
  }

  private extractUsage(event: Record<string, unknown>): CodexUsageStats | undefined {
    const queue: unknown[] = [event];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || typeof current !== 'object') continue;
      const obj = current as Record<string, unknown>;

      const maybeInput = obj.input_tokens;
      const maybeOutput = obj.output_tokens;
      const maybeContext = obj.context_tokens;
      if (typeof maybeInput === 'number' && typeof maybeOutput === 'number') {
        const cachedInput =
          typeof obj.cached_input_tokens === 'number' ? obj.cached_input_tokens : 0;
        const cacheRead =
          typeof obj.cache_read_input_tokens === 'number' ? obj.cache_read_input_tokens : 0;
        const cacheCreate =
          typeof obj.cache_creation_input_tokens === 'number' ? obj.cache_creation_input_tokens : 0;
        const totalInput = maybeInput + cachedInput + cacheRead + cacheCreate;
        return {
          contextTokens: typeof maybeContext === 'number' ? maybeContext : totalInput,
          inputTokens: totalInput,
          outputTokens: maybeOutput,
        };
      }

      for (const value of Object.values(obj)) {
        if (value && typeof value === 'object') queue.push(value);
      }
    }

    return undefined;
  }

  private extractFinalText(event: Record<string, unknown>): string | undefined {
    const candidates: unknown[] = [
      event.result,
      event.output_text,
      event.text,
      (event.message as Record<string, unknown> | undefined)?.content,
      (event.item as Record<string, unknown> | undefined)?.text,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate;
      }
    }

    // Fallback: recursively find first "text" field with non-empty string
    const queue: unknown[] = [event];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || typeof current !== 'object') continue;
      const obj = current as Record<string, unknown>;
      if (typeof obj.text === 'string' && obj.text.trim()) {
        return obj.text;
      }
      for (const value of Object.values(obj)) {
        if (value && typeof value === 'object') queue.push(value);
      }
    }

    return undefined;
  }

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

      const name = obj.name;
      if (typeof name === 'string') {
        const rawInput = obj.input ?? obj.args ?? obj.arguments ?? {};
        const input = this.normalizeInput(rawInput);

        if (input && typeof input === 'object') {
          toolCalls.push({
            toolUseId: typeof obj.id === 'string' ? obj.id : randomUUID(),
            toolName: name,
            input: input as Record<string, unknown>,
          });

          if (name === 'mcp__pcp__send_response') {
            const channel = (input as Record<string, unknown>).channel as ChannelType | undefined;
            const conversationId = (input as Record<string, unknown>).conversationId as
              | string
              | undefined;
            const content = (input as Record<string, unknown>).content as string | undefined;
            if (channel && conversationId && content) {
              responses.push({
                channel,
                conversationId,
                content,
                format: (input as Record<string, unknown>).format as
                  | 'text'
                  | 'markdown'
                  | 'code'
                  | 'json'
                  | undefined,
                replyToMessageId: (input as Record<string, unknown>).replyToMessageId as
                  | string
                  | undefined,
              });
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
}
