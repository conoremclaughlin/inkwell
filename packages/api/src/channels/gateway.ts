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
import { logger } from '../utils/logger';
import { env } from '../config/env';
import telegramifyMarkdown from 'telegramify-markdown';

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

export class ChannelGateway extends EventEmitter {
  private telegramListener: TelegramListener | null = null;
  private whatsappListener: WhatsAppListener | null = null;
  private config: ChannelGatewayConfig;
  private messageHandler: IncomingMessageHandler | null = null;
  private started = false;

  constructor(config: ChannelGatewayConfig = {}) {
    super();
    this.config = {
      enableTelegram: config.enableTelegram ?? !!env.TELEGRAM_BOT_TOKEN,
      telegramPollingInterval: config.telegramPollingInterval ?? 1000,
      enableWhatsApp: config.enableWhatsApp ?? (process.env.ENABLE_WHATSAPP === 'true'),
      whatsappAccountId: config.whatsappAccountId ?? 'default',
      printWhatsAppQr: config.printWhatsAppQr ?? true,
      ...config,
    };
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
        break;

      default:
        logger.warn(`Channel not supported by gateway: ${channel}`);
        throw new Error(`Channel not supported: ${channel}`);
    }

    logger.info(`Response sent via gateway to ${channel}:${conversationId}`);
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

      // Forward to message handler
      if (this.messageHandler) {
        try {
          await this.messageHandler(
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
        } catch (error) {
          logger.error('Error handling Telegram message:', error);
          this.stopTypingIndicator(conversationId);

          // Send error response
          try {
            await this.telegramListener!.sendMessage(
              conversationId,
              'Sorry, I encountered an error processing your message. Please try again.'
            );
          } catch (sendError) {
            logger.error('Failed to send error message:', sendError);
          }
        }
      }
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

      // Forward to message handler
      if (this.messageHandler) {
        try {
          await this.messageHandler(
            'whatsapp',
            conversationId,
            { id: senderId, name: message.sender.name },
            message.body,
            {
              chatType: message.chatType,
              mentions: message.mentions,
            }
          );
        } catch (error) {
          logger.error('Error handling WhatsApp message:', error);
          this.stopTypingIndicator(conversationId);

          try {
            await this.whatsappListener!.sendMessage(
              conversationId,
              'Sorry, I encountered an error processing your message. Please try again.'
            );
          } catch (sendError) {
            logger.error('Failed to send WhatsApp error message:', sendError);
          }
        }
      }
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
