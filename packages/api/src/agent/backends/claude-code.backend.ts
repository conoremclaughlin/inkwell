/**
 * Claude Code Backend
 *
 * Manages a persistent Claude Code process for fast message handling.
 * Instead of spawning per message, keeps the process alive and sends
 * messages via stdin.
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { logger } from '../../utils/logger';
import type {
  AgentBackend,
  AgentMessage,
  BackendHealth,
  BackendConfig,
  BackendType,
  InjectedContext,
} from '../types';

interface ClaudeContentBlock {
  type: string;
  text?: string;
  // tool_use blocks
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // tool_result blocks
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
}

interface ClaudeStreamMessage {
  type: 'system' | 'assistant' | 'result' | 'user' | 'error';
  subtype?: string;
  session_id?: string;
  result?: string;
  message?: {
    content: ClaudeContentBlock[];
  };
  total_cost_usd?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  is_error?: boolean;
}

export interface ClaudeCodeConfig extends BackendConfig {
  type: 'claude-code';
  mcpConfigPath?: string;
  workingDirectory?: string;
  model?: string;
  systemPrompt?: string;
  /** Appended to Claude Code's default system prompt (survives compaction/resume). */
  appendSystemPrompt?: string;
  timeout?: number;
  /** Disable auto-response emission. Set true when agent has MCP tools like send_response. */
  disableAutoResponse?: boolean;
}

const DEFAULT_CONFIG: Partial<ClaudeCodeConfig> = {
  model: 'sonnet',
  workingDirectory: process.cwd(),
  timeout: 300000, // 5 minutes for persistent session
};

export class ClaudeCodeBackend extends EventEmitter implements AgentBackend {
  readonly type: BackendType = 'claude-code';

  private config: ClaudeCodeConfig;
  private process: ChildProcess | null = null;
  private sessionId: string | null = null;
  private ready = false;
  private messageCount = 0;
  private startTime: Date | null = null;
  private lastError: string | null = null;

  // Track pending message for response routing
  private pendingMessage: AgentMessage | null = null;

  // Token tracking: per-turn for context window management, cumulative for monitoring
  private currentContextTokens = 0; // Latest turn's input tokens ≈ current context window size
  private cumulativeInputTokens = 0; // Running total across all turns (for monitoring/billing)
  private cumulativeOutputTokens = 0; // Running total across all turns

  // Temp file for system prompt
  private systemPromptFile: string | null = null;

  constructor(config: Partial<ClaudeCodeConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config, type: 'claude-code' } as ClaudeCodeConfig;
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Claude Code backend...');

    // Claude Code with stream-json requires -p mode, so we can't keep a single
    // persistent process. Instead, we initialize by marking as ready and will
    // spawn per-message with --resume to maintain session continuity.
    this.startTime = new Date();
    this.ready = true;

    // If we have a system prompt, write it to temp file now
    if (this.config.systemPrompt && !this.systemPromptFile) {
      this.systemPromptFile = join(tmpdir(), `pcp-system-prompt-${Date.now()}.md`);
      writeFileSync(this.systemPromptFile, this.config.systemPrompt, 'utf-8');
      logger.debug(`System prompt written to: ${this.systemPromptFile}`);
    }

    logger.info('Claude Code backend ready (session-based mode)');
    this.emit('ready');
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down Claude Code backend...');

