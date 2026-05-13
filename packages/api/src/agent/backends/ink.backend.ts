/**
 * Ink Backend
 *
 * Uses the Anthropic API directly instead of Claude Code CLI.
 * Useful for cloud deployments where CLI isn't available.
 */

import Anthropic from '@anthropic-ai/sdk';
import { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import type {
  AgentBackend,
  AgentMessage,
  BackendHealth,
  BackendConfig,
  BackendType,
  ResponseHandler,
} from '../types';

export interface InkConfig extends BackendConfig {
  type: 'ink';
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  systemPrompt?: string;
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

const DEFAULT_CONFIG: Partial<InkConfig> = {
  model: 'claude-sonnet-4-20250514',
  maxTokens: 4096,
};

export class InkBackend extends EventEmitter implements AgentBackend {
  readonly type: BackendType = 'ink';

  private config: InkConfig;
  private client: Anthropic | null = null;
  private ready = false;
  private messageCount = 0;
  private startTime: Date | null = null;
  private lastError: string | null = null;
  private sessionId: string | null = null;

  // Conversation history for context
  private conversationHistory: Map<string, ConversationMessage[]> = new Map();

  // Response handler for MCP-style responses
  private responseHandler: ResponseHandler | null = null;

  // MCP tools definition (simplified for API calls)
  private tools: Anthropic.Tool[] = [];

  constructor(config: Partial<InkConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config, type: 'ink' } as InkConfig;
  }

  /**
   * Register the response handler (called by session host)
   */
  setResponseHandler(handler: ResponseHandler): void {
    this.responseHandler = handler;
  }

  /**
   * Register MCP tools for the API to use
   */
  setTools(tools: Anthropic.Tool[]): void {
    this.tools = tools;
  }

  async initialize(): Promise<void> {
    if (this.client) {
      logger.warn('Ink backend already initialized');
      return;
    }

    logger.info('Initializing Ink backend...');

    const apiKey = this.config.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is required for Ink backend');
    }

    this.client = new Anthropic({ apiKey });
    this.sessionId = `ink-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.startTime = new Date();
    this.ready = true;

    this.emit('ready');
    logger.info('Ink backend ready', { sessionId: this.sessionId });
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down Ink backend...');
    this.client = null;
    this.ready = false;
    this.conversationHistory.clear();
    this.emit('exit', 0);
  }

  async sendMessage(message: AgentMessage): Promise<void> {
    if (!this.client || !this.ready) {
      throw new Error('Ink backend not ready');
    }

    this.messageCount++;

    // Get or create conversation history
    const history = this.getConversationHistory(message.conversationId);

    // Add user message to history
    history.push({
      role: 'user',
      content: this.formatUserMessage(message),
    });

    logger.info(
      `Sending message via Ink [${message.channel}]: ${message.content.substring(0, 100)}...`
    );

    try {
      // Make API call
      const response = await this.client.messages.create({
        model: this.config.model || 'claude-sonnet-4-20250514',
        max_tokens: this.config.maxTokens || 4096,
        system: this.buildSystemPrompt(message),
        messages: history,
        tools: this.tools.length > 0 ? this.tools : undefined,
      });

      // Process the response
      await this.processResponse(response, message);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Ink error:', error);
      this.emit('error', error);
      throw error;
    }
  }

  isReady(): boolean {
    return this.ready && this.client !== null;
  }

  getHealth(): BackendHealth {
    return {
      healthy: this.ready && this.client !== null,
      lastCheck: new Date(),
      sessionId: this.sessionId || undefined,
      uptime: this.startTime ? Date.now() - this.startTime.getTime() : undefined,
      messageCount: this.messageCount,
      error: this.lastError || undefined,
    };
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async resumeSession(sessionId: string): Promise<boolean> {
    // Ink doesn't have true session resumption
    // but we can set the session ID for tracking
    this.sessionId = sessionId;
    return true;
  }

  private getConversationHistory(conversationId: string): ConversationMessage[] {
    if (!this.conversationHistory.has(conversationId)) {
      this.conversationHistory.set(conversationId, []);
    }
    return this.conversationHistory.get(conversationId)!;
  }

  private formatUserMessage(message: AgentMessage): string {
    const parts: string[] = [];

    // Channel context
    parts.push(`[Channel: ${message.channel}]`);
    if (message.sender.name) {
      parts.push(`[From: ${message.sender.name}]`);
    }
    parts.push('');
    parts.push(message.content);

    return parts.join('\n');
  }

  private buildSystemPrompt(message: AgentMessage): string {
    const parts: string[] = [];

    if (this.config.systemPrompt) {
      parts.push(this.config.systemPrompt);
      parts.push('');
    }

    // Add response instructions
    parts.push('## Response Instructions');
    parts.push(`You are responding to a message from the ${message.channel} channel.`);
    parts.push(`Conversation ID: ${message.conversationId}`);
    parts.push('');
    parts.push('When responding, use the send_response tool to send your reply.');
    parts.push('This ensures the response is routed to the correct channel.');

    return parts.join('\n');
  }

  private async processResponse(
    response: Anthropic.Message,
    originalMessage: AgentMessage
  ): Promise<void> {
    const history = this.getConversationHistory(originalMessage.conversationId);

    // Collect text content for history
    let textContent = '';

    for (const block of response.content) {
      if (block.type === 'text') {
        textContent += block.text;
        this.emit('text', block.text);
      } else if (block.type === 'tool_use') {
        // Handle tool calls
        await this.handleToolCall(block, originalMessage);
      }
    }

    // Add assistant response to history
    if (textContent) {
      history.push({
        role: 'assistant',
        content: textContent,
      });
    }

    // If no tool was called, send the text response directly
    if (
      !response.content.some((b: Anthropic.ContentBlock) => b.type === 'tool_use') &&
      textContent &&
      this.responseHandler
    ) {
      await this.responseHandler({
        channel: originalMessage.channel,
        conversationId: originalMessage.conversationId,
        content: textContent,
      });
    }

    // Emit result
    this.emit('result', {
      success: true,
      content: textContent,
      sessionId: this.sessionId || '',
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    });
  }

  private async handleToolCall(
    toolUse: Anthropic.ToolUseBlock,
    originalMessage: AgentMessage
  ): Promise<void> {
    logger.info(`Tool call: ${toolUse.name}`, toolUse.input);

    // Special handling for send_response tool
    if (toolUse.name === 'send_response' && this.responseHandler) {
      const input = toolUse.input as {
        channel?: string;
        conversationId?: string;
        content: string;
      };

      await this.responseHandler({
        channel: (input.channel as AgentMessage['channel']) || originalMessage.channel,
        conversationId: input.conversationId || originalMessage.conversationId,
        content: input.content,
      });
    }

    // Emit for external handling of other tools
    this.emit('tool_call', {
      name: toolUse.name,
      input: toolUse.input,
      id: toolUse.id,
    });
  }
}

/**
 * Create a Ink backend instance
 */
export function createInkBackend(config?: Partial<InkConfig>): InkBackend {
  return new InkBackend(config);
}
