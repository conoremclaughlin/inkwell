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

const PROCESS_TIMEOUT_MS = parseInt(process.env.INK_PROCESS_TIMEOUT_MS || '', 10) || 30 * 60 * 1000;

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
    let sessionId = backendSessionId || randomUUID();

    let fullMessage = message;
    if (injectedContext && !isResume) {
      const contextBlock = formatInjectedContext(injectedContext);
      fullMessage = `${contextBlock}\n\n---\n\n${message}`;
    }

    let args = this.buildArgs(sessionId, isResume, config);

    logger.info('Spawning ink chat (non-interactive)', {
      sessionId,
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
        sessionId = randomUUID();
        args = this.buildArgs(sessionId, false, config);

        if (injectedContext) {
          const contextBlock = formatInjectedContext(injectedContext);
          fullMessage = `${contextBlock}\n\n---\n\n${message}`;
        }

        const retryResult = await this.spawnProcess(args, fullMessage, config);
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

  private buildArgs(sessionId: string, isResume: boolean, config: ClaudeRunnerConfig): string[] {
    const args: string[] = ['chat', '--non-interactive'];

    if (config.agentId) {
      args.push('--agent', config.agentId);
    }

    if (isResume) {
      args.push('--session-id', sessionId);
    }

    if (config.model) {
      args.push('--model', config.model);
    }

    // Max turns: let the ink runtime handle multi-turn tool loops
    args.push('--max-turns', '25');

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
    let finalTextResponse = '';

    // ink chat --non-interactive outputs the assistant's response to stdout.
    // Parse any structured JSON lines if present, otherwise treat as plain text.
    const lines = stdout.split('\n');
    const textLines: string[] = [];

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
        } else if (parsed.type === 'usage') {
          // Will be handled if present
        } else {
          textLines.push(line);
        }
      } catch {
        textLines.push(line);
      }
    }

    finalTextResponse = textLines.join('\n').trim();

    return {
      responses,
      finalTextResponse: finalTextResponse || undefined,
      toolCalls,
    };
  }
}
