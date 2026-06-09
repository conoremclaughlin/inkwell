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
} from './types.js';
import { formatInjectedContext } from './context-builder.js';
import { logger } from '../../utils/logger.js';
import { resolveBinaryPath, buildSpawnPath } from './resolve-binary.js';
import { injectSessionHeaders, buildSessionEnv, writeRuntimeSessionHint } from '@inklabs/shared';

const PROCESS_TIMEOUT_MS = parseInt(process.env.INK_PROCESS_TIMEOUT_MS || '', 10) || 15 * 60 * 1000;

export class InkRunner implements IRunner {
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
    const sessionId = config.pcpSessionId || backendSessionId || randomUUID();

    let fullMessage = message;
    if (injectedContext && !isResume) {
      const contextBlock = formatInjectedContext(injectedContext);
      fullMessage = `${contextBlock}\n\n---\n\n${message}`;
    }

    const args = this.buildArgs(sessionId, config);

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

        const freshArgs = this.buildArgs(sessionId, config);
        const retryResult = await this.spawnProcess(freshArgs, fullMessage, config);
        return {
          success: true,
          backendSessionId: sessionId,
          responses: retryResult.responses,
          usage: retryResult.usage,
          finalTextResponse: retryResult.finalTextResponse,
          toolCalls: retryResult.toolCalls,
        };
      }

      return {
        success: true,
        backendSessionId: sessionId,
        responses: result.responses,
        usage: result.usage,
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

  private buildArgs(sessionId: string, config: ClaudeRunnerConfig): string[] {
    const args: string[] = ['chat', '--non-interactive'];

    if (config.agentId) {
      args.push('--agent', config.agentId);
    }

    args.push('--session-id', sessionId);

    if (config.model) {
      args.push('--model', config.model);
    }

    args.push('--max-turns', '5');

    // Full profile = auto-approve all tools. Without this, non-interactive
    // mode defaults to auto-deny, which causes a slow deny→retry loop that
    // easily exceeds the process timeout.
    args.push('--profile', 'full');

    return args;
  }

  private async spawnProcess(
    args: string[],
    message: string,
    config: ClaudeRunnerConfig
  ): Promise<{
    responses: ChannelResponse[];
    usage?: { contextTokens: number; inputTokens: number; outputTokens: number };
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
    } as Record<string, string>;

    // Strip CLAUDECODE to prevent nested-session detection
    delete env.CLAUDECODE;

    return new Promise((resolve, reject) => {
      const child: ChildProcess = spawn(inkBin, fullArgs, {
        cwd: config.workingDirectory,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const timeout = setTimeout(() => {
        logger.warn('ink chat process timed out, killing', { timeout: PROCESS_TIMEOUT_MS });
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000);
      }, PROCESS_TIMEOUT_MS);

      child.on('close', (code) => {
        clearTimeout(timeout);
        mcpInjection?.cleanup();

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
        clearTimeout(timeout);
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
    usage?: { contextTokens: number; inputTokens: number; outputTokens: number };
    finalTextResponse?: string;
    toolCalls: ToolCall[];
  } {
    const responses: ChannelResponse[] = [];
    const toolCalls: ToolCall[] = [];
    let finalTextResponse: string | undefined;
    let exitPhase: string | undefined;
    let exitSignal: string | undefined;
    let exitReason: string | undefined;

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
      });
    }

    return {
      responses,
      finalTextResponse,
      toolCalls,
    };
  }
}
