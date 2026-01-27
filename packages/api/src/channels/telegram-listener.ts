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

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

interface TelegramMessageEntity {
  type: 'mention' | 'hashtag' | 'cashtag' | 'bot_command' | 'url' | 'email' | 'phone_number' | 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code' | 'pre' | 'text_link' | 'text_mention';
  offset: number;
  length: number;
  url?: string;
  user?: TelegramUser;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  date: number;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
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

// Ephemeral message storage for context (not persisted to DB)
interface EphemeralMessage {
  messageId: number;
  chatId: string;
  from: string;
  fromId: string;
  text: string;
  timestamp: Date;
}

export class TelegramListener extends EventEmitter {
  private token: string;
  private config: Required<Omit<TelegramListenerConfig, 'token' | 'allowedChatIds'>> & {
    allowedChatIds: Set<string>;
  };
  private isRunning = false;
  private lastUpdateId = 0;
  private pollTimeout: NodeJS.Timeout | null = null;
  private messageCallback?: MessageCallback;

  // Ephemeral message cache - keyed by chatId, stores last N messages
  // Auto-cleaned periodically, never persisted to disk
  private messageCache = new Map<string, EphemeralMessage[]>();
  private readonly maxMessagesPerChat = 100;
  private readonly messageTtlMs = 30 * 60 * 1000; // 30 minutes

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
      // Include all relevant update types for groups
      allowed_updates: ['message', 'edited_message', 'my_chat_member', 'chat_member'],
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

    // Check if message has text OR photo (with optional caption)
    const hasText = !!telegramMessage.text;
    const hasPhoto = !!telegramMessage.photo && telegramMessage.photo.length > 0;

    if (!hasText && !hasPhoto) {
      logger.debug('Skipping message without text or photo');
      return;
    }

    const chatId = String(telegramMessage.chat.id);

    // Check allowlist if configured
    if (this.config.allowedChatIds.size > 0 && !this.config.allowedChatIds.has(chatId)) {
      logger.debug(`Ignoring message from non-allowed chat: ${chatId}`);
      return;
    }

    // Convert to InboundMessage (async due to photo URL fetching)
    const message = await this.convertMessage(telegramMessage);

