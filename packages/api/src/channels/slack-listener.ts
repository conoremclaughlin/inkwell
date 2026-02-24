/**
 * Slack Listener Service
 *
 * Listens for incoming Slack messages via Socket Mode (WebSocket)
 * and routes them to the ChannelGateway for processing.
 *
 * Uses the same authorization model as Discord/Telegram:
 * - DMs: Only from trusted users
 * - Channels: Only authorized channels/workspaces, with @mention trigger
 *
 * Requires:
 * - SLACK_BOT_TOKEN (xoxb-...) — Bot User OAuth Token
 * - SLACK_APP_TOKEN (xapp-...) — App-Level Token with connections:write scope
 */

import { EventEmitter } from 'events';
import { App } from '@slack/bolt';
import type { InboundMessage, ChannelPlatform, MediaAttachment } from './types';

/** Slack message event shape — subset of fields we use from the message callback */
interface SlackMessageEvent {
  type: string;
  subtype?: string;
  text?: string;
  user: string;
  bot_id?: string;
  channel: string;
  channel_type?: string;
  ts: string;
  thread_ts?: string;
  files?: Array<{
    url_private?: string;
    name?: string;
    mimetype?: string;
  }>;
}
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { getAuthorizationService, type AuthorizationService } from '../services/authorization';

export interface SlackListenerConfig {
  /** Bot User OAuth Token (defaults to env.SLACK_BOT_TOKEN) */
  botToken?: string;
  /** App-Level Token for Socket Mode (defaults to env.SLACK_APP_TOKEN) */
  appToken?: string;
}

export type MessageCallback = (message: InboundMessage) => Promise<void>;

// Slack has a 4000 character message limit for chat.postMessage
const SLACK_MAX_MESSAGE_LENGTH = 4000;

// Ephemeral message storage for context (not persisted to DB)
interface EphemeralMessage {
  messageId: string;
  chatId: string;
  from: string;
  fromId: string;
  text: string;
  timestamp: Date;
}

export class SlackListener extends EventEmitter {
  private botToken: string;
  private appToken: string;
  private app: App;
  private authService: AuthorizationService;
  private messageCallback?: MessageCallback;
  private isRunning = false;
  private botUserId: string | null = null;
  private botUsername: string | null = null;

  // User info cache to avoid repeated API calls
  private userInfoCache = new Map<string, { name: string; username: string }>();
  private readonly userInfoCacheTtlMs = 10 * 60 * 1000; // 10 minutes
  private userInfoCacheTimestamps = new Map<string, number>();

  // Ephemeral message cache - keyed by channelId, stores last N messages
  private messageCache = new Map<string, EphemeralMessage[]>();
  private readonly maxMessagesPerChat = 100;
  private readonly messageTtlMs = 30 * 60 * 1000; // 30 minutes

  constructor(config?: SlackListenerConfig) {
    super();
    const botToken = config?.botToken || env.SLACK_BOT_TOKEN;
    const appToken = config?.appToken || env.SLACK_APP_TOKEN;

    if (!botToken) {
      throw new Error('SLACK_BOT_TOKEN is required');
    }
    if (!appToken) {
      throw new Error('SLACK_APP_TOKEN is required for Socket Mode');
    }

    this.botToken = botToken;
    this.appToken = appToken;

    this.app = new App({
      token: this.botToken,
      appToken: this.appToken,
      socketMode: true,
    });

    this.authService = getAuthorizationService();
  }

  /**
   * Set the callback for incoming messages
   */
  onMessage(callback: MessageCallback): void {
    this.messageCallback = callback;
  }

