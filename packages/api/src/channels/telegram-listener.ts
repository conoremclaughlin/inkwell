/**
 * Telegram Listener Service
 *
 * Listens for incoming Telegram messages via long-polling (getUpdates)
 * and routes them to the ChannelGateway for processing.
 *
 * Can be switched to webhook mode for production deployments.
 */

import { EventEmitter } from 'events';
import type { InboundMessage, ChannelPlatform } from './types';
import { MediaGroupBuffer } from './media-group-buffer';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { getAuthorizationService, type AuthorizationService } from '../services/authorization';

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

interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  performer?: string;
  title?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

interface TelegramMessageEntity {
  type:
    | 'mention'
    | 'hashtag'
    | 'cashtag'
    | 'bot_command'
    | 'url'
    | 'email'
    | 'phone_number'
    | 'bold'
    | 'italic'
    | 'underline'
    | 'strikethrough'
    | 'code'
    | 'pre'
    | 'text_link'
    | 'text_mention';
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
  document?: TelegramDocument;
  video?: TelegramVideo;
  audio?: TelegramAudio;
  media_group_id?: string;
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
  private mediaGroupBuffer: MediaGroupBuffer | null = null;
  private authService: AuthorizationService;
  private botUsername: string | null = null;

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
    this.authService = getAuthorizationService();
  }

  /**
   * Set the callback for incoming messages
   */
  onMessage(callback: MessageCallback): void {
    this.messageCallback = callback;
    this.mediaGroupBuffer = new MediaGroupBuffer((msg) => this.dispatchMessage(msg), {
      flushDelayMs: 500,
    });
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
      this.botUsername = me.username || String(me.id);
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

    this.mediaGroupBuffer?.destroy();

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

    const chatId = String(telegramMessage.chat.id);
    const userId = telegramMessage.from ? String(telegramMessage.from.id) : null;
    const isGroupChat =
      telegramMessage.chat.type === 'group' || telegramMessage.chat.type === 'supergroup';
    const text = telegramMessage.text || telegramMessage.caption || '';

    // ========== AUTHORIZATION CHECK (before any processing) ==========

    if (isGroupChat) {
      // For group chats: check if group is authorized
      const isAuthorized = await this.authService.isGroupAuthorized('telegram', chatId);

      if (!isAuthorized) {
        // Only respond to /authorize command in unauthorized groups
        if (this.isAuthorizeCommand(text)) {
          await this.handleAuthorizeCommand(telegramMessage, chatId);
          return;
        }

        // Complete silence for all other messages - no tokens, no API calls
        logger.debug(`Ignoring message from unauthorized group: ${chatId}`);
        return;
      }
    } else {
      // For DMs: check if user is trusted
      if (!userId) {
        return;
      }

      const trustedUser = await this.authService.isUserTrusted('telegram', userId);

      if (!trustedUser) {
        // Complete silence for untrusted users in DMs
        logger.debug(`Ignoring DM from untrusted user: ${userId}`);
        return;
      }

      // Handle DM commands for trusted users
      if (await this.handleTrustedUserCommand(telegramMessage, chatId, userId)) {
        return; // Command was handled
      }
    }

    // ========== NORMAL MESSAGE PROCESSING ==========

    // Check if message has text or any media (photo, document, video, audio)
    const hasText = !!telegramMessage.text;
    const hasPhoto = !!telegramMessage.photo && telegramMessage.photo.length > 0;
    const hasMedia =
      hasPhoto || !!telegramMessage.document || !!telegramMessage.video || !!telegramMessage.audio;

    if (!hasText && !hasMedia) {
      logger.debug('Skipping message without text or media');
      return;
    }

    // Check legacy allowlist if configured (in addition to new auth)
    if (this.config.allowedChatIds.size > 0 && !this.config.allowedChatIds.has(chatId)) {
      logger.debug(`Ignoring message from non-allowed chat: ${chatId}`);
      return;
    }

    // Convert to InboundMessage (async due to media download)
    const message = await this.convertMessage(telegramMessage);

    // Route media group messages through the buffer for album aggregation
    if (telegramMessage.media_group_id && this.mediaGroupBuffer) {
      this.mediaGroupBuffer.add(telegramMessage.media_group_id, message);
      return;
    }

    // Dispatch single messages directly
    await this.dispatchMessage(message);
  }

  /**
   * Dispatch a converted InboundMessage: cache, emit, and call callback.
   * Used by both the direct path (single messages) and MediaGroupBuffer flush.
   */
  private async dispatchMessage(message: InboundMessage): Promise<void> {
    const chatId = message.conversationId || '';

    // Cache message for context retrieval (ephemeral, not persisted)
    this.cacheMessage({
      messageId: Number(message.messageId) || 0,
      chatId,
      from: message.sender.name || message.sender.username || 'Unknown',
      fromId: message.sender.id || chatId,
      text: message.body,
      timestamp: new Date(message.timestamp || Date.now()),
    });

    logger.info(`Received message from @${message.sender.username || message.sender.id}`, {
      chatId,
      messageId: message.messageId,
      body: message.body.substring(0, 50),
      mediaCount: message.media?.length ?? 0,
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
   * Check if text is an /authorize command
   */
  private isAuthorizeCommand(text: string): boolean {
    return text.trim().toLowerCase().startsWith('/authorize');
  }

  /**
   * Handle /authorize command in an unauthorized group
   */
  private async handleAuthorizeCommand(msg: TelegramMessage, chatId: string): Promise<void> {
    const text = msg.text || msg.caption || '';
    const parts = text.trim().split(/\s+/);

    if (parts.length < 2) {
      // No code provided - just silently ignore to avoid giving hints
      return;
    }

    const code = parts[1];
    const groupName = msg.chat.title || null;

    const result = await this.authService.authorizeGroupWithCode(
      'telegram',
      chatId,
      groupName,
      code
    );

    if (result.success) {
      await this.sendMessage(chatId, `✓ Group authorized! I'm now active in this chat.`);
      logger.info('Group authorized via challenge code', { chatId, groupName });
    } else {
      // Only respond with error if code was invalid (to avoid spam on random /authorize attempts)
      if (result.error === 'Invalid or expired code') {
        await this.sendMessage(
          chatId,
          `✗ Invalid or expired code. Please get a new code from a trusted user.`
        );
      }
    }
  }

  /**
   * Handle DM commands for trusted users
   * Returns true if a command was handled
   */
  private async handleTrustedUserCommand(
    msg: TelegramMessage,
    chatId: string,
    userId: string
  ): Promise<boolean> {
    const text = msg.text || '';
    const command = text.trim().toLowerCase().split(/\s+/)[0];

    switch (command) {
      case '/generate-group-code':
      case '/groupcode':
        return this.handleGenerateCodeCommand(chatId, userId);

      case '/list-groups':
      case '/groups':
        return this.handleListGroupsCommand(chatId);

      case '/list-trusted':
      case '/trusted':
        return this.handleListTrustedCommand(chatId);

      case '/add-trusted':
        return this.handleAddTrustedCommand(msg, chatId, userId);

      case '/revoke-group':
        return this.handleRevokeGroupCommand(msg, chatId, userId);

      default:
        return false; // Not a command, continue to normal processing
    }
  }

  /**
   * Handle /generate-group-code command
   */
  private async handleGenerateCodeCommand(chatId: string, userId: string): Promise<boolean> {
    const code = await this.authService.generateChallengeCode('telegram', userId);

    if (code) {
      await this.sendMessage(
        chatId,
        `🔑 Group authorization code: \`${code}\`\n\n` +
          `This code expires in 24 hours.\n` +
          `To authorize a group, add me to the group and send:\n` +
          `/authorize ${code}`,
        { parseMode: 'Markdown' }
      );
    } else {
      await this.sendMessage(
        chatId,
        `Unable to generate code. You may have reached the limit of 5 active codes.`
      );
    }
    return true;
  }

  /**
   * Handle /list-groups command
   */
  private async handleListGroupsCommand(chatId: string): Promise<boolean> {
    const groups = await this.authService.listAuthorizedGroups('telegram');

    if (groups.length === 0) {
      await this.sendMessage(chatId, `No authorized groups yet.`);
    } else {
      const lines = groups.map(
        (g) => `• ${g.groupName || g.platformGroupId} (${g.authorizationMethod})`
      );
      await this.sendMessage(chatId, `Authorized groups:\n${lines.join('\n')}`);
    }
    return true;
  }

  /**
   * Handle /list-trusted command
   */
  private async handleListTrustedCommand(chatId: string): Promise<boolean> {
    const users = await this.authService.listTrustedUsers('telegram');

    if (users.length === 0) {
      await this.sendMessage(chatId, `No trusted users configured.`);
    } else {
      const lines = users.map((u) => `• ${u.platformUserId} (${u.trustLevel})`);
      await this.sendMessage(chatId, `Trusted users:\n${lines.join('\n')}`);
    }
    return true;
  }

  /**
   * Handle /add-trusted command
   * Usage: /add-trusted <userId> [admin|member]
   */
  private async handleAddTrustedCommand(
    msg: TelegramMessage,
    chatId: string,
    addedByUserId: string
  ): Promise<boolean> {
    const text = msg.text || '';
    const parts = text.trim().split(/\s+/);

    if (parts.length < 2) {
      await this.sendMessage(
        chatId,
        `Usage: /add-trusted <telegram_user_id> [admin|member]\nExample: /add-trusted 123456789 member`
      );
      return true;
    }

    const targetUserId = parts[1];
    const trustLevel = (parts[2]?.toLowerCase() === 'admin' ? 'admin' : 'member') as
      | 'admin'
      | 'member';

    const result = await this.authService.addTrustedUser(
      'telegram',
      targetUserId,
      trustLevel,
      addedByUserId
    );

    if (result.success) {
      await this.sendMessage(chatId, `✓ Added ${targetUserId} as trusted ${trustLevel}.`);
    } else {
      await this.sendMessage(chatId, `✗ ${result.error}`);
    }
    return true;
  }

  /**
   * Handle /revoke-group command
   * Usage: /revoke-group <group_id>
   */
  private async handleRevokeGroupCommand(
    msg: TelegramMessage,
    chatId: string,
    userId: string
  ): Promise<boolean> {
    const text = msg.text || '';
    const parts = text.trim().split(/\s+/);

    if (parts.length < 2) {
      await this.sendMessage(
        chatId,
        `Usage: /revoke-group <group_chat_id>\nExample: /revoke-group -1001234567890`
      );
      return true;
    }

    const groupId = parts[1];

    const result = await this.authService.revokeGroup('telegram', groupId, userId);

    if (result.success) {
      // Leave the group
      try {
        await this.apiCall('leaveChat', { chat_id: groupId });
        await this.sendMessage(chatId, `✓ Revoked and left group ${groupId}.`);
      } catch {
        await this.sendMessage(
          chatId,
          `✓ Revoked group ${groupId}. (Could not leave - may have already left)`
        );
      }
    } else {
      await this.sendMessage(chatId, `✗ ${result.error}`);
    }
    return true;
  }

  /**
   * Convert Telegram message to InboundMessage format
   */
  private async convertMessage(msg: TelegramMessage): Promise<InboundMessage> {
    const chatType =
      msg.chat.type === 'private' ? 'direct' : msg.chat.type === 'channel' ? 'channel' : 'group';

    // For photos, use caption as text body; for text messages use text
    const textContent = msg.text || msg.caption || '';

    const message: InboundMessage = {
      body: textContent,
      rawBody: textContent,
      timestamp: msg.date * 1000, // Convert to ms
      messageId: String(msg.message_id),
      platform: 'telegram' as ChannelPlatform,
      chatType,
      accountId: this.botUsername || undefined,
      sender: {
        id: msg.from ? String(msg.from.id) : String(msg.chat.id),
        username: msg.from?.username,
        name: msg.from
          ? `${msg.from.first_name}${msg.from.last_name ? ' ' + msg.from.last_name : ''}`
          : undefined,
      },
      conversationId: String(msg.chat.id),
      conversationLabel: msg.chat.title || msg.chat.username || msg.chat.first_name,
      groupSubject: msg.chat.title,
    };

    // Handle media attachments (photo, document, video, audio)
    const mediaAttachments: import('./types').MediaAttachment[] = [];

    if (msg.photo && msg.photo.length > 0) {
      const largestPhoto = msg.photo[msg.photo.length - 1];
      const localPath = await this.downloadFile(largestPhoto.file_id);
      if (localPath) {
        mediaAttachments.push({ type: 'image', path: localPath });
        logger.info('Photo attachment downloaded', {
          fileId: largestPhoto.file_id,
          localPath,
          width: largestPhoto.width,
          height: largestPhoto.height,
          hasCaption: !!msg.caption,
        });
      }
    }

    if (msg.document) {
      const localPath = await this.downloadFile(msg.document.file_id);
      if (localPath) {
        mediaAttachments.push({
          type: 'document',
          path: localPath,
          filename: msg.document.file_name,
          contentType: msg.document.mime_type,
        });
        logger.info('Document attachment downloaded', {
          fileId: msg.document.file_id,
          localPath,
          filename: msg.document.file_name,
          mimeType: msg.document.mime_type,
        });
      }
    }

    if (msg.video) {
      const localPath = await this.downloadFile(msg.video.file_id);
      if (localPath) {
        mediaAttachments.push({
          type: 'video',
          path: localPath,
          filename: msg.video.file_name,
          contentType: msg.video.mime_type,
        });
        logger.info('Video attachment downloaded', {
          fileId: msg.video.file_id,
          localPath,
          duration: msg.video.duration,
        });
      }
    }

    if (msg.audio) {
      const localPath = await this.downloadFile(msg.audio.file_id);
      if (localPath) {
        mediaAttachments.push({
          type: 'audio',
          path: localPath,
          filename: msg.audio.file_name,
          contentType: msg.audio.mime_type,
        });
        logger.info('Audio attachment downloaded', {
          fileId: msg.audio.file_id,
          localPath,
          duration: msg.audio.duration,
        });
      }
    }

    if (mediaAttachments.length > 0) {
      message.media = mediaAttachments;
      if (!textContent) {
        const type =
          mediaAttachments[0].type === 'image'
            ? 'Image'
            : mediaAttachments[0].type === 'video'
              ? 'Video'
              : mediaAttachments[0].type === 'audio'
                ? 'Audio'
                : 'File';
        message.body = `[${type} attached]`;
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
        // Check if it's our bot (dynamic — uses bot's actual username)
        if (
          this.botUsername &&
          mentionText.toLowerCase() === `@${this.botUsername.toLowerCase()}`
        ) {
          botMentioned = true;
        }
      }
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

    const data = (await response.json()) as TelegramApiResponse<T>;

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
      logger.debug(
        `Cleaned ${cache.length - filtered.length} expired messages from chat ${chatId}`
      );
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
