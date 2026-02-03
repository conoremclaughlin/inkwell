/**
 * Channel Gateway
 *
 * Centralized management of messaging channel listeners (Telegram, WhatsApp).
 * The gateway is owned by the MCP Server, enabling direct message routing
 * from any agent via the send_response tool without HTTP round-trips.
 *
 * Architecture:
 * - Gateway initializes and manages all channel listeners
 * - Registers channel senders with response-handlers for direct routing
 * - Provides listener access for admin routes (QR codes, status, etc.)
 * - Session Host calls handleMessage() when processing incoming messages
 */

import { EventEmitter } from 'events';
import { createTelegramListener, TelegramListener } from './telegram-listener';
import { createWhatsAppListener, WhatsAppListener } from './whatsapp-listener';
import { setResponseCallback, type ResponseCallback } from '../mcp/tools/response-handlers';
import type { AgentResponse } from '../agent/types';
import type { DataComposer } from '../data/composer';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import telegramifyMarkdown from 'telegramify-markdown';

// Activity stream - conversation to user mapping for outbound message logging
const conversationUserMap = new Map<string, string>(); // conversationId -> userId

export interface ChannelGatewayConfig {
  /** Whether to enable Telegram listener */
  enableTelegram?: boolean;
  /** Telegram polling interval in ms */
  telegramPollingInterval?: number;
  /** Allowed Telegram chat IDs (legacy allowlist) */
  allowedTelegramChats?: string[];
  /** Whether to enable WhatsApp listener */
  enableWhatsApp?: boolean;
  /** WhatsApp account ID (default: 'default') */
  whatsappAccountId?: string;
  /** Whether to print WhatsApp QR code in terminal */
  printWhatsAppQr?: boolean;
  /** Callback when WhatsApp QR code is available */
  onWhatsAppQr?: (qr: string) => void;
  /** Message buffer delay in ms (default: 2000). Set to 0 to disable buffering. */
  messageBufferDelayMs?: number;
  /** Data composer for activity stream logging */
  dataComposer?: DataComposer;
}

export type IncomingMessageHandler = (
  channel: 'telegram' | 'whatsapp',
  conversationId: string,
  sender: { id: string; name?: string },
  content: string,
  metadata?: {
    userId?: string;
    replyToMessageId?: string;
    media?: Array<{ type: 'image' | 'video' | 'audio' | 'document'; path?: string; url?: string }>;
    chatType?: 'direct' | 'group' | 'channel';
    mentions?: { users: string[]; botMentioned: boolean };
  }
) => Promise<void>;

// Typing indicator management
const activeTypingIntervals = new Map<string, NodeJS.Timeout>();
const TYPING_INTERVAL_MS = 4000;

// Message buffering configuration
const DEFAULT_BUFFER_DELAY_MS = 2000; // Wait 2 seconds for additional messages

interface BufferedMessage {
  content: string;
  timestamp: Date;
  media?: Array<{ type: 'image' | 'video' | 'audio' | 'document'; path?: string; url?: string }>;
}

interface MessageBuffer {
  channel: 'telegram' | 'whatsapp';
  conversationId: string;
  sender: { id: string; name?: string };
  messages: BufferedMessage[];
  timer: NodeJS.Timeout;
  metadata?: {
    userId?: string;
    replyToMessageId?: string;
    chatType?: 'direct' | 'group' | 'channel';
    mentions?: { users: string[]; botMentioned: boolean };
  };
}

export class ChannelGateway extends EventEmitter {
  private telegramListener: TelegramListener | null = null;
  private whatsappListener: WhatsAppListener | null = null;
  private config: ChannelGatewayConfig;
  private messageHandler: IncomingMessageHandler | null = null;
  private dataComposer: DataComposer | null = null;
  private started = false;

  // Message buffering
  private messageBuffers: Map<string, MessageBuffer> = new Map();
  private bufferDelayMs: number;

  // Processing lock - prevents spawning multiple Claude Code processes for same conversation
  private processingConversations: Set<string> = new Set();
  private pendingBuffers: Map<string, MessageBuffer> = new Map();