    // Cache message for context retrieval (ephemeral, not persisted)
    this.cacheMessage({
      messageId: telegramMessage.message_id,
      chatId,
      from: message.sender.name || message.sender.username || 'Unknown',
      fromId: message.sender.id || chatId,
      text: message.body,
      timestamp: new Date(telegramMessage.date * 1000),
    });

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
  private async convertMessage(msg: TelegramMessage): Promise<InboundMessage> {
    const chatType = msg.chat.type === 'private' ? 'direct' :
                     msg.chat.type === 'channel' ? 'channel' : 'group';

    // For photos, use caption as text body; for text messages use text
    const textContent = msg.text || msg.caption || '';

    const message: InboundMessage = {
      body: textContent,
      rawBody: textContent,
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

    // Handle photo attachments
    if (msg.photo && msg.photo.length > 0) {
      // Get the largest photo (last in array)
      const largestPhoto = msg.photo[msg.photo.length - 1];

      // Download the file locally so Claude can use Read tool on it
      const localPath = await this.downloadFile(largestPhoto.file_id);

      if (localPath) {
        message.media = [{
          type: 'image',
          path: localPath, // Local path for Read tool access
        }];

        // If no caption, add a placeholder body indicating an image was sent
        if (!textContent) {
          message.body = '[Image attached]';
        }

        logger.info('Photo attachment downloaded', {
          fileId: largestPhoto.file_id,
          localPath,
          width: largestPhoto.width,
          height: largestPhoto.height,
          hasCaption: !!msg.caption,
        });
      }
    }

    // Extract mentions from entities
    const entities = msg.entities || msg.caption_entities || [];
    const mentionedUsers: string[] = [];
    let botMentioned = false;

    for (const entity of entities) {
      if (entity.type === 'mention') {
        // Extract the @username from the text
        const mentionText = textContent.substring(entity.offset, entity.offset + entity.length);
        mentionedUsers.push(mentionText);
        // Check if it's our bot
        if (mentionText.toLowerCase() === '@myra_help_bot') {
          botMentioned = true;
        }
      }
    }

    // Also check for name mentions (case-insensitive)
    const lowerText = textContent.toLowerCase();
    if (lowerText.includes('myra')) {
      botMentioned = true;
    }

    message.mentions = {
      users: mentionedUsers,
      botMentioned,
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
   * Get a downloadable URL for a Telegram file
   */
  async getFileUrl(fileId: string): Promise<string | null> {
    try {
      const file = await this.apiCall<TelegramFile>('getFile', { file_id: fileId });
      if (file.file_path) {
        return `${TELEGRAM_API}/file/bot${this.token}/${file.file_path}`;
      }
      return null;
    } catch (error) {
      logger.error('Failed to get file URL:', error);
      return null;
    }
  }

  /**
   * Download a file from Telegram and save locally
   * Returns the local file path
   *
   * Files are saved to ~/.pcp/files/telegram/ which is whitelisted in
   * Claude Code's additionalDirectories setting, allowing Myra to read them.
   */
  async downloadFile(fileId: string): Promise<string | null> {
    const url = await this.getFileUrl(fileId);
    if (!url) return null;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to download: ${response.status}`);
      }

      const buffer = await response.arrayBuffer();

      // Save to ~/.pcp/files/telegram/ (whitelisted in Claude Code additionalDirectories)
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');

      const pcpFilesDir = path.join(os.homedir(), '.pcp', 'files', 'telegram');
      await fs.mkdir(pcpFilesDir, { recursive: true });

      // Extract extension from URL or default to .jpg
      const ext = url.match(/\.(\w+)$/)?.[1] || 'jpg';
      const filename = `${fileId.substring(0, 20)}_${Date.now()}.${ext}`;
      const filePath = path.join(pcpFilesDir, filename);

      await fs.writeFile(filePath, Buffer.from(buffer));

      logger.info('Downloaded Telegram file', { fileId, filePath, size: buffer.byteLength });
      return filePath;
    } catch (error) {
      logger.error('Failed to download Telegram file:', error);
      return null;
    }
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
   * Send a "typing" indicator to show the bot is working on a response
   * Call this before starting to process a message
   */
  async sendTypingIndicator(conversationId: string): Promise<void> {
    const chatId = conversationId.startsWith('telegram:')
      ? conversationId.replace('telegram:', '')
      : conversationId;

    try {
      logger.info(`Sending typing indicator to chat ${chatId}...`);
      const result = await this.apiCall('sendChatAction', {
        chat_id: chatId,
        action: 'typing',
      });
      logger.info(`Typing indicator sent to chat ${chatId}`, { result });
    } catch (error) {
      // Non-critical, don't throw
      logger.error(`Failed to send typing indicator to chat ${chatId}:`, error);
    }
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

    // Debug: log content details to diagnose formatting issues
    const hasNewlines = content.includes('\n');
    const newlineCount = (content.match(/\n/g) || []).length;
    logger.info(`Telegram message sending`, {
      chatId,
      length: content.length,
      newlineCount,
      parseMode: options?.parseMode || 'plain text',
      preview: content.substring(0, 80).replace(/\n/g, '↵'),
    });

    try {
      await this.apiCall('sendMessage', params);
      logger.info(`Sent message to Telegram chat ${chatId}`);
    } catch (error) {
      logger.error(`Failed to send message to Telegram chat ${chatId}:`, error);
      throw error;
    }
  }

  /**
   * Cache a message for context retrieval
   * Messages are stored in memory only, never persisted
   */
  private cacheMessage(message: EphemeralMessage): void {
    const { chatId } = message;

    if (!this.messageCache.has(chatId)) {
      this.messageCache.set(chatId, []);
    }

    const cache = this.messageCache.get(chatId)!;
    cache.push(message);

    // Trim to max messages
    if (cache.length > this.maxMessagesPerChat) {
      cache.shift();
    }

    // Clean expired messages periodically
    this.cleanExpiredMessages(chatId);
  }

  /**
   * Remove messages older than TTL
   */
  private cleanExpiredMessages(chatId: string): void {
    const cache = this.messageCache.get(chatId);
    if (!cache) return;

    const now = Date.now();
    const filtered = cache.filter((msg) => now - msg.timestamp.getTime() < this.messageTtlMs);

    if (filtered.length !== cache.length) {
      this.messageCache.set(chatId, filtered);
      logger.debug(`Cleaned ${cache.length - filtered.length} expired messages from chat ${chatId}`);
    }
  }

  /**
   * Get recent messages from a chat for context
   * Returns ephemeral data - not persisted, disappears after TTL
   *
   * @param chatId - The chat ID to get history from
   * @param limit - Max messages to return (default: 50)
   * @returns Array of recent messages, newest last
   */
  getRecentMessages(chatId: string, limit = 50): EphemeralMessage[] {
    this.cleanExpiredMessages(chatId);
    const cache = this.messageCache.get(chatId) || [];
    return cache.slice(-limit);
  }

  /**
   * Clear message cache for a chat
   * Call this after summarizing context to free memory
   */
  clearMessageCache(chatId: string): void {
    this.messageCache.delete(chatId);
    logger.debug(`Cleared message cache for chat ${chatId}`);
  }

  /**
   * Get cache stats for debugging
   */
  getCacheStats(): { chatCount: number; totalMessages: number } {
    let totalMessages = 0;
    for (const messages of this.messageCache.values()) {
      totalMessages += messages.length;
    }
    return {
      chatCount: this.messageCache.size,
      totalMessages,
    };
  }
}

/**
 * Create a Telegram listener instance
 */
export function createTelegramListener(config?: TelegramListenerConfig): TelegramListener {
  return new TelegramListener(config);
}
