/**
 * Telegram Listener Service
 *
 * Listens for incoming Telegram messages via long-polling (getUpdates)
 * and routes them to the MessageHandler for processing.
 *
 * Can be switched to webhook mode for production deployments.
 */

import { EventEmitter } from 'events';
import type { InboundMessage, ChannelPlatform } from './types';
import { logger } from '../utils/logger';
import { env } from '../config/env';

const TELEGRAM_API = 'https://api.telegram.org';

// Telegram API types
interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  date: number;
  chat: TelegramChat;
  text?: string;
  reply_to_message?: TelegramMessage;
  forward_from?: TelegramUser;
  forward_date?: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

export interface TelegramListenerConfig {
  /** Bot token (defaults to env.TELEGRAM_BOT_TOKEN) */
  token?: string;
  /** Polling interval in ms (default: 1000) */
  pollingInterval?: number;
  /** Request timeout in ms (default: 30000 for long-polling) */
  timeout?: number;
  /** Allowed chat IDs (empty = allow all) */
  allowedChatIds?: string[];
}

export type MessageCallback = (message: InboundMessage) => Promise<void>;

export class TelegramListener extends EventEmitter {
  private token: string;
  private config: Required<Omit<TelegramListenerConfig, 'token' | 'allowedChatIds'>> & {
    allowedChatIds: Set<string>;
  };
  private isRunning = false;
  private lastUpdateId = 0;
  private pollTimeout: NodeJS.Timeout | null = null;
  private messageCallback?: MessageCallback;