  /**
   * Start listening for messages via Socket Mode
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('SlackListener is already running');
      return;
    }

    logger.info('Starting Slack listener (Socket Mode)...');

    // Register message handler
    this.app.message(async ({ message }) => {
      await this.handleMessage(message as SlackMessageEvent);
    });

    // Handle errors
    this.app.error(async (error) => {
      logger.error('Slack app error:', error);
      this.emit('error', error);
    });

    try {
      await this.app.start();
      this.isRunning = true;

      // Get bot identity
      const authResult = await this.app.client.auth.test({ token: this.botToken });
      this.botUserId = (authResult.user_id as string) || null;
      this.botUsername = (authResult.user as string) || null;

      logger.info(`Slack bot connected: @${this.botUsername} (${this.botUserId})`);
      this.emit('connected', { username: this.botUsername, id: this.botUserId });
    } catch (error) {
      logger.error('Failed to connect to Slack:', error);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Stop listening for messages
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping Slack listener...');
    this.isRunning = false;

    try {
      await this.app.stop();
    } catch (error) {
      logger.error('Error stopping Slack app:', error);
    }

    this.emit('disconnected');
  }

  /**
   * Handle incoming Slack messages
   */
  private async handleMessage(event: SlackMessageEvent): Promise<void> {
    // Ignore bot messages, message_changed, etc.
    if (event.subtype) return;
    if (event.bot_id) return;
    if (!event.user) return;
    if (!event.text && !event.files) return;

    const userId = event.user;
    const channelId = event.channel;
    const isDm = event.channel_type === 'im';

    // ========== AUTHORIZATION CHECK ==========

    if (!isDm) {
      // Channel/group: check if workspace/channel is authorized
      const isAuthorized = await this.authService.isGroupAuthorized('slack', channelId);

      if (!isAuthorized) {
        const text = (event.text || '').trim();
        // Only respond to /authorize command
        if (text.toLowerCase().startsWith('/authorize')) {
          await this.handleAuthorizeCommand(channelId, userId, text);
          return;
        }

        logger.debug(`Ignoring message from unauthorized Slack channel: ${channelId}`);
        return;
      }

      // In authorized channels, only process if bot is mentioned
      if (!this.isBotMentioned(event)) {
        return;
      }
    } else {
      // DM: check if user is trusted
      const trustedUser = await this.authService.isUserTrusted('slack', userId);

      if (!trustedUser) {
        logger.debug(`Ignoring DM from untrusted Slack user: ${userId}`);
        return;
      }

      // Handle DM commands for trusted users
      if (await this.handleTrustedUserCommand(channelId, userId, event.text || '')) {
        return;
      }
    }

    // ========== NORMAL MESSAGE PROCESSING ==========

    const message = await this.convertMessage(event);
    await this.dispatchMessage(message);
  }

  /**
   * Check if the bot is mentioned in a message
   */
  private isBotMentioned(event: SlackMessageEvent): boolean {
    if (!this.botUserId) return false;

    const text = event.text || '';
    // Slack encodes mentions as <@UXXXXXX>
    return text.includes(`<@${this.botUserId}>`);
  }

  /**
   * Handle /authorize command in an unauthorized channel
   */
  private async handleAuthorizeCommand(
    channelId: string,
    _userId: string,
    text: string
  ): Promise<void> {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) return;

    const code = parts[1];

    // Try to get channel name
    let channelName: string | null = null;
    try {
      const info = await this.app.client.conversations.info({ channel: channelId });
      channelName = (info.channel as { name?: string })?.name || null;
    } catch {
      // Non-critical
    }

    const result = await this.authService.authorizeGroupWithCode(
      'slack',
      channelId,
      channelName,
      code
    );