    // Kill any running process
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }

    this.ready = false;
    this.cleanupTempFiles();

    this.emit('exit', 0);
  }

  async sendMessage(message: AgentMessage): Promise<void> {
    if (!this.ready) {
      throw new Error('Claude Code backend not ready');
    }

    this.pendingMessage = message;
    this.messageCount++;

    // Format message with channel context
    const formattedInput = this.formatInput(message);

    logger.info(
      `Sending message to Claude Code [${message.channel}]: ${message.content.substring(0, 100)}...`
    );

    // Spawn a Claude Code process for this message
    // Use --resume to continue the session if we have a session ID
    return this.executeMessage(formattedInput);
  }

  /**
   * Execute a message using Claude Code in -p mode
   * Returns the response content from stdout
   */
  private executeMessage(input: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = this.buildArgs();

      // Add -p flag for print mode (required for stream-json)
      args.unshift('-p');

      logger.info(`Spawning Claude Code with args: ${args.join(' ')}`);

      // Strip CLAUDECODE to prevent "nested session" detection when PCP is
      // launched from inside a Claude Code session (e.g., via PM2).
      const { CLAUDECODE, ...cleanEnv } = process.env;
      const proc = spawn('claude', args, {
        cwd: this.config.workingDirectory,
        env: cleanEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.process = proc;
      let responseContent = '';
      let outputBuffer = '';
      let responseEmitted = false; // Guard against multiple response emissions

      proc.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        outputBuffer += chunk;

        // Process complete JSON lines
        const lines = outputBuffer.split('\n');
        outputBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const parsed = JSON.parse(line) as ClaudeStreamMessage;

            // Capture session ID
            if (parsed.type === 'system' && parsed.session_id) {
              this.sessionId = parsed.session_id;
              logger.info('Claude Code backend ready', { sessionId: this.sessionId });
              this.emit('session:captured', this.sessionId);
            }

            // Capture response text and tool use from assistant messages
            if (parsed.type === 'assistant' && parsed.message?.content) {
              for (const block of parsed.message.content) {
                if (block.type === 'text' && block.text) {
                  responseContent += block.text;
                  this.emit('text', block.text);
                } else if (block.type === 'tool_use' && block.name) {
                  this.emit('tool:call', {
                    toolUseId: block.id,
                    toolName: block.name,
                    input: block.input || {},
                  });
                }
              }
            }

            // Capture tool results from user messages (Claude Code feeds these back)
            if (parsed.type === 'user' && parsed.message?.content) {
              for (const block of parsed.message.content) {
                if (block.type === 'tool_result' && block.tool_use_id) {
                  const resultContent =
                    typeof block.content === 'string'
                      ? block.content
                      : Array.isArray(block.content)
                        ? block.content
                            .filter((b) => b.type === 'text')
                            .map((b) => b.text)
                            .join('')
                        : '';
                  this.emit('tool:result', {
                    toolUseId: block.tool_use_id,
                    content: resultContent,
                  });
                }
              }
            }

            // Handle result
            if (parsed.type === 'result') {
              // Track token usage for context window management.
              // With --resume, each turn's input includes the full conversation, so
              // messageInputTokens ≈ current context window size.
              // Claude Code uses prompt caching, so full context window tokens =
              //   input_tokens (non-cached) + cache_read + cache_creation
              if (parsed.usage) {
                const messageInputTokens =
                  parsed.usage.input_tokens +
                  (parsed.usage.cache_read_input_tokens ?? 0) +
                  (parsed.usage.cache_creation_input_tokens ?? 0);
                const messageOutputTokens = parsed.usage.output_tokens;
                // Current context window = this turn's total input (NOT cumulative)
                this.currentContextTokens = messageInputTokens;
                this.cumulativeInputTokens += messageInputTokens;
                this.cumulativeOutputTokens += messageOutputTokens;
                this.emit('session:usage', {
                  // Context window size (for compaction decisions)
                  contextTokens: this.currentContextTokens,
                  // Cumulative totals (for monitoring/billing)
                  cumulativeInputTokens: this.cumulativeInputTokens,
                  cumulativeOutputTokens: this.cumulativeOutputTokens,
                  // Per-turn breakdown
                  messageInputTokens,
                  messageOutputTokens,
                });
              }

              this.emit('result', {
                success: !parsed.is_error,
                content: parsed.result || responseContent,
                sessionId: parsed.session_id || this.sessionId,
                cost: parsed.total_cost_usd,
                usage: parsed.usage,
              });

              // If we have a pending message AND auto-response is enabled, emit the response ONCE
              // Note: When MCP tools (like send_response) are available, disable this to avoid duplicates
              // Guard: Only emit response once per message to prevent duplicates from multiple 'result' events
              // Internal messages (compaction, system) should never trigger auto-response
              const isInternalMessage = this.pendingMessage?.metadata?.isInternal === true;
              if (
                !responseEmitted &&
                !this.config.disableAutoResponse &&
                !isInternalMessage &&
                this.pendingMessage &&
                (parsed.result || responseContent)
              ) {
                responseEmitted = true;
                const finalContent = parsed.result || responseContent;
                logger.info(
                  `Emitting auto-response for ${this.pendingMessage.channel}:${this.pendingMessage.conversationId}`
                );
                this.emit('response', {
                  channel: this.pendingMessage.channel,
                  conversationId: this.pendingMessage.conversationId,
                  content: finalContent,
                });
              }
            }
          } catch {
            // Not JSON, ignore
          }
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const stderrMsg = data.toString();
        // Log errors at info level so they're visible
        if (
          stderrMsg.includes('error') ||
          stderrMsg.includes('Error') ||
          stderrMsg.includes('failed')
        ) {
          logger.info('Claude Code stderr (error):', stderrMsg);
        } else {
          logger.debug('Claude Code stderr:', stderrMsg);
        }
      });

      // Set timeout
      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Claude Code timed out after ${this.config.timeout}ms`));
      }, this.config.timeout || 300000);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this.process = null;

        if (code !== 0) {
          logger.warn(`Claude Code exited with code ${code}`);
        }

        // Fallback: if we accumulated response text but never got a `result` event,
        // emit the response now so it reaches the channel (e.g., Telegram).
        // This handles cases where Claude Code exits before streaming the result JSON.
        const isInternalMessage = this.pendingMessage?.metadata?.isInternal === true;
        if (
          !responseEmitted &&
          !this.config.disableAutoResponse &&
          !isInternalMessage &&
          this.pendingMessage &&
          responseContent.trim()
        ) {
          responseEmitted = true;
          logger.warn('Claude Code exited without result event — emitting fallback auto-response', {
            channel: this.pendingMessage.channel,
            conversationId: this.pendingMessage.conversationId,
            contentLength: responseContent.length,
            exitCode: code,
          });
          this.emit('response', {
            channel: this.pendingMessage.channel,
            conversationId: this.pendingMessage.conversationId,
            content: responseContent,
          });
        }

        this.pendingMessage = null;
        resolve();
      });

      proc.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      // Send the input and close stdin
      proc.stdin?.write(input);
      proc.stdin?.end();
    });
  }

  isReady(): boolean {
    return this.ready; // In session-based mode, we're ready if initialized
  }

  getHealth(): BackendHealth {
    return {
      healthy: this.ready, // In session-based mode, we don't need a persistent process
      lastCheck: new Date(),
      sessionId: this.sessionId || undefined,
      uptime: this.startTime ? Date.now() - this.startTime.getTime() : undefined,
      messageCount: this.messageCount,
      error: this.lastError || undefined,
      currentContextTokens: this.currentContextTokens,
      cumulativeInputTokens: this.cumulativeInputTokens,
      cumulativeOutputTokens: this.cumulativeOutputTokens,
    };
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async resumeSession(sessionId: string): Promise<boolean> {
    if (this.process) {
      // Can't change session while running
      logger.warn('Cannot resume session while process is running');
      return false;
    }

    this.sessionId = sessionId;
    await this.initialize();
    return true;
  }

  /**
   * Get the current pending message (for response routing)
   */
  getPendingMessage(): AgentMessage | null {
    return this.pendingMessage;
  }

  /**
   * Clear the pending message after response is sent
   */
  clearPendingMessage(): void {
    this.pendingMessage = null;
  }

  /**
   * Clear the session ID, forcing a new session on next message.
   * Also resets token counters since we're starting fresh.
   */
  clearSession(): void {
    this.sessionId = null;
    this.currentContextTokens = 0;
    this.cumulativeInputTokens = 0;
    this.cumulativeOutputTokens = 0;
  }

  private buildArgs(): string[] {
    const args = ['--output-format', 'stream-json', '--verbose'];

    if (this.config.model) {
      args.push('--model', this.config.model);
    }

    if (this.config.mcpConfigPath) {
      args.push('--mcp-config', this.config.mcpConfigPath);
    }

    if (this.config.systemPrompt) {
      // Write system prompt to a temp file to avoid shell escaping issues
      this.systemPromptFile = join(tmpdir(), `pcp-system-prompt-${Date.now()}.md`);
      writeFileSync(this.systemPromptFile, this.config.systemPrompt, 'utf-8');
      args.push('--system-prompt', this.systemPromptFile);
      logger.debug(`System prompt written to: ${this.systemPromptFile}`);
    }

    if (this.config.appendSystemPrompt) {
      // --append-system-prompt is re-injected on every invocation (including --resume),
      // so it survives compaction. Use this for identity and critical directives.
      const appendFile = join(tmpdir(), `pcp-append-prompt-${Date.now()}.md`);
      writeFileSync(appendFile, this.config.appendSystemPrompt, 'utf-8');
      args.push('--append-system-prompt', appendFile);
      logger.debug(`Append system prompt written to: ${appendFile}`);
    }

    if (this.sessionId) {
      args.push('--resume', this.sessionId);
    }

    return args;
  }

  /**
   * Clean up temp files
   */
  private cleanupTempFiles(): void {
    if (this.systemPromptFile && existsSync(this.systemPromptFile)) {
      try {
        unlinkSync(this.systemPromptFile);
        logger.debug(`Cleaned up system prompt file: ${this.systemPromptFile}`);
      } catch (error) {
        logger.warn(`Failed to clean up system prompt file: ${error}`);
      }
      this.systemPromptFile = null;
    }
  }

  private formatInput(message: AgentMessage): string {
    // Include channel context so Claude knows where the message came from
    const parts: string[] = [];

    // Inject context based on session state
    // - New session (no sessionId): Full context (identity, user, projects, memories)
    // - Resuming session: Minimal context (just time + brief identity reminder)
    if (message.injectedContext) {
      const isResuming = !!this.sessionId;
      logger.debug(
        `Context injection: ${isResuming ? 'MINIMAL (resuming)' : 'FULL (new session)'}`,
        {
          sessionId: this.sessionId,
          hasIdentity: !!message.injectedContext.agentIdentity,
        }
      );
      if (isResuming) {
        parts.push(this.formatMinimalContext(message.injectedContext));
      } else {
        parts.push(this.formatInjectedContext(message.injectedContext));
      }
      parts.push('');
    }

    // Channel indicator
    parts.push(`[Channel: ${message.channel}]`);

    // Chat type (important for group behavior)
    if (message.chatType) {
      parts.push(`[Chat Type: ${message.chatType}]`);
    }

    // Conversation context
    if (message.conversationId) {
      parts.push(`[Conversation: ${message.conversationId}]`);
    }

    // Sender info
    if (message.sender.name) {
      parts.push(`[From: ${message.sender.name}]`);
    }

    // Mention info (for group chats)
    if (message.mentions) {
      parts.push(`[Bot Mentioned: ${message.mentions.botMentioned ? 'yes' : 'no'}]`);
      if (message.mentions.users.length > 0) {
        parts.push(`[Mentions: ${message.mentions.users.join(', ')}]`);
      }
    }

    // Media attachments
    if (message.media && message.media.length > 0) {
      parts.push('');
      parts.push('[Attachments]');
      for (const attachment of message.media) {
        if (attachment.type === 'image' && attachment.path) {
          parts.push(`- Image: ${attachment.path}`);
          parts.push('  (Use the Read tool to view and analyze this image)');
        } else if (attachment.type === 'image' && attachment.url) {
          parts.push(`- Image URL: ${attachment.url}`);
        } else if (attachment.path) {
          parts.push(`- ${attachment.type}: ${attachment.path}`);
        }
      }
    }

    // The actual message
    parts.push('');
    parts.push(message.content);

    return parts.join('\n');
  }

  /**
   * Format injected context into a readable block for Claude
   */
  private formatInjectedContext(context: InjectedContext): string {
    const sections: string[] = [];
    sections.push('<user-context>');

    // Agent identity - who am I?
    if (context.agentIdentity) {
      sections.push('## My Identity');
      sections.push(`I am **${context.agentIdentity.name}** (${context.agentIdentity.agentId})`);
      sections.push(`Role: ${context.agentIdentity.role}`);
      if (context.agentIdentity.description) {
        sections.push(context.agentIdentity.description);
      }
      if (context.agentIdentity.values && context.agentIdentity.values.length > 0) {
        sections.push(`Values: ${context.agentIdentity.values.join(', ')}`);
      }
      if (context.agentIdentity.capabilities && context.agentIdentity.capabilities.length > 0) {
        sections.push(`Capabilities: ${context.agentIdentity.capabilities.join(', ')}`);
      }
      sections.push('');
    }

    // Temporal context (current time)
    if (context.temporal) {
      sections.push('## Current Time');
      sections.push(`**${context.temporal.localTime}**`);
      sections.push(`Timezone: ${context.temporal.userTimezone}`);
      sections.push(`UTC: ${context.temporal.currentTimeUtc}`);
      sections.push('');
    }

    // User info
    if (context.user) {
      sections.push('## User');
      if (context.user.summary) {
        sections.push(context.user.summary);
      }
      sections.push(`User ID: ${context.user.id}`);
    }

    // Relationship
    if (context.relationship?.summary) {
      sections.push('');
      sections.push('## Our Relationship');
      sections.push(context.relationship.summary);
    }

    // Active projects
    if (context.activeProjects && context.activeProjects.length > 0) {
      sections.push('');
      sections.push('## Active Projects');
      for (const project of context.activeProjects) {
        sections.push(`- **${project.name}** (${project.status})`);
        if (project.description) {
          sections.push(`  ${project.description}`);
        }
      }
    }

    // Current focus
    if (context.currentFocus?.summary) {
      sections.push('');
      sections.push('## Current Focus');
      sections.push(context.currentFocus.summary);
    }

    // Recent memories
    if (context.recentMemories && context.recentMemories.length > 0) {
      sections.push('');
      sections.push('## Recent Context');
      for (const memory of context.recentMemories) {
        const topics = memory.topics.length > 0 ? ` [${memory.topics.join(', ')}]` : '';
        sections.push(
          `- ${memory.content.substring(0, 200)}${memory.content.length > 200 ? '...' : ''}${topics}`
        );
      }
    }

    // Recent conversation history (provides continuity across session rotations)
    if (context.conversationHistory && context.conversationHistory.length > 0) {
      sections.push('');
      sections.push('## Recent Conversation');
      sections.push('Recent messages from the activity stream (for continuity):');
      for (const msg of context.conversationHistory) {
        const direction = msg.direction === 'in' ? 'User' : 'You';
        const time = new Date(msg.timestamp).toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
        });
        const preview =
          msg.content.length > 300 ? msg.content.substring(0, 300) + '...' : msg.content;
        sections.push(`- [${time}] ${direction}: ${preview}`);
      }
    }

    // Recovery hint
    sections.push('');
    sections.push('## Context Recovery');
    sections.push(
      'If you need more context from previous conversations, use `recall` to search memories or `get_inbox` to check for recent messages from other agents.'
    );

    sections.push('</user-context>');
    return sections.join('\n');
  }

  /**
   * Format minimal context for resuming sessions
   * Includes time, identity reminder, and recent conversation for safety
   */
  private formatMinimalContext(context: InjectedContext): string {
    const parts: string[] = [];
    parts.push('<context-update>');

    // Brief identity reminder (one line)
    if (context.agentIdentity) {
      parts.push(`[I am ${context.agentIdentity.name}]`);
    }

    // Current time (always include - it changes!)
    if (context.temporal) {
      parts.push(`[Time: ${context.temporal.localTime}]`);
    }

    parts.push('</context-update>');
    return parts.join('\n');
  }
}

/**
 * Create a Claude Code backend instance
 */
export function createClaudeCodeBackend(config?: Partial<ClaudeCodeConfig>): ClaudeCodeBackend {
  return new ClaudeCodeBackend(config);
}
