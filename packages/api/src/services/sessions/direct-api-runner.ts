/**
 * Direct API Runner
 *
 * Implements IRunner using the Anthropic API directly with Pi coding tools.
 * Unlike CLI runners (Claude/Codex/Gemini), this calls the API in-process
 * with a proper tool execution loop — tool results are fed back to continue
 * the conversation until the model emits end_turn.
 */

import Anthropic from '@anthropic-ai/sdk';
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
import { buildIdentityPrompt } from './claude-runner.js';
import { logger } from '../../utils/logger.js';
import {
  createInkCodingTools,
  type InkToolDefinition,
  type PiCodingToolsConfig,
} from '../../agent/tools/pi-coding-tools.js';

const MAX_TOOL_ITERATIONS = 50;
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = 16384;

export interface DirectApiRunnerConfig {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  /** Pi coding tools config — if omitted, tools are loaded with cwd from runner config */
  piToolsConfig?: Partial<PiCodingToolsConfig>;
  /** Additional tools to register alongside Pi coding tools */
  extraTools?: Anthropic.Tool[];
}

export class DirectApiRunner implements IRunner {
  private client: Anthropic | null = null;
  private runnerConfig: DirectApiRunnerConfig;
  private toolsCache: Map<string, InkToolDefinition[]> = new Map();

  constructor(config: DirectApiRunnerConfig = {}) {
    this.runnerConfig = config;
  }

  async run(
    message: string,
    options: {
      backendSessionId?: string;
      injectedContext?: InjectedContext;
      config: ClaudeRunnerConfig;
    }
  ): Promise<RunnerResult> {
    const { injectedContext, config } = options;

    this.ensureClient();

    // Build system prompt
    const systemPrompt = this.buildSystemPrompt(config, injectedContext);

    // Build user message with context injection (first turn only)
    let fullMessage = message;
    if (injectedContext && !options.backendSessionId) {
      const contextBlock = formatInjectedContext(injectedContext);
      fullMessage = `${contextBlock}\n\n---\n\n${message}`;
    }

    // Load Pi coding tools scoped to the working directory
    const tools = await this.getTools(config.workingDirectory, config.sandboxBypass);
    const toolSchemas: Anthropic.Tool[] = tools.map((t) => t.schema);
    if (this.runnerConfig.extraTools) {
      toolSchemas.push(...this.runnerConfig.extraTools);
    }

    // Build executor map for fast lookup
    const executorMap = new Map<string, InkToolDefinition['execute']>();
    for (const tool of tools) {
      executorMap.set(tool.schema.name, tool.execute);
    }

    // Run the agentic loop
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: fullMessage }];
    const responses: ChannelResponse[] = [];
    const toolCalls: ToolCall[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let finalTextResponse = '';
    let backendSessionId = options.backendSessionId || `direct-api-${Date.now()}`;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await this.client!.messages.create({
        model: this.runnerConfig.model || config.model || DEFAULT_MODEL,
        max_tokens: this.runnerConfig.maxTokens || DEFAULT_MAX_TOKENS,
        system: systemPrompt,
        messages,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
      });

      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;

      // Collect text and tool_use blocks
      const textParts: string[] = [];
      const toolUseBlocks: Anthropic.ToolUseBlock[] = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolUseBlocks.push(block);
        }
      }

      if (textParts.length > 0) {
        finalTextResponse = textParts.join('');
      }

      // Check for send_response in tool calls
      for (const toolUse of toolUseBlocks) {
        const input = toolUse.input as Record<string, unknown>;
        toolCalls.push({
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          input,
        });

        if (toolUse.name === 'send_response' || toolUse.name === 'mcp__inkwell__send_response') {
          const channel = (input.channel as ChannelType) || 'api';
          const conversationId = input.conversationId as string | undefined;
          const content = input.content as string | undefined;
          if (content) {
            responses.push({
              channel,
              conversationId: conversationId || '',
              content,
              format: input.format as ChannelResponse['format'],
            });
          }
        }
      }

      // If no tool use, we're done
      if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
        break;
      }

      // Execute tools and build tool_result messages
      // Add assistant turn with the full content (text + tool_use)
      messages.push({ role: 'assistant', content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        const executor = executorMap.get(toolUse.name);
        let resultText: string;

        if (executor) {
          try {
            resultText = await executor(toolUse.input as Record<string, unknown>);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.error(`Direct API runner: tool ${toolUse.name} threw`, { error: errMsg });
            resultText = `Error: ${errMsg}`;
          }
        } else {
          resultText = `Error: Tool "${toolUse.name}" not available in this runtime. Available tools: ${Array.from(executorMap.keys()).join(', ')}`;
          logger.warn(`Direct API runner: unknown tool "${toolUse.name}" requested`);
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: resultText,
        });
      }

      // Add tool results as user turn
      messages.push({ role: 'user', content: toolResults });

      logger.debug('Direct API runner: tool iteration complete', {
        iteration,
        toolsExecuted: toolUseBlocks.map((t) => t.name),
      });
    }

    return {
      success: true,
      backendSessionId,
      responses,
      usage: {
        contextTokens: 0,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      },
      finalTextResponse: finalTextResponse || undefined,
      toolCalls,
    };
  }

  private ensureClient(): void {
    if (this.client) return;
    const apiKey = this.runnerConfig.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is required for Direct API runner');
    }
    this.client = new Anthropic({ apiKey });
  }

  private async getTools(cwd: string, sandboxBypass?: boolean): Promise<InkToolDefinition[]> {
    const cacheKey = `${cwd}:${sandboxBypass ? 'bypass' : 'sandbox'}`;
    if (this.toolsCache.has(cacheKey)) {
      return this.toolsCache.get(cacheKey)!;
    }

    const piConfig: PiCodingToolsConfig = {
      cwd,
      bashSandboxBypass: sandboxBypass,
      ...this.runnerConfig.piToolsConfig,
    };

    const tools = await createInkCodingTools(piConfig);
    this.toolsCache.set(cacheKey, tools);
    return tools;
  }

  private buildSystemPrompt(config: ClaudeRunnerConfig, context?: InjectedContext): string {
    const parts: string[] = [];

    // Identity prompt (same as CLI runners)
    if (config.agentId && context?.agent) {
      parts.push(
        buildIdentityPrompt(
          config.agentId,
          context.agent.name,
          context.agent.soul,
          context.user?.timezone,
          context.agent.heartbeat,
          {
            pcpSessionId: config.pcpSessionId,
            studioId: config.studioId,
          }
        )
      );
    }

    // System prompt from config
    if (config.systemPrompt) {
      parts.push(config.systemPrompt);
    }
    if (config.appendSystemPrompt) {
      parts.push(config.appendSystemPrompt);
    }

    // Coding tools context
    parts.push(`## Coding Tools

You have filesystem access scoped to: ${config.workingDirectory}

Available tools: read, write, edit, bash, grep, find, ls
All file paths are resolved relative to the working directory. Access outside this directory is blocked.`);

    return parts.join('\n\n');
  }
}
