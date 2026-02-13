/**
 * Discord Listener Service
 *
 * Listens for incoming Discord messages via discord.js
 * and routes them to the ChannelGateway for processing.
 *
 * Uses the same authorization model as Telegram:
 * - DMs: Only from trusted users
 * - Groups: Only authorized groups (guilds), with @mention trigger
 * - Slash command: /balances
 */

import { EventEmitter } from 'events';
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  type Message as DiscordMessage,
  type Interaction,
  type TextChannel,
  type DMChannel,
  type NewsChannel,
} from 'discord.js';
import type { InboundMessage, ChannelPlatform } from './types';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { getAuthorizationService, type AuthorizationService } from '../services/authorization';

export interface DiscordListenerConfig {
  /** Bot token (defaults to env.DISCORD_BOT_TOKEN) */
  token?: string;
  /** Application ID (defaults to env.DISCORD_APPLICATION_ID) */
  applicationId?: string;
}

export type MessageCallback = (message: InboundMessage) => Promise<void>;

// Discord has a 2000 character message limit
const DISCORD_MAX_MESSAGE_LENGTH = 2000;

// Ephemeral message storage for context (not persisted to DB)
interface EphemeralMessage {
  messageId: string;
  chatId: string;
  from: string;
  fromId: string;
  text: string;
  timestamp: Date;
}

export class DiscordListener extends EventEmitter {
  private token: string;
  private applicationId: string;
  private client: Client;
  private authService: AuthorizationService;
  private messageCallback?: MessageCallback;
  private isRunning = false;

  // Ephemeral message cache - keyed by channelId, stores last N messages
  private messageCache = new Map<string, EphemeralMessage[]>();
  private readonly maxMessagesPerChat = 100;
  private readonly messageTtlMs = 30 * 60 * 1000; // 30 minutes

