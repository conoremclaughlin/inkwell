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
  RunnerResult,
  ChannelResponse,
  ChannelType,
  IRunner,
  ToolCall,
} from './types.js';
import { formatInjectedContext } from './context-builder.js';
import { logger } from '../../utils/logger.js';
import { resolveBinaryPath, buildSpawnPath } from './resolve-binary.js';
import { buildSessionEnv, writeRuntimeSessionHint } from '@inklabs/shared';

/** Maximum time (ms) to wait for a Codex CLI subprocess before killing it.
 *  Override with CODEX_PROCESS_TIMEOUT_MS env var. */
const PROCESS_TIMEOUT_MS =
  parseInt(process.env.CODEX_PROCESS_TIMEOUT_MS || '', 10) || 30 * 60 * 1000; // 30 minutes
const DIAGNOSTIC_MAX_CHARS = 4000;
const DIAGNOSTIC_MAX_LINES = 20;

interface CodexUsageStats {
  contextTokens: number;
  inputTokens: number;
  outputTokens: number;
}

export class CodexRunner implements IRunner {
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

    let fullMessage = message;
    if (injectedContext && !isResume) {
      const contextBlock = formatInjectedContext(injectedContext);
      fullMessage = `${contextBlock}\n\n---\n\n${message}`;
    }

    const { promptPath, cleanup } = this.createIdentityPromptTempFile(
      config.appendSystemPrompt || config.systemPrompt || ''
    );