  constructor(config?: TelegramListenerConfig) {
    super();
    const token = config?.token || env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is required');
    }
    this.token = token;
    this.config = {
      pollingInterval: config?.pollingInterval ?? 1000,
      timeout: config?.timeout ?? 30000,
      allowedChatIds: new Set(config?.allowedChatIds ?? []),
    };
  }

  /**
   * Set the callback for incoming messages
   */
  onMessage(callback: MessageCallback): void {
    this.messageCallback = callback;
  }

  /**
   * Start listening for messages
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('TelegramListener is already running');
      return;
    }

    logger.info('Starting Telegram listener...');
    this.isRunning = true;

    // Get bot info
    try {
      const me = await this.apiCall<TelegramUser>('getMe');
      logger.info(`Telegram bot connected: @${me.username} (${me.id})`);
      this.emit('connected', me);
    } catch (error) {
      logger.error('Failed to connect to Telegram:', error);
      this.isRunning = false;
      throw error;
    }

    // Start polling loop
    this.poll();
  }

  /**
   * Stop listening for messages
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping Telegram listener...');
    this.isRunning = false;

    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }

    this.emit('disconnected');
  }

  /**
   * Main polling loop
   */
  private async poll(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      const updates = await this.getUpdates();

      for (const update of updates) {
        this.lastUpdateId = update.update_id;
        await this.handleUpdate(update);
      }
    } catch (error) {
      if (this.isRunning) {
        logger.error('Polling error:', error);
        this.emit('error', error);
      }
    }

    // Schedule next poll
    if (this.isRunning) {
      this.pollTimeout = setTimeout(() => this.poll(), this.config.pollingInterval);
    }
  }

  /**
   * Get updates from Telegram
   */
  private async getUpdates(): Promise<TelegramUpdate[]> {
    const params: Record<string, unknown> = {
      offset: this.lastUpdateId + 1,
      timeout: Math.floor(this.config.timeout / 1000), // Telegram expects seconds
      allowed_updates: ['message', 'edited_message'],
    };

    return this.apiCall<TelegramUpdate[]>('getUpdates', params);
  }

  /**
   * Handle a single update
   */
  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const telegramMessage = update.message || update.edited_message;
    if (!telegramMessage) {
      return;
    }

    // Skip non-text messages for now
    if (!telegramMessage.text) {
      logger.debug('Skipping non-text message');
      return;
    }

    const chatId = String(telegramMessage.chat.id);

    // Check allowlist if configured
    if (this.config.allowedChatIds.size > 0 && !this.config.allowedChatIds.has(chatId)) {
      logger.debug(`Ignoring message from non-allowed chat: ${chatId}`);
      return;
    }

    // Convert to InboundMessage
    const message = this.convertMessage(telegramMessage);

    logger.info(`Received message from @${message.sender.username || message.sender.id}`, {
      chatId,
      messageId: message.messageId,
      body: message.body.substring(0, 50),
    });

    // Emit event
    this.emit('message', message);

    // Call callback if set
    if (this.messageCallback) {
      try {
        await this.messageCallback(message);
      } catch (error) {
        logger.error('Error in message callback:', error);
        this.emit('error', error);
      }
    }
  }

  /**
   * Convert Telegram message to InboundMessage format
   */
  private convertMessage(msg: TelegramMessage): InboundMessage {
    const chatType = msg.chat.type === 'private' ? 'direct' :
                     msg.chat.type === 'channel' ? 'channel' : 'group';

    const message: InboundMessage = {
      body: msg.text || '',
      rawBody: msg.text || '',
      timestamp: msg.date * 1000, // Convert to ms
      messageId: String(msg.message_id),
      platform: 'telegram' as ChannelPlatform,
      chatType,
      sender: {
        id: msg.from ? String(msg.from.id) : String(msg.chat.id),
        username: msg.from?.username,
        name: msg.from ? `${msg.from.first_name}${msg.from.last_name ? ' ' + msg.from.last_name : ''}` : undefined,
      },
      conversationId: String(msg.chat.id),
      conversationLabel: msg.chat.title || msg.chat.username || msg.chat.first_name,
      groupSubject: msg.chat.title,
    };

    // Add reply context if present
    if (msg.reply_to_message) {
      message.replyTo = {
        id: String(msg.reply_to_message.message_id),
        body: msg.reply_to_message.text,
        sender: msg.reply_to_message.from?.username || String(msg.reply_to_message.from?.id),
      };
    }

    // Add forward context if present
    if (msg.forward_from) {
      message.forwarded = {
        from: msg.forward_from.username || msg.forward_from.first_name,
        fromId: String(msg.forward_from.id),
        date: msg.forward_date ? msg.forward_date * 1000 : undefined,
      };
    }

    // Store raw for advanced use cases
    message.raw = msg;

    return message;
  }

  /**
   * Make a Telegram API call
   */
  private async apiCall<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const url = `${TELEGRAM_API}/bot${this.token}/${method}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: params ? JSON.stringify(params) : undefined,
    });

    const data = await response.json() as TelegramApiResponse<T>;

    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description}`);
    }

    return data.result;
  }

  /**
   * Check if listener is running
   */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Send a message to a Telegram chat
   * conversationId format: "telegram:<chatId>" or just "<chatId>"
   */
  async sendMessage(
    conversationId: string,
    content: string,
    options?: {
      replyToMessageId?: string;
      parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
    }
  ): Promise<void> {
    // Extract chat ID from conversation ID
    const chatId = conversationId.startsWith('telegram:')
      ? conversationId.replace('telegram:', '')
      : conversationId;

    const params: Record<string, unknown> = {
      chat_id: chatId,
      text: content,
    };

    if (options?.replyToMessageId) {
      params.reply_to_message_id = parseInt(options.replyToMessageId, 10);
    }

    if (options?.parseMode) {
      params.parse_mode = options.parseMode;
    }

    try {
      await this.apiCall('sendMessage', params);
      logger.info(`Sent message to Telegram chat ${chatId}`);
    } catch (error) {
      logger.error(`Failed to send message to Telegram chat ${chatId}:`, error);
      throw error;
    }
  }
}

/**
 * Create a Telegram listener instance
 */
export function createTelegramListener(config?: TelegramListenerConfig): TelegramListener {
  return new TelegramListener(config);
}