  constructor(config?: DiscordListenerConfig) {
    super();
    const token = config?.token || env.DISCORD_BOT_TOKEN;
    if (!token) {
      throw new Error('DISCORD_BOT_TOKEN is required');
    }
    this.token = token;
    this.applicationId = config?.applicationId || env.DISCORD_APPLICATION_ID || '';

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
      ],
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
   * Start listening for messages
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('DiscordListener is already running');
      return;
    }

    logger.info('Starting Discord listener...');

    // Wire up event handlers before login
    this.client.on('messageCreate', (msg) => this.handleMessage(msg));
    this.client.on('interactionCreate', (interaction) => this.handleInteraction(interaction));

    this.client.on('error', (error) => {
      logger.error('Discord client error:', error);
      this.emit('error', error);
    });

    // Login
    try {
      await this.client.login(this.token);
      this.isRunning = true;

      const botUser = this.client.user;
      if (botUser) {
        logger.info(`Discord bot connected: @${botUser.username} (${botUser.id})`);
        this.emit('connected', { username: botUser.username, id: botUser.id });
      }

      // Register slash commands
      await this.registerSlashCommands();
    } catch (error) {
      logger.error('Failed to connect to Discord:', error);
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

    logger.info('Stopping Discord listener...');
    this.isRunning = false;

    try {
      this.client.destroy();
    } catch (error) {
      logger.error('Error destroying Discord client:', error);
    }

    this.emit('disconnected');
  }

  /**
   * Register the /balances slash command via REST API
   */
  private async registerSlashCommands(): Promise<void> {
    if (!this.applicationId) {
      logger.warn('DISCORD_APPLICATION_ID not set - slash commands will not be registered');
      return;
    }

    const rest = new REST({ version: '10' }).setToken(this.token);

    const commands = [
      {
        name: 'balances',
        description: 'Show who owes whom',
      },
    ];

    try {
      await rest.put(Routes.applicationCommands(this.applicationId), { body: commands });
      logger.info('Discord slash commands registered: /balances');
    } catch (error) {
      logger.error('Failed to register Discord slash commands:', error);
    }
  }

  /**
   * Handle incoming Discord messages
   */
  private async handleMessage(msg: DiscordMessage): Promise<void> {
    // Ignore bot messages
    if (msg.author.bot) return;

    const isDm = !msg.guild;
    const userId = msg.author.id;

    // ========== AUTHORIZATION CHECK ==========

    if (!isDm) {
      // Group: check if guild is authorized
      const guildId = msg.guild!.id;
      const isAuthorized = await this.authService.isGroupAuthorized('discord', guildId);

      if (!isAuthorized) {
        const text = msg.content.trim();
        // Only respond to /authorize command
        if (this.isAuthorizeCommand(text)) {
          await this.handleAuthorizeCommand(msg, guildId);
          return;
        }

        logger.debug(`Ignoring message from unauthorized guild: ${guildId}`);
        return;
      }

      // In authorized groups, only process if bot is mentioned
      if (!this.isBotMentioned(msg)) {
        return;
      }
    } else {
      // DM: check if user is trusted
      const trustedUser = await this.authService.isUserTrusted('discord', userId);

      if (!trustedUser) {
        logger.debug(`Ignoring DM from untrusted Discord user: ${userId}`);
        return;
      }

      // Handle DM commands for trusted users
      if (await this.handleTrustedUserCommand(msg, userId)) {
        return;
      }
    }

    // ========== NORMAL MESSAGE PROCESSING ==========

    const hasText = !!msg.content;
    const hasAttachments = msg.attachments.size > 0;

    if (!hasText && !hasAttachments) {
      logger.debug('Skipping Discord message without text or attachments');
      return;
    }

    // Convert to InboundMessage
    const message = await this.convertMessage(msg);

    // Dispatch
    await this.dispatchMessage(message);
  }

  /**
   * Handle slash command interactions
   */
  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'balances') {
      // Defer reply so we have time to process
      await interaction.deferReply();

      // Check guild authorization if in a guild
      if (interaction.guild) {
        const isAuthorized = await this.authService.isGroupAuthorized(
          'discord',
          interaction.guild.id
        );
        if (!isAuthorized) {
          await interaction.editReply(
            'This server is not authorized. Use `/authorize <code>` first.'
          );
          return;
        }
      }

      // Convert to InboundMessage and dispatch through normal pipeline
      const message: InboundMessage = {
        body: '/balances',
        rawBody: '/balances',
        timestamp: interaction.createdTimestamp,
        messageId: interaction.id,
        platform: 'discord' as ChannelPlatform,
        chatType: interaction.guild ? 'group' : 'direct',
        sender: {
          id: interaction.user.id,
          username: interaction.user.username,
          name: interaction.user.displayName,
        },
        conversationId: interaction.channelId,
        conversationLabel: interaction.guild
          ? interaction.channel && 'name' in interaction.channel
            ? (interaction.channel.name ?? undefined)
            : undefined
          : interaction.user.username,
        groupSubject: interaction.guild?.name,
        mentions: { users: [], botMentioned: true },
      };

      if (this.messageCallback) {
        try {
          await this.messageCallback(message);
          // If the callback completes without sending a response, acknowledge
          if (!interaction.replied && interaction.deferred) {
            await interaction.editReply('Processing...');
          }
        } catch (error) {
          logger.error('Error processing /balances command:', error);
          await interaction.editReply('Sorry, I encountered an error processing that command.');
        }
      } else {
        await interaction.editReply('No message handler configured.');
      }
    }
  }

  /**
   * Check if the bot is mentioned in a message
   */
  private isBotMentioned(msg: DiscordMessage): boolean {
    if (!this.client.user) return false;

    // Check direct @mention
    if (msg.mentions.has(this.client.user)) return true;

    // Check if bot's username/display name is mentioned (case-insensitive)
    const lowerContent = msg.content.toLowerCase();
    const botUsername = this.client.user.username.toLowerCase();
    const botDisplayName = this.client.user.displayName?.toLowerCase();

    if (lowerContent.includes(botUsername)) return true;
    if (botDisplayName && lowerContent.includes(botDisplayName)) return true;

    return false;
  }

  /**
   * Check if text is an /authorize command
   */
  private isAuthorizeCommand(text: string): boolean {
    return text.toLowerCase().startsWith('/authorize');
  }

  /**
   * Handle /authorize command in an unauthorized guild
   */
  private async handleAuthorizeCommand(msg: DiscordMessage, guildId: string): Promise<void> {
    const parts = msg.content.trim().split(/\s+/);

    if (parts.length < 2) {
      // No code provided - silently ignore
      return;
    }

    const code = parts[1];
    const groupName = msg.guild?.name || null;

    const result = await this.authService.authorizeGroupWithCode(
      'discord',
      guildId,
      groupName,
      code
    );

    if (result.success) {
      await this.sendMessage(msg.channelId, "Group authorized! I'm now active in this server.");
      logger.info('Discord guild authorized via challenge code', { guildId, groupName });
    } else {
      if (result.error === 'Invalid or expired code') {
        await this.sendMessage(
          msg.channelId,
          'Invalid or expired code. Please get a new code from a trusted user.'
        );
      }
    }
  }

  /**
   * Handle DM commands for trusted users
   * Returns true if a command was handled
   */
  private async handleTrustedUserCommand(msg: DiscordMessage, userId: string): Promise<boolean> {
    const text = msg.content.trim();
    const command = text.toLowerCase().split(/\s+/)[0];

    switch (command) {
      case '/generate-group-code':
      case '/groupcode':
        return this.handleGenerateCodeCommand(msg.channelId, userId);

      case '/list-groups':
      case '/groups':
        return this.handleListGroupsCommand(msg.channelId);

      case '/list-trusted':
      case '/trusted':
        return this.handleListTrustedCommand(msg.channelId);

      case '/add-trusted':
        return this.handleAddTrustedCommand(msg, userId);

      case '/revoke-group':
        return this.handleRevokeGroupCommand(msg, userId);

      default:
        return false;
    }
  }

  /**
   * Handle /generate-group-code command
   */
  private async handleGenerateCodeCommand(channelId: string, userId: string): Promise<boolean> {
    const code = await this.authService.generateChallengeCode('discord', userId);

    if (code) {
      await this.sendMessage(
        channelId,
        `Group authorization code: \`${code}\`\n\n` +
          `This code expires in 24 hours.\n` +
          `To authorize a server, add me to the server and send:\n` +
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

  /**
   * Handle /list-groups command
   */
  private async handleListGroupsCommand(channelId: string): Promise<boolean> {
    const groups = await this.authService.listAuthorizedGroups('discord');

    if (groups.length === 0) {
      await this.sendMessage(channelId, 'No authorized Discord servers yet.');
    } else {
      const lines = groups.map(
        (g) => `- ${g.groupName || g.platformGroupId} (${g.authorizationMethod})`
      );
      await this.sendMessage(channelId, `Authorized servers:\n${lines.join('\n')}`);
    }
    return true;
  }

  /**
   * Handle /list-trusted command
   */
  private async handleListTrustedCommand(channelId: string): Promise<boolean> {
    const users = await this.authService.listTrustedUsers('discord');

    if (users.length === 0) {
      await this.sendMessage(channelId, 'No trusted users configured.');
    } else {
      const lines = users.map((u) => `- ${u.platformUserId} (${u.trustLevel})`);
      await this.sendMessage(channelId, `Trusted users:\n${lines.join('\n')}`);
    }
    return true;
  }

  /**
   * Handle /add-trusted command
   * Usage: /add-trusted <userId> [admin|member]
   */
  private async handleAddTrustedCommand(
    msg: DiscordMessage,
    addedByUserId: string
  ): Promise<boolean> {
    const parts = msg.content.trim().split(/\s+/);

    if (parts.length < 2) {
      await this.sendMessage(
        msg.channelId,
        'Usage: /add-trusted <discord_user_id> [admin|member]\nExample: /add-trusted 123456789 member'
      );
      return true;
    }

    const targetUserId = parts[1];
    const trustLevel = (parts[2]?.toLowerCase() === 'admin' ? 'admin' : 'member') as
      | 'admin'
      | 'member';

    const result = await this.authService.addTrustedUser(
      'discord',
      targetUserId,
      trustLevel,
      addedByUserId
    );

    if (result.success) {
      await this.sendMessage(msg.channelId, `Added ${targetUserId} as trusted ${trustLevel}.`);
    } else {
      await this.sendMessage(msg.channelId, `Error: ${result.error}`);
    }
    return true;
  }

  /**
   * Handle /revoke-group command
   * Usage: /revoke-group <guild_id>
   */
  private async handleRevokeGroupCommand(msg: DiscordMessage, userId: string): Promise<boolean> {
    const parts = msg.content.trim().split(/\s+/);

    if (parts.length < 2) {
      await this.sendMessage(
        msg.channelId,
        'Usage: /revoke-group <guild_id>\nExample: /revoke-group 1234567890'
      );
      return true;
    }

    const groupId = parts[1];
    const result = await this.authService.revokeGroup('discord', groupId, userId);

    if (result.success) {
      // Try to leave the guild
      try {
        const guild = this.client.guilds.cache.get(groupId);
        if (guild) {
          await guild.leave();
          await this.sendMessage(msg.channelId, `Revoked and left server ${groupId}.`);
        } else {
          await this.sendMessage(
            msg.channelId,
            `Revoked server ${groupId}. (Not currently in that server)`
          );
        }
      } catch {
        await this.sendMessage(
          msg.channelId,
          `Revoked server ${groupId}. (Could not leave - may have already left)`
        );
      }
    } else {
      await this.sendMessage(msg.channelId, `Error: ${result.error}`);
    }
    return true;
  }

  /**
   * Convert Discord message to InboundMessage format
   */
  private async convertMessage(msg: DiscordMessage): Promise<InboundMessage> {
    const isDm = !msg.guild;
    const chatType = isDm ? 'direct' : 'group';

    // Strip bot @mention from content
    let body = msg.content;
    if (this.client.user) {
      // Remove <@BOT_ID> mentions
      body = body.replace(new RegExp(`<@!?${this.client.user.id}>`, 'g'), '').trim();
    }

    const message: InboundMessage = {
      body,
      rawBody: msg.content,
      timestamp: msg.createdTimestamp,
      messageId: msg.id,
      platform: 'discord' as ChannelPlatform,
      chatType,
      sender: {
        id: msg.author.id,
        username: msg.author.username,
        name: msg.author.displayName,
      },
      conversationId: msg.channelId,
      conversationLabel: isDm
        ? msg.author.username
        : 'name' in msg.channel
          ? (msg.channel as TextChannel).name
          : undefined,
      groupSubject: msg.guild?.name,
    };

    // Handle media attachments
    const mediaAttachments: import('./types').MediaAttachment[] = [];
    for (const attachment of msg.attachments.values()) {
      const localPath = await this.downloadAttachment(attachment.url, attachment.name);
      if (localPath) {
        const type = this.getMediaType(attachment.contentType || '');
        mediaAttachments.push({
          type,
          path: localPath,
          filename: attachment.name,
          contentType: attachment.contentType || undefined,
        });
        logger.info('Discord attachment downloaded', {
          filename: attachment.name,
          localPath,
          contentType: attachment.contentType,
        });
      }
    }

    if (mediaAttachments.length > 0) {
      message.media = mediaAttachments;
      if (!body) {
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

    // Extract mentions
    const mentionedUsers = msg.mentions.users.map((u) => u.username);
    const botMentioned = this.client.user ? msg.mentions.has(this.client.user) : false;

    message.mentions = {
      users: mentionedUsers,
      botMentioned: botMentioned || this.isBotMentioned(msg),
    };

    // Add reply context if present
    if (msg.reference?.messageId) {
      try {
        const repliedMsg = await msg.channel.messages.fetch(msg.reference.messageId);
        message.replyTo = {
          id: repliedMsg.id,
          body: repliedMsg.content,
          sender: repliedMsg.author.username,
        };
      } catch {
        // Reply target may have been deleted
        message.replyTo = {
          id: msg.reference.messageId,
        };
      }
    }

    // Store raw for advanced use cases
    message.raw = msg;

    return message;
  }

  /**
   * Determine media type from content type
   */
  private getMediaType(contentType: string): 'image' | 'video' | 'audio' | 'document' {
    if (contentType.startsWith('image/')) return 'image';
    if (contentType.startsWith('video/')) return 'video';
    if (contentType.startsWith('audio/')) return 'audio';
    return 'document';
  }

  /**
   * Download an attachment from Discord and save locally
   * Files are saved to ~/.pcp/files/discord/
   */
  private async downloadAttachment(url: string, filename: string | null): Promise<string | null> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to download: ${response.status}`);
      }

      const buffer = await response.arrayBuffer();

      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');

      const pcpFilesDir = path.join(os.homedir(), '.pcp', 'files', 'discord');
      await fs.mkdir(pcpFilesDir, { recursive: true });

      const safeName = (filename || `attachment_${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = path.join(pcpFilesDir, `${Date.now()}_${safeName}`);

      await fs.writeFile(filePath, Buffer.from(buffer));

      logger.info('Downloaded Discord file', { filePath, size: buffer.byteLength });
      return filePath;
    } catch (error) {
      logger.error('Failed to download Discord file:', error);
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

    logger.info(`Received Discord message from @${message.sender.username || message.sender.id}`, {
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
        logger.error('Error in Discord message callback:', error);
        this.emit('error', error);
      }
    }
  }

  /**
   * Send a message to a Discord channel.
   * Handles the 2000-char limit by splitting into chunks.
   * conversationId format: "discord:<channelId>" or just "<channelId>"
   */
  async sendMessage(conversationId: string, content: string): Promise<void> {
    const channelId = conversationId.startsWith('discord:')
      ? conversationId.replace('discord:', '')
      : conversationId;

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) {
        throw new Error(`Channel ${channelId} not found or not a text channel`);
      }

      const textChannel = channel as TextChannel | DMChannel | NewsChannel;

      // Split long messages
      if (content.length <= DISCORD_MAX_MESSAGE_LENGTH) {
        await textChannel.send(content);
      } else {
        const chunks = this.splitMessage(content);
        for (const chunk of chunks) {
          await textChannel.send(chunk);
        }
      }

      logger.info(`Sent message to Discord channel ${channelId}`);
    } catch (error) {
      logger.error(`Failed to send message to Discord channel ${channelId}:`, error);
      throw error;
    }
  }

  /**
   * Split a long message into chunks that fit Discord's 2000-char limit
   */
  private splitMessage(content: string): string[] {
    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
      if (remaining.length <= DISCORD_MAX_MESSAGE_LENGTH) {
        chunks.push(remaining);
        break;
      }

      // Try to split at a newline before the limit
      let splitIndex = remaining.lastIndexOf('\n', DISCORD_MAX_MESSAGE_LENGTH);
      if (splitIndex <= 0 || splitIndex < DISCORD_MAX_MESSAGE_LENGTH / 2) {
        // No good newline break - split at space
        splitIndex = remaining.lastIndexOf(' ', DISCORD_MAX_MESSAGE_LENGTH);
      }
      if (splitIndex <= 0) {
        // No good break point - hard split
        splitIndex = DISCORD_MAX_MESSAGE_LENGTH;
      }

      chunks.push(remaining.substring(0, splitIndex));
      remaining = remaining.substring(splitIndex).trimStart();
    }

    return chunks;
  }

  /**
   * Send typing indicator
   */
  async sendTypingIndicator(conversationId: string): Promise<void> {
    const channelId = conversationId.startsWith('discord:')
      ? conversationId.replace('discord:', '')
      : conversationId;

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel | DMChannel).sendTyping();
      }
    } catch (error) {
      // Non-critical
      logger.debug(`Failed to send Discord typing indicator: ${error}`);
    }
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
    return this.isRunning && this.client.isReady();
  }

  // ============================================================================
  // Ephemeral message cache (mirrors TelegramListener)
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
 * Create a Discord listener instance
 */
export function createDiscordListener(config?: DiscordListenerConfig): DiscordListener {
  return new DiscordListener(config);
}
