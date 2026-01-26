/**
 * Session Host
 *
 * The main orchestrator that connects:
 * - Input channels (Telegram, terminal, HTTP, etc.)
 * - Agent backends (Claude Code, Direct API)
 * - Response routing via MCP tools
 * - Context persistence
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import type { DataComposer } from '../data/composer';
import type { AgentMessage, AgentResponse, ChannelType, ResponseHandler } from './types';
import { BackendManager, createBackendManager, BackendManagerConfig } from './backend-manager';
import { setResponseCallback, addPendingMessage } from '../mcp/tools/response-handlers';

export interface ChannelSender {
  sendMessage(conversationId: string, content: string, options?: {
    replyToMessageId?: string;
    format?: string;
  }): Promise<void>;
}

export interface SessionHostConfig {
  /** Backend manager configuration */
  backend: Partial<BackendManagerConfig>;
  /** Data composer for persistence */
  dataComposer: DataComposer;
  /** Channel senders for routing responses */
  channels?: Partial<Record<ChannelType, ChannelSender>>;
}

export class SessionHost extends EventEmitter {
  private backendManager: BackendManager;
  private channels: Map<ChannelType, ChannelSender> = new Map();
  private dataComposer: DataComposer;
  private messageCounter = 0;

  constructor(config: SessionHostConfig) {
    super();
    this.dataComposer = config.dataComposer;

    // Create backend manager
    this.backendManager = createBackendManager(config.backend);

    // Register channels
    if (config.channels) {
      for (const [channel, sender] of Object.entries(config.channels)) {
        if (sender) {
          this.channels.set(channel as ChannelType, sender);
        }
      }
    }

    // Setup event forwarding from backend manager
    this.setupBackendEvents();
  }

  /**
   * Initialize the session host
   */
  async initialize(): Promise<void> {
    logger.info('Initializing Session Host...');

    // Register the response callback for MCP send_response tool
    setResponseCallback(this.handleResponse.bind(this));

    // Initialize backend manager
    await this.backendManager.initialize();

    // Set response handler on backend manager too
    this.backendManager.setResponseHandler(this.handleResponse.bind(this));

    logger.info('Session Host initialized', {
      backend: this.backendManager.getActiveBackendType(),
      channels: Array.from(this.channels.keys()),
    });

    this.emit('ready');
  }

  /**
   * Shutdown the session host
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down Session Host...');

    await this.backendManager.shutdown();

    logger.info('Session Host shutdown complete');
    this.emit('shutdown');
  }

  /**
   * Register a channel sender
   */
  registerChannel(channel: ChannelType, sender: ChannelSender): void {
    this.channels.set(channel, sender);
    logger.info(`Channel registered: ${channel}`);
  }