    try {
      // Only pass a session ID to buildArgs when resuming a known backend session.
      // For fresh runs, Codex assigns its own session UUID — we extract it from stdout.
      const argsSessionId = isResume ? backendSessionId! : undefined;
      const args = this.buildArgs(argsSessionId, isResume, fullMessage, config, promptPath);
      logger.info('Spawning Codex CLI', {
        resumeSessionId: argsSessionId || null,
        isResume,
        workingDirectory: config.workingDirectory,
        messageLength: fullMessage.length,
        hasPcpAccessToken: !!config.pcpAccessToken,
      });

      const result = await this.spawnProcess(args, config);

      // Only return a backend session ID if we actually extracted one from
      // the Codex event stream, or if we were resuming an existing session.
      const resolvedBackendSessionId = result.sessionId || argsSessionId || undefined;

      return {
        success: true,
        backendSessionId: resolvedBackendSessionId || null,
        responses: result.responses,
        usage: result.usage,
        finalTextResponse: result.finalTextResponse,
        toolCalls: result.toolCalls,
      };
    } catch (error) {
      logger.error('Codex process failed', {
        resumeSessionId: backendSessionId || null,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        backendSessionId: backendSessionId || null,
        responses: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      cleanup();
    }
  }

  private buildArgs(
    resumeSessionId: string | undefined,
    isResume: boolean,
    message: string,
    config: ClaudeRunnerConfig,
    promptPath: string
  ): string[] {
    // Triggered sessions are non-interactive (no human present).
    // sandbox_bypass (opt-in per studio): bypasses sandbox + approvals so
    // HTTP MCP tools work in exec mode. Without it, Codex's sandbox blocks
    // network access and MCP calls return "user cancelled".
    // -a never: fallback when sandbox_bypass is off — suppresses shell
    // approval prompts but MCP tools remain blocked.
    const args: string[] = config.sandboxBypass
      ? ['--dangerously-bypass-approvals-and-sandbox', 'exec']
      : ['-a', 'never', 'exec'];
    if (isResume) {
      args.push('resume');
    }

    args.push('--json');
    args.push('-c', `model_instructions_file=${promptPath}`);

    // Ink session headers — Codex resolves env var names to values at runtime.
    // The server key must match what's in .codex/config.toml (mcp_servers.inkwell).
    const codexServerKey = 'inkwell';
    args.push(
      '-c',
      `mcp_servers.${codexServerKey}.env_http_headers.x-ink-context="INK_CONTEXT_TOKEN"`
    );
    args.push('-c', `mcp_servers.${codexServerKey}.env_http_headers.x-ink-agent-id="AGENT_ID"`);
    args.push(
      '-c',
      `mcp_servers.${codexServerKey}.env_http_headers.x-ink-session-id="INK_SESSION_ID"`
    );
    args.push(
      '-c',
      `mcp_servers.${codexServerKey}.env_http_headers.x-ink-studio-id="INK_STUDIO_ID"`
    );
    args.push(
      '-c',
      `mcp_servers.${codexServerKey}.env_http_headers.Authorization="INK_AUTH_BEARER"`
    );

    if (config.model) {
      args.push('-m', config.model);
    }

    if (isResume && resumeSessionId) {
      args.push(resumeSessionId);
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
    const codexBin = await resolveBinaryPath('codex');

    const runtimeLinkId = randomUUID();
    if (config.pcpSessionId && config.workingDirectory) {
      writeRuntimeSessionHint(
        config.workingDirectory,
        config.pcpSessionId,
        config.agentId || 'unknown',
        'codex',
        runtimeLinkId,
        config.studioId
      );
    }

    return new Promise((resolve, reject) => {
      // Strip CLAUDECODE to prevent env leaking into subprocess
      const { CLAUDECODE, ...cleanEnv } = process.env;
      const proc = spawn(codexBin, args, {
        cwd: config.workingDirectory,
        env: {
          ...cleanEnv,
          HOME: process.env.HOME,
          PATH: buildSpawnPath(codexBin),
          ...(config.agentId ? { AGENT_ID: config.agentId } : {}),
          ...buildSessionEnv({
            pcpSessionId: config.pcpSessionId,
            runtimeLinkId: config.pcpSessionId ? runtimeLinkId : undefined,
            studioId: config.studioId,
            accessToken: config.pcpAccessToken,
            agentId: config.agentId,
            runtime: 'codex',
          }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      const nonJsonLines: string[] = [];
      let stdoutRemainder = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const parsedEventTypes: string[] = [];
      const parsedErrorMessages: string[] = [];
      let parsedEventCount = 0;
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
        stdoutBytes += data.length;
        const chunk = data.toString();
        const combined = `${stdoutRemainder}${chunk}`;
        const lines = combined.split('\n');
        stdoutRemainder = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            parsedEventCount += 1;
            if (typeof parsed.type === 'string') {
              parsedEventTypes.push(parsed.type);
              if (parsedEventTypes.length > DIAGNOSTIC_MAX_LINES) {
                parsedEventTypes.shift();
              }
            }
            if (parsed.type === 'error' && typeof parsed.message === 'string') {
              parsedErrorMessages.push(parsed.message);
              if (parsedErrorMessages.length > DIAGNOSTIC_MAX_LINES) {
                parsedErrorMessages.shift();
              }
            }

            // Only extract session ID if we haven't found one yet.
            // The first match (typically thread.started) is authoritative;
            // later events may contain unrelated IDs (e.g., conversationId
            // from tool calls) that would incorrectly overwrite it.
            if (!resolvedSessionId) {
              const maybeSessionId = this.extractSessionId(parsed);
              if (maybeSessionId) {
                logger.debug('Codex session ID discovered in event stream', {
                  codexSessionId: maybeSessionId,
                  eventType: parsed.type,
                  eventIndex: parsedEventCount,
                });
                resolvedSessionId = maybeSessionId;
              }
            }

            const maybeUsage = this.extractUsage(parsed);
            if (maybeUsage) usage = maybeUsage;

            const maybeText = this.extractFinalText(parsed);
            if (maybeText) finalTextResponse = maybeText;

            const extracted = this.extractToolData(parsed);
            responses.push(...extracted.responses);
            toolCalls.push(...extracted.toolCalls);
          } catch {
            // Capture non-JSON lines as diagnostic context
            if (line.trim()) {
              nonJsonLines.push(line.trim());
              if (nonJsonLines.length > DIAGNOSTIC_MAX_LINES) {
                nonJsonLines.shift();
              }
            }
          }
        }
      });

      proc.stderr.on('data', (data) => {
        stderrBytes += data.length;
        stderr += data.toString();
      });

      proc.on('error', (error) => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(new Error(`Failed to spawn Codex: ${error.message}`));
        }
      });

      proc.on('close', (code, signal) => {
        clearTimeout(timeout);
        if (settled) return;
        settled = true;

        if (stdoutRemainder.trim()) {
          try {
            const parsed = JSON.parse(stdoutRemainder) as Record<string, unknown>;
            parsedEventCount += 1;
            if (typeof parsed.type === 'string') {
              parsedEventTypes.push(parsed.type);
              if (parsedEventTypes.length > DIAGNOSTIC_MAX_LINES) {
                parsedEventTypes.shift();
              }
            }
            if (parsed.type === 'error' && typeof parsed.message === 'string') {
              parsedErrorMessages.push(parsed.message);
              if (parsedErrorMessages.length > DIAGNOSTIC_MAX_LINES) {
                parsedErrorMessages.shift();
              }
            }
            if (!resolvedSessionId) {
              const maybeSessionId = this.extractSessionId(parsed);
              if (maybeSessionId) resolvedSessionId = maybeSessionId;
            }
            const maybeUsage = this.extractUsage(parsed);
            if (maybeUsage) usage = maybeUsage;
            const maybeText = this.extractFinalText(parsed);
            if (maybeText) finalTextResponse = maybeText;
            const extracted = this.extractToolData(parsed);
            responses.push(...extracted.responses);
            toolCalls.push(...extracted.toolCalls);
          } catch {
            nonJsonLines.push(stdoutRemainder.trim());
            if (nonJsonLines.length > DIAGNOSTIC_MAX_LINES) {
              nonJsonLines.shift();
            }
          }
        }

        // Log session ID extraction result for debugging session continuity
        const uniqueEventTypes = Array.from(new Set(parsedEventTypes));
        if (resolvedSessionId) {
          logger.info('Codex native session ID extracted', {
            codexSessionId: resolvedSessionId,
            eventCount: parsedEventCount,
            eventTypes: uniqueEventTypes,
            exitCode: code,
          });
        } else if (parsedEventCount > 0) {
          logger.warn('Codex process completed without yielding a session ID', {
            eventCount: parsedEventCount,
            eventTypes: uniqueEventTypes,
            exitCode: code,
            hadFinalText: !!finalTextResponse,
            toolCallCount: toolCalls.length,
          });
        }

        if (code !== 0 && !finalTextResponse && responses.length === 0) {
          const stderrTrimmed = stderr.trim();
          const nonJsonText = nonJsonLines.join('\n').trim();
          const startupOnlyEvents =
            parsedEventTypes.length > 0 &&
            parsedEventTypes.every((type) => type === 'thread.started' || type === 'turn.started');

          const diagnostics: string[] = [];
          diagnostics.push(
            `exitCode=${code ?? 'null'} signal=${signal ?? 'none'} stdoutBytes=${stdoutBytes} stderrBytes=${stderrBytes}`
          );
          if (parsedEventCount > 0) {
            const uniqueTypes = Array.from(new Set(parsedEventTypes));
            diagnostics.push(
              `parsedEvents=${parsedEventCount} types=${uniqueTypes.join(',') || '(none)'}`
            );
          }
          if (parsedErrorMessages.length > 0) {
            diagnostics.push(`parsedErrorMessages:\n${parsedErrorMessages.join('\n')}`);
          }
          if (stderrTrimmed) {
            diagnostics.push(`stderr:\n${stderrTrimmed}`);
          } else if (nonJsonText) {
            diagnostics.push(`stdout(non-json):\n${nonJsonText}`);
          } else if (startupOnlyEvents) {
            diagnostics.push(
              'Codex emitted startup events only (thread.started/turn.started) then exited before completion.'
            );
          } else {
            diagnostics.push('No stderr and no non-JSON stdout captured.');
          }

          const diagnostic = diagnostics.join('\n\n').slice(0, DIAGNOSTIC_MAX_CHARS);
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
    // Priority 1: Codex JSONL emits `session_meta` with UUID at `payload.id`.
    if (
      event.type === 'session_meta' &&
      typeof (event.payload as Record<string, unknown>)?.id === 'string'
    ) {
      return (event.payload as Record<string, unknown>).id as string;
    }

    // Priority 2: Codex stdout emits `thread.started` with `thread_id`.
    // This is the primary session ID source for `codex exec --json`.
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      return event.thread_id;
    }

    // Fallback: BFS scan for common session ID keys.
    // Only match session/thread IDs — NOT conversationId, which often
    // contains PCP routing keys (e.g., "trigger:lumen:thread:foo")
    // that are unrelated to the backend session.
    const queue: unknown[] = [event];
    const sessionKeys = new Set(['session_id', 'sessionId', 'thread_id', 'threadId']);

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

          if (name === 'mcp__inkwell__send_response') {
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
                metadata: (input as Record<string, unknown>).metadata as
                  | Record<string, unknown>
                  | undefined,
                media: (input as Record<string, unknown>).media as ChannelResponse['media'],
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
