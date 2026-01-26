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
} from '../types';

interface ClaudeStreamMessage {
  type: 'system' | 'assistant' | 'result' | 'user' | 'error';
  subtype?: string;
  session_id?: string;
  result?: string;
  message?: {
    content: Array<{ type: string; text?: string }>;
  };
  total_cost_usd?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  is_error?: boolean;
}

export interface ClaudeCodeConfig extends BackendConfig {
  type: 'claude-code';
  mcpConfigPath?: string;
  workingDirectory?: string;
  model?: string;
  systemPrompt?: string;
  timeout?: number;
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

    logger.info(`Sending message to Claude Code [${message.channel}]: ${message.content.substring(0, 100)}...`);

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

      logger.debug(`Spawning Claude Code: claude ${args.join(' ').substring(0, 200)}...`);

      const proc = spawn('claude', args, {
        cwd: this.config.workingDirectory,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.process = proc;
      let responseContent = '';
      let outputBuffer = '';

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
            }

            // Capture response text
            if (parsed.type === 'assistant' && parsed.message?.content) {
              for (const block of parsed.message.content) {
                if (block.type === 'text' && block.text) {
                  responseContent += block.text;
                  this.emit('text', block.text);
                }
              }
            }

            // Handle result
            if (parsed.type === 'result') {
              this.emit('result', {
                success: !parsed.is_error,
                content: parsed.result || responseContent,
                sessionId: parsed.session_id || this.sessionId,
                cost: parsed.total_cost_usd,
                usage: parsed.usage,
              });

              // If we have a pending message, emit the response for routing
              if (this.pendingMessage && (parsed.result || responseContent)) {
                const finalContent = parsed.result || responseContent;
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
        logger.debug('Claude Code stderr:', data.toString());
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

  private buildArgs(): string[] {
    const args = [
      '--output-format', 'stream-json',
      '--verbose',
    ];

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

    // Channel indicator
    parts.push(`[Channel: ${message.channel}]`);

    // Conversation context
    if (message.conversationId) {
      parts.push(`[Conversation: ${message.conversationId}]`);
    }

    // Sender info
    if (message.sender.name) {
      parts.push(`[From: ${message.sender.name}]`);
    }

    // The actual message
    parts.push('');
    parts.push(message.content);

    return parts.join('\n');
  }

}

/**
 * Create a Claude Code backend instance
 */
export function createClaudeCodeBackend(config?: Partial<ClaudeCodeConfig>): ClaudeCodeBackend {
  return new ClaudeCodeBackend(config);
}