    if (result.success) {
      await this.sendMessage(channelId, "Channel authorized! I'm now active here.");
      logger.info('Slack channel authorized via challenge code', { channelId, channelName });
    } else if (result.error === 'Invalid or expired code') {
      await this.sendMessage(
        channelId,
        'Invalid or expired code. Please get a new code from a trusted user.'
      );
    }
  }

  /**
   * Handle DM commands for trusted users
   * Returns true if a command was handled
   */
  private async handleTrustedUserCommand(
    channelId: string,
    userId: string,
    text: string
  ): Promise<boolean> {
    const command = text.trim().toLowerCase().split(/\s+/)[0];

    switch (command) {
      case '/generate-group-code':
      case '/groupcode':
        return this.handleGenerateCodeCommand(channelId, userId);

      case '/list-groups':
      case '/groups':
        return this.handleListGroupsCommand(channelId);

      case '/list-trusted':
      case '/trusted':
        return this.handleListTrustedCommand(channelId);

      case '/add-trusted':
        return this.handleAddTrustedCommand(channelId, userId, text);

      case '/revoke-group':
        return this.handleRevokeGroupCommand(channelId, userId, text);

      default:
        return false;
    }
  }

  private async handleGenerateCodeCommand(channelId: string, userId: string): Promise<boolean> {
    const code = await this.authService.generateChallengeCode('slack', userId);

    if (code) {
      await this.sendMessage(
        channelId,
        `Group authorization code: \`${code}\`\n\n` +
          `This code expires in 24 hours.\n` +
          `To authorize a channel, invite me and send:\n` +
          `/authorize ${code}`
      );
    } else {
      await this.sendMessage(
        channelId,
        'Unable to generate code. You may have reached the limit of 5 active codes.'
      );
    }
    return true;
  }

  private async handleListGroupsCommand(channelId: string): Promise<boolean> {
    const groups = await this.authService.listAuthorizedGroups('slack');

    if (groups.length === 0) {
      await this.sendMessage(channelId, 'No authorized Slack channels yet.');
    } else {
      const lines = groups.map(
        (g) => `- ${g.groupName || g.platformGroupId} (${g.authorizationMethod})`
      );
      await this.sendMessage(channelId, `Authorized channels:\n${lines.join('\n')}`);
    }
    return true;
  }

  private async handleListTrustedCommand(channelId: string): Promise<boolean> {
    const users = await this.authService.listTrustedUsers('slack');

    if (users.length === 0) {
      await this.sendMessage(channelId, 'No trusted users configured.');
    } else {
      const lines = users.map((u) => `- ${u.platformUserId} (${u.trustLevel})`);
      await this.sendMessage(channelId, `Trusted users:\n${lines.join('\n')}`);
    }
    return true;
  }

  private async handleAddTrustedCommand(
    channelId: string,
    addedByUserId: string,
    text: string
  ): Promise<boolean> {
    const parts = text.trim().split(/\s+/);

    if (parts.length < 2) {
      await this.sendMessage(
        channelId,
        'Usage: /add-trusted <slack_user_id> [admin|member]\nExample: /add-trusted U12345678 member'
      );
      return true;
    }

    const targetUserId = parts[1];
    const trustLevel = (parts[2]?.toLowerCase() === 'admin' ? 'admin' : 'member') as
      | 'admin'
      | 'member';

    const result = await this.authService.addTrustedUser(
      'slack',
      targetUserId,
      trustLevel,
      addedByUserId
    );

    if (result.success) {
      await this.sendMessage(channelId, `Added ${targetUserId} as trusted ${trustLevel}.`);
    } else {
      await this.sendMessage(channelId, `Error: ${result.error}`);
    }
    return true;
  }

  private async handleRevokeGroupCommand(
    channelId: string,
    userId: string,
    text: string
  ): Promise<boolean> {
    const parts = text.trim().split(/\s+/);

    if (parts.length < 2) {
      await this.sendMessage(
        channelId,
        'Usage: /revoke-group <channel_id>\nExample: /revoke-group C1234567890'
      );
      return true;
    }

    const groupId = parts[1];
    const result = await this.authService.revokeGroup('slack', groupId, userId);

    if (result.success) {
      await this.sendMessage(channelId, `Revoked channel ${groupId}.`);
    } else {
      await this.sendMessage(channelId, `Error: ${result.error}`);
    }
    return true;
  }

  /**
   * Convert Slack message event to InboundMessage format
   */
  private async convertMessage(event: SlackMessageEvent): Promise<InboundMessage> {
    const isDm = event.channel_type === 'im';
    const chatType = isDm ? 'direct' : 'group';

    // Get sender info
    const senderInfo = await this.getUserInfo(event.user);

    // Strip bot @mention from content
    let body = event.text || '';
    if (this.botUserId) {
      body = body.replace(new RegExp(`<@${this.botUserId}>`, 'g'), '').trim();
    }

    // Extract @mentions from text: <@UXXXXXX> patterns
    const mentionRegex = /<@(U[A-Z0-9]+)>/g;
    const mentionedUserIds: string[] = [];
    const mentionedUsernames: string[] = [];
    let match;
    while ((match = mentionRegex.exec(event.text || '')) !== null) {
      const mentionedUserId = match[1];
      if (mentionedUserId !== this.botUserId) {
        mentionedUserIds.push(mentionedUserId);
        const info = await this.getUserInfo(mentionedUserId);
        mentionedUsernames.push(info.username);
      }
    }

    const botMentioned = this.botUserId
      ? (event.text || '').includes(`<@${this.botUserId}>`)
      : false;

    // Get channel name for context
    let conversationLabel: string | undefined;
    let groupSubject: string | undefined;
    if (!isDm) {
      try {
        const info = await this.app.client.conversations.info({ channel: event.channel });
        const channelInfo = info.channel as { name?: string; topic?: { value?: string } };
        conversationLabel = channelInfo?.name;
        groupSubject = channelInfo?.topic?.value || channelInfo?.name;
      } catch {
        // Non-critical
      }
    } else {
      conversationLabel = senderInfo.username;
    }

    const message: InboundMessage = {
      body,
      rawBody: event.text || '',
      timestamp: event.ts ? Math.floor(parseFloat(event.ts) * 1000) : Date.now(),
      messageId: event.ts,
      platform: 'slack' as ChannelPlatform,
      chatType,
      sender: {
        id: event.user,
        username: senderInfo.username,
        name: senderInfo.name,
      },
      conversationId: event.channel,
      conversationLabel,
      groupSubject,
      mentions: {
        users: mentionedUsernames,
        botMentioned,
      },
    };

    // Handle file attachments
    if (event.files && event.files.length > 0) {
      const mediaAttachments: MediaAttachment[] = [];
      for (const file of event.files) {
        const localPath = await this.downloadFile(file);
        if (localPath) {
          mediaAttachments.push({
            type: this.getMediaType(file.mimetype || ''),
            path: localPath,
            filename: file.name || undefined,
            contentType: file.mimetype || undefined,
          });
        }
      }
      if (mediaAttachments.length > 0) {
        message.media = mediaAttachments;
        if (!body) {
          message.body = `[${mediaAttachments.length} file(s) attached]`;
        }
      }
    }

    // Handle thread replies
    if (event.thread_ts && event.thread_ts !== event.ts) {
      message.replyTo = {
        id: event.thread_ts,
      };
    }

    message.raw = event;
    return message;
  }

  /**
   * Look up user info from Slack API (with caching)
   */
  private async getUserInfo(userId: string): Promise<{ name: string; username: string }> {
    const now = Date.now();
    const cachedTs = this.userInfoCacheTimestamps.get(userId);

    if (cachedTs && now - cachedTs < this.userInfoCacheTtlMs) {
      const cached = this.userInfoCache.get(userId);
      if (cached) return cached;
    }

    try {
      const result = await this.app.client.users.info({ user: userId });
      const user = result.user as {
        real_name?: string;
        name?: string;
        profile?: { display_name?: string; real_name?: string };
      };

      const info = {
        name: user?.real_name || user?.profile?.real_name || user?.name || userId,
        username: user?.name || userId,
      };

      this.userInfoCache.set(userId, info);
      this.userInfoCacheTimestamps.set(userId, now);
      return info;
    } catch {
      return { name: userId, username: userId };
    }
  }

  /**
   * Determine media type from MIME type
   */
  private getMediaType(mimeType: string): 'image' | 'video' | 'audio' | 'document' {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'document';
  }

  /**
   * Download a Slack file and save locally
   * Files are saved to ~/.pcp/files/slack/
   */
  private async downloadFile(file: {
    url_private?: string;
    name?: string;
    mimetype?: string;
  }): Promise<string | null> {
    if (!file.url_private) return null;

    try {
      const response = await fetch(file.url_private, {
        headers: { Authorization: `Bearer ${this.botToken}` },
      });

      if (!response.ok) {
        throw new Error(`Failed to download: ${response.status}`);
      }

      const buffer = await response.arrayBuffer();

      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');

      const pcpFilesDir = path.join(os.homedir(), '.pcp', 'files', 'slack');
      await fs.mkdir(pcpFilesDir, { recursive: true });

      const safeName = (file.name || `attachment_${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = path.join(pcpFilesDir, `${Date.now()}_${safeName}`);

      await fs.writeFile(filePath, Buffer.from(buffer));

      logger.info('Downloaded Slack file', { filePath, size: buffer.byteLength });
      return filePath;
    } catch (error) {
      logger.error('Failed to download Slack file:', error);
      return null;
    }
  }

  /**
   * Dispatch a converted InboundMessage: cache, emit, and call callback.
   */
  private async dispatchMessage(message: InboundMessage): Promise<void> {
    const chatId = message.conversationId || '';

    // Cache message for context retrieval
    this.cacheMessage({
      messageId: message.messageId || '',
      chatId,
      from: message.sender.name || message.sender.username || 'Unknown',
      fromId: message.sender.id || chatId,
      text: message.body,
      timestamp: new Date(message.timestamp || Date.now()),
    });

    logger.info(`Received Slack message from @${message.sender.username || message.sender.id}`, {
      chatId,
      messageId: message.messageId,
      body: message.body.substring(0, 50),
      mediaCount: message.media?.length ?? 0,
    });

    this.emit('message', message);

    if (this.messageCallback) {
      try {
        await this.messageCallback(message);
      } catch (error) {
        logger.error('Error in Slack message callback:', error);
        this.emit('error', error);
      }
    }
  }

  /**
   * Send a message to a Slack channel.
   * Handles the 4000-char limit by splitting into chunks.
   */
  async sendMessage(conversationId: string, content: string): Promise<void> {
    const channelId = conversationId.startsWith('slack:')
      ? conversationId.replace('slack:', '')
      : conversationId;

    try {
      if (content.length <= SLACK_MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: content,
        });
      } else {
        const chunks = this.splitMessage(content);
        for (const chunk of chunks) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: chunk,
          });
        }
      }

      logger.info(`Sent message to Slack channel ${channelId}`);
    } catch (error) {
      logger.error(`Failed to send message to Slack channel ${channelId}:`, error);
      throw error;
    }
  }

  /**
   * Split a long message into chunks that fit Slack's 4000-char limit
   */
  private splitMessage(content: string): string[] {
    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
      if (remaining.length <= SLACK_MAX_MESSAGE_LENGTH) {
        chunks.push(remaining);
        break;
      }

      let splitIndex = remaining.lastIndexOf('\n', SLACK_MAX_MESSAGE_LENGTH);
      if (splitIndex <= 0 || splitIndex < SLACK_MAX_MESSAGE_LENGTH / 2) {
        splitIndex = remaining.lastIndexOf(' ', SLACK_MAX_MESSAGE_LENGTH);
      }
      if (splitIndex <= 0) {
        splitIndex = SLACK_MAX_MESSAGE_LENGTH;
      }

      chunks.push(remaining.substring(0, splitIndex));
      remaining = remaining.substring(splitIndex).trimStart();
    }

    return chunks;
  }

  /**
   * Send typing indicator — Slack bots can't show typing indicators
   */
  async sendTypingIndicator(_conversationId: string): Promise<void> {
    // Slack's API doesn't support typing indicators for bots
  }

  /**
   * Get the bot's Slack user ID (for mention detection in gateway)
   */
  get botId(): string | null {
    return this.botUserId;
  }

  /**
   * Check if listener is running
   */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Whether the bot is connected
   */
  get connected(): boolean {
    return this.isRunning;
  }

  // ============================================================================
  // Ephemeral message cache (mirrors Discord/Telegram listeners)
  // ============================================================================

  private cacheMessage(message: EphemeralMessage): void {
    const { chatId } = message;

    if (!this.messageCache.has(chatId)) {
      this.messageCache.set(chatId, []);
    }

    const cache = this.messageCache.get(chatId)!;
    cache.push(message);

    if (cache.length > this.maxMessagesPerChat) {
      cache.shift();
    }

    this.cleanExpiredMessages(chatId);
  }

  private cleanExpiredMessages(chatId: string): void {
    const cache = this.messageCache.get(chatId);
    if (!cache) return;

    const now = Date.now();
    const filtered = cache.filter((msg) => now - msg.timestamp.getTime() < this.messageTtlMs);

    if (filtered.length !== cache.length) {
      this.messageCache.set(chatId, filtered);
    }
  }

  getRecentMessages(chatId: string, limit = 50): EphemeralMessage[] {
    this.cleanExpiredMessages(chatId);
    const cache = this.messageCache.get(chatId) || [];
    return cache.slice(-limit);
  }

  clearMessageCache(chatId: string): void {
    this.messageCache.delete(chatId);
  }

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
 * Create a Slack listener instance
 */
export function createSlackListener(config?: SlackListenerConfig): SlackListener {
  return new SlackListener(config);
}