  /**
   * Handle an incoming message from any channel
   */
  async handleMessage(
    channel: ChannelType,
    conversationId: string,
    sender: { id: string; name?: string },
    content: string,
    options?: {
      userId?: string;
      projectId?: string;
      sessionId?: string;
      replyToMessageId?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    this.messageCounter++;
    const messageId = `msg-${Date.now()}-${this.messageCounter}`;

    const message: AgentMessage = {
      id: messageId,
      channel,
      conversationId,
      sender,
      content,
      timestamp: new Date(),
      context: {
        userId: options?.userId,
        projectId: options?.projectId,
        sessionId: options?.sessionId,
        replyToMessageId: options?.replyToMessageId,
      },
      metadata: options?.metadata,
    };

    logger.info(`Handling message from ${channel}:${conversationId}`, {
      messageId,
      sender: sender.id,
      contentPreview: content.substring(0, 50),
    });

    // Add to pending messages for cross-channel visibility
    addPendingMessage({
      id: messageId,
      channel,
      conversationId,
      sender,
      content,
      timestamp: new Date(),
      read: false,
    });

    // Persist the incoming message
    await this.persistMessage(message, 'user');

    // Send to the agent backend
    try {
      await this.backendManager.sendMessage(message);
      this.emit('message:sent', message);
    } catch (error) {
      logger.error('Error sending message to backend:', error);
      this.emit('message:error', { message, error });

      // Send error response back to channel
      const errorContent = 'Sorry, I encountered an error processing your message. Please try again.';
      await this.sendToChannel(channel, conversationId, errorContent);
    }
  }

  /**
   * Handle a response from the agent (via MCP send_response tool)
   */
  private handleResponse: ResponseHandler = async (response: AgentResponse) => {
    logger.info(`Routing response to ${response.channel}:${response.conversationId}`, {
      contentLength: response.content.length,
      format: response.format,
    });

    // Send to the appropriate channel
    await this.sendToChannel(
      response.channel,
      response.conversationId,
      response.content,
      {
        replyToMessageId: response.replyToMessageId,
        format: response.format,
      }
    );

    // Persist the response
    await this.persistResponse(response);

    this.emit('response:sent', response);
  };

  /**
   * Send a message to a specific channel
   */
  private async sendToChannel(
    channel: ChannelType,
    conversationId: string,
    content: string,
    options?: {
      replyToMessageId?: string;
      format?: string;
    }
  ): Promise<void> {
    const sender = this.channels.get(channel);

    if (!sender) {
      logger.warn(`No sender registered for channel: ${channel}`);
      // Emit event so external handlers can pick it up
      this.emit('response:unrouted', { channel, conversationId, content, options });
      return;
    }

    try {
      await sender.sendMessage(conversationId, content, options);
      logger.info(`Response sent to ${channel}:${conversationId}`);
    } catch (error) {
      logger.error(`Failed to send to ${channel}:`, error);
      this.emit('response:error', { channel, conversationId, content, error });
    }
  }

  /**
   * Map channel type to platform for persistence
   * Some channels (http, terminal) map to 'api' for storage
   */
  private mapChannelToPlatform(channel: ChannelType): string {
    switch (channel) {
      case 'http':
      case 'terminal':
      case 'api':
        return 'api';
      default:
        return channel;
    }
  }

  /**
   * Persist an incoming message
   */
  private async persistMessage(message: AgentMessage, _type: 'user' | 'assistant'): Promise<void> {
    try {
      const platform = this.mapChannelToPlatform(message.channel);

      // Get or create conversation
      let conversation = await this.dataComposer.repositories.conversations
        .findConversationByPlatformId(platform, message.conversationId);

      if (!conversation && message.context?.userId) {
        conversation = await this.dataComposer.repositories.conversations.createConversation({
          user_id: message.context.userId,
          // Cast to any to handle extended channel types not in the Platform enum
          platform: platform as never,
          platform_conversation_id: message.conversationId,
        });
      }

      if (conversation && message.context?.userId) {
        await this.dataComposer.repositories.conversations.createMessage({
          conversation_id: conversation.id,
          user_id: message.context.userId,
          content: message.content,
          message_type: 'text', // Use 'text' as default message type
          platform_message_id: message.id,
        });
      }
    } catch (error) {
      logger.error('Failed to persist message:', error);
      // Don't throw - persistence failure shouldn't block message handling
    }
  }

  /**
   * Persist an outgoing response
   */
  private async persistResponse(response: AgentResponse): Promise<void> {
    try {
      const platform = this.mapChannelToPlatform(response.channel);

      const conversation = await this.dataComposer.repositories.conversations
        .findConversationByPlatformId(platform, response.conversationId);

      if (conversation) {
        await this.dataComposer.repositories.conversations.createMessage({
          conversation_id: conversation.id,
          user_id: conversation.user_id,
          content: response.content,
          message_type: 'text', // Use 'text' as default message type
        });
      }
    } catch (error) {
      logger.error('Failed to persist response:', error);
    }
  }

  /**
   * Get backend health information
   */
  getHealth(): {
    ready: boolean;
    backend: ReturnType<BackendManager['getAllHealth']>;
    channels: ChannelType[];
  } {
    return {
      ready: this.backendManager.getActiveBackend()?.isReady() || false,
      backend: this.backendManager.getAllHealth(),
      channels: Array.from(this.channels.keys()),
    };
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string | null {
    return this.backendManager.getSessionId();
  }

  /**
   * Switch to a different backend
   */
  async switchBackend(type: 'claude-code' | 'direct-api'): Promise<void> {
    await this.backendManager.switchBackend(type);
  }

  private setupBackendEvents(): void {
    this.backendManager.on('backend:ready', (type) => {
      this.emit('backend:ready', type);
    });

    this.backendManager.on('backend:error', (data) => {
      this.emit('backend:error', data);
    });

    this.backendManager.on('backend:exit', (data) => {
      this.emit('backend:exit', data);
    });

    this.backendManager.on('backend:failover', (type) => {
      logger.warn(`Backend failed over to: ${type}`);
      this.emit('backend:failover', type);
    });

    this.backendManager.on('text', (text) => {
      this.emit('text', text);
    });

    this.backendManager.on('result', (result) => {
      this.emit('result', result);
    });

    // Handle responses from backend (via stdout parsing)
    this.backendManager.on('response', async (response: AgentResponse) => {
      logger.info(`Received response from backend for ${response.channel}:${response.conversationId}`);
      await this.handleResponse(response);
    });
  }
}

/**
 * Create a session host instance
 */
export function createSessionHost(config: SessionHostConfig): SessionHost {
  return new SessionHost(config);
}