  constructor(config: ChannelGatewayConfig = {}) {
    super();
    this.config = {
      enableTelegram: config.enableTelegram ?? !!env.TELEGRAM_BOT_TOKEN,
      telegramPollingInterval: config.telegramPollingInterval ?? 1000,
      enableWhatsApp: config.enableWhatsApp ?? (process.env.ENABLE_WHATSAPP === 'true'),
      whatsappAccountId: config.whatsappAccountId ?? 'default',
      printWhatsAppQr: config.printWhatsAppQr ?? true,
      messageBufferDelayMs: config.messageBufferDelayMs ?? DEFAULT_BUFFER_DELAY_MS,
      ...config,
    };
    this.bufferDelayMs = this.config.messageBufferDelayMs ?? DEFAULT_BUFFER_DELAY_MS;
    this.dataComposer = config.dataComposer ?? null;
  }

  /**
   * Set the handler for incoming messages from all channels
   */
  setMessageHandler(handler: IncomingMessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Start the channel gateway
   * Initializes and starts all enabled channel listeners
   */
  async start(): Promise<void> {
    if (this.started) {
      logger.warn('ChannelGateway already started');
      return;
    }

    logger.info('Starting ChannelGateway...');

    // Register the response callback for send_response tool
    this.registerResponseCallback();

    // Start Telegram listener
    if (this.config.enableTelegram) {
      await this.startTelegram();
    } else {
      logger.info('Telegram listener disabled');
    }

    // Start WhatsApp listener
    if (this.config.enableWhatsApp) {
      await this.startWhatsApp();
    } else {
      logger.info('WhatsApp listener disabled (set ENABLE_WHATSAPP=true to enable)');
    }

    this.started = true;
    logger.info('ChannelGateway started', {
      telegram: !!this.telegramListener,
      whatsapp: !!this.whatsappListener,
    });
  }

  /**
   * Stop the channel gateway
   */
  async stop(): Promise<void> {
    if (!this.started) return;

    logger.info('Stopping ChannelGateway...');

    // Clear all typing indicators
    for (const [conversationId, interval] of activeTypingIntervals) {
      clearInterval(interval);
      activeTypingIntervals.delete(conversationId);
    }

    // Clear all message buffers (flush them first)
    for (const [key, buffer] of this.messageBuffers) {
      clearTimeout(buffer.timer);
      await this.flushBuffer(key);
    }
    this.messageBuffers.clear();

    // Stop listeners
    if (this.telegramListener) {
      await this.telegramListener.stop();
      this.telegramListener = null;
    }

    if (this.whatsappListener) {
      await this.whatsappListener.stop();
      this.whatsappListener = null;
    }

    this.started = false;
    logger.info('ChannelGateway stopped');
  }

  // ============================================================================
  // Message Buffering
  // ============================================================================

  /**
   * Generate a buffer key for a conversation
   */
  private getBufferKey(channel: 'telegram' | 'whatsapp', conversationId: string): string {
    return `${channel}:${conversationId}`;
  }

  /**
   * Buffer an incoming message, batching rapid messages together
   */
  private bufferMessage(
    channel: 'telegram' | 'whatsapp',
    conversationId: string,
    sender: { id: string; name?: string },
    content: string,
    metadata?: {
      userId?: string;
      replyToMessageId?: string;
      media?: Array<{ type: 'image' | 'video' | 'audio' | 'document'; path?: string; url?: string }>;
      chatType?: 'direct' | 'group' | 'channel';
      mentions?: { users: string[]; botMentioned: boolean };
    }
  ): void {
    // If buffering is disabled, forward immediately
    if (this.bufferDelayMs <= 0) {
      this.forwardToHandler(channel, conversationId, sender, content, metadata);
      return;
    }

    const key = this.getBufferKey(channel, conversationId);
    const existingBuffer = this.messageBuffers.get(key);

    if (existingBuffer) {
      // Add to existing buffer and reset timer
      clearTimeout(existingBuffer.timer);
      existingBuffer.messages.push({
        content,
        timestamp: new Date(),
        media: metadata?.media,
      });

      // Keep first metadata for replyToMessageId, but merge mentions
      if (metadata?.mentions?.botMentioned) {
        existingBuffer.metadata = {
          ...existingBuffer.metadata,
          mentions: metadata.mentions,
        };
      }

      // Reset timer
      existingBuffer.timer = setTimeout(() => {
        this.flushBuffer(key);
      }, this.bufferDelayMs);

      logger.debug(`Message buffered for ${key}, total: ${existingBuffer.messages.length}`);
    } else {
      // Create new buffer
      logger.info(`Creating message buffer for ${key}, will flush in ${this.bufferDelayMs}ms`);
      const timer = setTimeout(() => {
        logger.info(`Buffer timer fired for ${key}`);
        this.flushBuffer(key).catch(err => {
          logger.error(`Error flushing buffer for ${key}:`, err);
        });
      }, this.bufferDelayMs);

      this.messageBuffers.set(key, {
        channel,
        conversationId,
        sender,
        messages: [{
          content,
          timestamp: new Date(),
          media: metadata?.media,
        }],
        timer,
        metadata: {
          userId: metadata?.userId,
          replyToMessageId: metadata?.replyToMessageId,
          chatType: metadata?.chatType,
          mentions: metadata?.mentions,
        },
      });

      logger.info(`New message buffer created for ${key}`);
    }
  }

  /**
   * Flush a message buffer, combining all messages and forwarding to handler.
   * If the conversation is already being processed, queue messages for later.
   */
  private async flushBuffer(key: string): Promise<void> {
    logger.info(`Flushing buffer for ${key}`);
    const buffer = this.messageBuffers.get(key);
    if (!buffer) {
      logger.warn(`No buffer found for ${key}`);
      return;
    }

    this.messageBuffers.delete(key);

    // Check if this conversation is already being processed
    if (this.processingConversations.has(key)) {
      // Queue these messages to be processed after current response completes
      const existingPending = this.pendingBuffers.get(key);
      if (existingPending) {
        // Merge into existing pending buffer
        existingPending.messages.push(...buffer.messages);
        logger.info(`Added ${buffer.messages.length} messages to pending buffer for ${key}`, {
          totalPending: existingPending.messages.length,
        });
      } else {
        // Create new pending buffer
        this.pendingBuffers.set(key, buffer);
        logger.info(`Queued ${buffer.messages.length} messages for ${key} (conversation already processing)`);
      }
      return;
    }

    // Mark conversation as processing
    this.processingConversations.add(key);

    // Combine all message contents
    const combinedContent = buffer.messages
      .map(m => m.content)
      .join('\n\n');

    // Combine all media
    const allMedia = buffer.messages
      .flatMap(m => m.media || []);

    logger.info(`Flushing message buffer for ${key}`, {
      messageCount: buffer.messages.length,
      contentLength: combinedContent.length,
    });

    // Forward the combined message
    await this.forwardToHandler(
      buffer.channel,
      buffer.conversationId,
      buffer.sender,
      combinedContent,
      {
        ...buffer.metadata,
        media: allMedia.length > 0 ? allMedia : undefined,
      }
    );
  }

  /**
   * Forward a message to the handler (after buffering)
   */
  private async forwardToHandler(
    channel: 'telegram' | 'whatsapp',
    conversationId: string,
    sender: { id: string; name?: string },
    content: string,
    metadata?: {
      userId?: string;
      replyToMessageId?: string;
      media?: Array<{ type: 'image' | 'video' | 'audio' | 'document'; path?: string; url?: string }>;
      chatType?: 'direct' | 'group' | 'channel';
      mentions?: { users: string[]; botMentioned: boolean };
    }
  ): Promise<void> {
    logger.info(`Forwarding message to handler: ${channel}:${conversationId}`);
    if (!this.messageHandler) {
      logger.warn('No message handler set, dropping message');
      return;
    }

    // Log incoming message to activity stream
    const userId = metadata?.userId;
    if (userId) {
      conversationUserMap.set(conversationId, userId);
    }
    if (this.dataComposer && userId) {
      try {
        const isGroupChat = metadata?.chatType === 'group' || metadata?.chatType === 'channel';
        await this.dataComposer.repositories.activityStream.logMessage({
          userId,
          agentId: 'myra',
          direction: 'in',
          content,
          platform: channel,
          platformChatId: conversationId,
          isDm: !isGroupChat,
          payload: {
            senderName: sender.name,
            senderId: sender.id,
          },
        });
      } catch (activityError) {
        logger.warn('Failed to log incoming message to activity stream:', activityError);
      }
    }

    try {
      await this.messageHandler(channel, conversationId, sender, content, metadata);
    } catch (error) {
      logger.error(`Error forwarding message to handler:`, error);
      this.stopTypingIndicator(conversationId);

      // Send error response based on channel
      try {
        if (channel === 'telegram' && this.telegramListener) {
          await this.telegramListener.sendMessage(
            conversationId,
            'Sorry, I encountered an error processing your message. Please try again.'
          );
        } else if (channel === 'whatsapp' && this.whatsappListener) {
          await this.whatsappListener.sendMessage(
            conversationId,
            'Sorry, I encountered an error processing your message. Please try again.'
          );
        }
      } catch (sendError) {
        logger.error('Failed to send error message:', sendError);
      }
    }
  }

  /**
   * Register the response callback with response-handlers
   * This enables direct message routing without HTTP round-trips
   */
  private registerResponseCallback(): void {
    const callback: ResponseCallback = async (response: AgentResponse) => {
      await this.sendResponse(response);
    };
    setResponseCallback(callback);
    logger.info('ChannelGateway registered response callback');
  }

  /**
   * Send a response to a channel
   * Called by the response callback or directly
   */
  async sendResponse(response: AgentResponse): Promise<void> {
    const { channel, conversationId, content, format, replyToMessageId } = response;

    // Stop typing indicator when sending response
    this.stopTypingIndicator(conversationId);

    switch (channel) {
      case 'telegram':
        if (!this.telegramListener) {
          throw new Error('Telegram listener not available');
        }
        await this.sendTelegramMessage(conversationId, content, { format, replyToMessageId });
        break;

      case 'whatsapp':
        if (!this.whatsappListener) {
          throw new Error('WhatsApp listener not available');
        }
        await this.whatsappListener.sendMessage(conversationId, content);
        // Log outgoing WhatsApp message to activity stream
        {
          const userId = conversationUserMap.get(conversationId);
          if (this.dataComposer && userId) {
            try {
              await this.dataComposer.repositories.activityStream.logMessage({
                userId,
                agentId: 'myra',
                direction: 'out',
                content,
                platform: 'whatsapp',
                platformChatId: conversationId,
                isDm: true,
              });
            } catch (activityError) {
              logger.warn('Failed to log outgoing WhatsApp message to activity stream:', activityError);
            }
          }
        }
        break;

      default:
        logger.warn(`Channel not supported by gateway: ${channel}`);
        throw new Error(`Channel not supported: ${channel}`);
    }

    logger.info(`Response sent via gateway to ${channel}:${conversationId}`);

    // Check for pending messages that arrived while processing
    await this.processPendingMessages(channel as 'telegram' | 'whatsapp', conversationId);
  }

  /**
   * Process any messages that were queued while the conversation was being processed.
   * This ensures messages that arrived during Claude Code processing are handled as a batch.
   */
  private async processPendingMessages(
    channel: 'telegram' | 'whatsapp',
    conversationId: string
  ): Promise<void> {
    const key = this.getBufferKey(channel, conversationId);
    const pendingBuffer = this.pendingBuffers.get(key);

    if (pendingBuffer) {
      // Remove from pending and process
      this.pendingBuffers.delete(key);

      // Combine all pending message contents
      const combinedContent = pendingBuffer.messages
        .map(m => m.content)
        .join('\n\n');

      const allMedia = pendingBuffer.messages
        .flatMap(m => m.media || []);

      logger.info(`Processing ${pendingBuffer.messages.length} pending messages for ${key}`, {
        messageCount: pendingBuffer.messages.length,
        contentLength: combinedContent.length,
      });

      // Start typing indicator for the new batch
      this.startTypingIndicator(conversationId, channel);

      // Forward to handler (conversation is still marked as processing)
      await this.forwardToHandler(
        channel,
        conversationId,
        pendingBuffer.sender,
        combinedContent,
        {
          ...pendingBuffer.metadata,
          media: allMedia.length > 0 ? allMedia : undefined,
        }
      );
    } else {
      // No pending messages - release the processing lock
      this.processingConversations.delete(key);
      logger.debug(`Released processing lock for ${key}`);
    }
  }

  /**
   * Send a Telegram message with proper formatting
   */
  private async sendTelegramMessage(
    conversationId: string,
    content: string,
    options?: { format?: string; replyToMessageId?: string }
  ): Promise<void> {
    if (!this.telegramListener) return;

    // Auto-detect markdown syntax and convert for Telegram
    const hasMarkdown = /\*\*.+?\*\*|\*.+?\*|`.+?`|^#{1,6}\s/m.test(content);

    let parseMode: 'Markdown' | 'MarkdownV2' | 'HTML' | undefined;
    let processedContent = content;

    if (options?.format === 'markdown' || hasMarkdown) {
      try {
        processedContent = telegramifyMarkdown(content, 'escape');
        parseMode = 'MarkdownV2';
      } catch (err) {
        // If conversion fails, send as plain text
        logger.warn('Markdown conversion failed, sending as plain text:', err);
        processedContent = content;
        parseMode = undefined;
      }
    }

    await this.telegramListener.sendMessage(conversationId, processedContent, {
      replyToMessageId: options?.replyToMessageId,
      parseMode,
    });

    // Log outgoing message to activity stream
    const userId = conversationUserMap.get(conversationId);
    if (this.dataComposer && userId) {
      try {
        await this.dataComposer.repositories.activityStream.logMessage({
          userId,
          agentId: 'myra',
          direction: 'out',
          content,
          platform: 'telegram',
          platformChatId: conversationId,
          isDm: true, // Will be corrected by context
        });
      } catch (activityError) {
        logger.warn('Failed to log outgoing message to activity stream:', activityError);
      }
    }
  }

  /**
   * Start Telegram listener
   */
  private async startTelegram(): Promise<void> {
    if (!env.TELEGRAM_BOT_TOKEN) {
      logger.warn('TELEGRAM_BOT_TOKEN not set - Telegram listener disabled');
      return;
    }

    logger.info('Creating Telegram listener...');
    this.telegramListener = createTelegramListener({
      pollingInterval: this.config.telegramPollingInterval,
      allowedChatIds: this.config.allowedTelegramChats,
    });

    // Wire up message handling
    this.telegramListener.onMessage(async (message) => {
      const senderId = message.sender.id || 'unknown';
      const conversationId = message.conversationId || senderId;
      const isGroupChat = message.chatType === 'group';
      const botMentioned = message.mentions?.botMentioned ?? false;

      // In group chats, only respond if bot is mentioned
      if (isGroupChat && !botMentioned) {
        logger.debug('Skipping group message - bot not mentioned');
        return;
      }

      // Start typing indicator
      this.startTypingIndicator(conversationId, 'telegram');

      // Buffer the message (will be forwarded after delay or combined with subsequent messages)
      this.bufferMessage(
        'telegram',
        conversationId,
        { id: senderId, name: message.sender.name || message.sender.username },
        message.body,
        {
          replyToMessageId: message.replyTo?.id,
          media: message.media,
          chatType: message.chatType,
          mentions: message.mentions,
        }
      );
    });

    // Forward events
    this.telegramListener.on('connected', (bot: { username: string }) => {
      logger.info(`Telegram bot connected: @${bot.username}`);
      this.emit('telegram:connected', bot);
    });

    this.telegramListener.on('error', (error: Error) => {
      logger.error('Telegram listener error:', error);
      this.emit('telegram:error', error);
    });

    await this.telegramListener.start();
    logger.info('Telegram listener started');
  }

  /**
   * Start WhatsApp listener
   */
  private async startWhatsApp(): Promise<void> {
    logger.info('Creating WhatsApp listener...');
    this.whatsappListener = createWhatsAppListener({
      accountId: this.config.whatsappAccountId,
      printQr: this.config.printWhatsAppQr,
      onQr: this.config.onWhatsAppQr,
    });

    // Wire up message handling
    this.whatsappListener.onMessage(async (message) => {
      const senderId = message.sender.id || 'unknown';
      const conversationId = message.conversationId || senderId;
      const isGroupChat = message.chatType === 'group';
      const botMentioned = message.mentions?.botMentioned ?? false;

      // In group chats, only respond if bot is mentioned
      if (isGroupChat && !botMentioned) {
        logger.debug('Skipping WhatsApp group message - bot not mentioned');
        return;
      }

      // Start typing indicator
      this.startTypingIndicator(conversationId, 'whatsapp');

      // Buffer the message (will be forwarded after delay or combined with subsequent messages)
      this.bufferMessage(
        'whatsapp',
        conversationId,
        { id: senderId, name: message.sender.name },
        message.body,
        {
          chatType: message.chatType,
          mentions: message.mentions,
        }
      );
    });

    // Forward events
    this.whatsappListener.on('connected', (info: { jid: string; e164: string | null }) => {
      logger.info(`WhatsApp connected: ${info.e164 || info.jid}`);
      this.emit('whatsapp:connected', info);
    });

    this.whatsappListener.on('qr', (qr: string) => {
      logger.info('WhatsApp QR code displayed');
      this.emit('whatsapp:qr', qr);
    });

    this.whatsappListener.on('loggedOut', () => {
      logger.warn('WhatsApp logged out');
      this.emit('whatsapp:loggedOut');
    });

    this.whatsappListener.on('error', (error: Error) => {
      logger.error('WhatsApp listener error:', error);
      this.emit('whatsapp:error', error);
    });

    await this.whatsappListener.start();
    logger.info('WhatsApp listener started');
  }

  /**
   * Start a typing indicator that refreshes every 4s
   */
  private startTypingIndicator(conversationId: string, channel: 'telegram' | 'whatsapp'): void {
    this.stopTypingIndicator(conversationId);

    // Send immediately
    if (channel === 'telegram' && this.telegramListener) {
      this.telegramListener.sendTypingIndicator(conversationId);
    } else if (channel === 'whatsapp' && this.whatsappListener) {
      this.whatsappListener.sendTypingIndicator(conversationId);
    }

    // Refresh every 4 seconds
    const interval = setInterval(() => {
      if (channel === 'telegram' && this.telegramListener) {
        this.telegramListener.sendTypingIndicator(conversationId);
      } else if (channel === 'whatsapp' && this.whatsappListener) {
        this.whatsappListener.sendTypingIndicator(conversationId);
      }
    }, TYPING_INTERVAL_MS);

    activeTypingIntervals.set(conversationId, interval);
  }

  /**
   * Stop a typing indicator
   */
  private stopTypingIndicator(conversationId: string): void {
    const interval = activeTypingIntervals.get(conversationId);
    if (interval) {
      clearInterval(interval);
      activeTypingIntervals.delete(conversationId);
    }
  }

  // ============================================================================
  // Accessors for admin routes and external use
  // ============================================================================

  getTelegramListener(): TelegramListener | null {
    return this.telegramListener;
  }

  getWhatsAppListener(): WhatsAppListener | null {
    return this.whatsappListener;
  }

  isStarted(): boolean {
    return this.started;
  }

  getStatus(): {
    started: boolean;
    telegram: { enabled: boolean; connected: boolean };
    whatsapp: { enabled: boolean; connected: boolean };
  } {
    return {
      started: this.started,
      telegram: {
        enabled: this.config.enableTelegram ?? false,
        connected: this.telegramListener?.running ?? false,
      },
      whatsapp: {
        enabled: this.config.enableWhatsApp ?? false,
        connected: this.whatsappListener?.connected ?? false,
      },
    };
  }
}

// Global singleton instance
let channelGateway: ChannelGateway | null = null;

/**
 * Get or create the global channel gateway instance
 */
export function getChannelGateway(): ChannelGateway {
  if (!channelGateway) {
    channelGateway = new ChannelGateway();
  }
  return channelGateway;
}

/**
 * Create a new channel gateway with custom config
 */
export function createChannelGateway(config: ChannelGatewayConfig): ChannelGateway {
  channelGateway = new ChannelGateway(config);
  return channelGateway;
}
