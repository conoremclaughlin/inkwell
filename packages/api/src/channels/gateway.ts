/**
 * Channel Gateway
 *
 * Centralized management of messaging channel listeners (Telegram, WhatsApp, Discord).
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
import { createDiscordListener, DiscordListener } from './discord-listener';
import { createSlackListener, SlackListener } from './slack-listener';
import { setResponseCallback, type ResponseCallback } from '../mcp/tools/response-handlers';
import type { AgentResponse } from '../agent/types';
import type { DataComposer } from '../data/composer';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { InboundMediaPipeline } from './media-pipeline';
import { TextToSpeechService } from './text-to-speech';
import telegramifyMarkdown from 'telegramify-markdown';
import type { Platform } from '@shared/types/common';

// Supported messaging channels
export type GatewayChannel = 'telegram' | 'whatsapp' | 'discord' | 'slack';

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
  /** Whether to enable Discord listener */
  enableDiscord?: boolean;
  /** Whether to enable Slack listener */
  enableSlack?: boolean;
  /** Message buffer delay in ms (default: 2000). Set to 0 to disable buffering. */
  messageBufferDelayMs?: number;
  /** Data composer for activity stream logging */
  dataComposer?: DataComposer;
}

export type IncomingMessageHandler = (
  channel: GatewayChannel,
  conversationId: string,
  sender: { id: string; name?: string },
  content: string,
  metadata?: {
    userId?: string;
    replyToMessageId?: string;
    media?: Array<{ type: 'image' | 'video' | 'audio' | 'document'; path?: string; url?: string }>;
    chatType?: 'direct' | 'group' | 'channel';
    mentions?: { users: string[]; botMentioned: boolean };
    platformAccountId?: string;
  }
) => Promise<void>;

// Typing indicator management
const activeTypingIntervals = new Map<string, NodeJS.Timeout>();
const activeTypingTimeouts = new Map<string, NodeJS.Timeout>();
const TYPING_INTERVAL_MS = 4000;
const TYPING_MAX_DURATION_MS = 10 * 60 * 1000; // 10 min max before auto-clear

// Message buffering configuration
const DEFAULT_BUFFER_DELAY_MS = 2000; // Wait 2 seconds for additional messages

interface BufferedMessage {
  content: string;
  timestamp: Date;
  media?: Array<{ type: 'image' | 'video' | 'audio' | 'document'; path?: string; url?: string }>;
}

interface MessageBuffer {
  channel: GatewayChannel;
  conversationId: string;
  sender: { id: string; name?: string };
  messages: BufferedMessage[];
  timer: NodeJS.Timeout;
  metadata?: {
    userId?: string;
    replyToMessageId?: string;
    chatType?: 'direct' | 'group' | 'channel';
    mentions?: { users: string[]; botMentioned: boolean };
    platformAccountId?: string;
  };
}

export class ChannelGateway extends EventEmitter {
  private telegramListener: TelegramListener | null = null;
  private whatsappListener: WhatsAppListener | null = null;
  private discordListener: DiscordListener | null = null;
  private slackListener: SlackListener | null = null;
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

  // Known agent names for mention detection in group chats
  private knownAgentNames: Set<string> = new Set();
  private mediaPipeline: InboundMediaPipeline = new InboundMediaPipeline();
  private textToSpeech: TextToSpeechService = TextToSpeechService.fromEnv();
  private autoVoiceReplyOnAudio = process.env.TELEGRAM_AUTO_VOICE_REPLY === 'true';
  private includeTextAfterVoiceReply = process.env.TELEGRAM_VOICE_INCLUDE_TEXT !== 'false';
  private pendingVoiceReplyConversations: Set<string> = new Set();
  private conversationUserMap = new Map<string, string>(); // channel:conversationId -> userId

  constructor(config: ChannelGatewayConfig = {}) {
    super();
    this.config = {
      enableTelegram: config.enableTelegram ?? !!env.TELEGRAM_BOT_TOKEN,
      telegramPollingInterval: config.telegramPollingInterval ?? 1000,
      enableWhatsApp: config.enableWhatsApp ?? process.env.ENABLE_WHATSAPP === 'true',
      whatsappAccountId: config.whatsappAccountId ?? 'default',
      printWhatsAppQr: config.printWhatsAppQr ?? true,
      enableDiscord: config.enableDiscord ?? process.env.ENABLE_DISCORD === 'true',
      enableSlack: config.enableSlack ?? process.env.ENABLE_SLACK === 'true',
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
   * Set known agent names for dynamic mention detection in group chats.
   * Called on startup after querying agent_identities from the DB.
   */
  setKnownAgentNames(names: string[]): void {
    this.knownAgentNames = new Set(names.map((n) => n.toLowerCase()));
    logger.info(`ChannelGateway: known agent names updated`, {
      names: [...this.knownAgentNames],
    });
  }

  /**
   * Check if any known agent (or the platform bot itself) is mentioned.
   * Used as the gate for processing group messages.
   */
  private isAgentMentioned(
    text: string,
    mentions?: { users: string[]; botMentioned: boolean }
  ): boolean {
    // Platform-native bot mention (e.g., @myra_help_bot in Telegram, <@UBOTID> in Slack)
    if (mentions?.botMentioned) return true;

    // Check mentioned usernames against known agent names
    if (mentions?.users?.length) {
      for (const mentioned of mentions.users) {
        const mentionedLower = mentioned.toLowerCase().replace(/^@/, '');
        if (this.knownAgentNames.has(mentionedLower)) return true;
      }
    }

    // Check message text for agent names (word-boundary match)
    if (this.knownAgentNames.size > 0) {
      const textLower = text.toLowerCase();
      for (const name of this.knownAgentNames) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (name.length >= 3 && new RegExp(`\\b${escaped}\\b`).test(textLower)) {
          return true;
        }
      }
    }

    return false;
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

    // Start Discord listener
    if (this.config.enableDiscord) {
      await this.startDiscord();
    } else {
      logger.info('Discord listener disabled (set ENABLE_DISCORD=true to enable)');
    }

    // Start Slack listener
    if (this.config.enableSlack) {
      await this.startSlack();
    } else {
      logger.info('Slack listener disabled (set ENABLE_SLACK=true to enable)');
    }

    this.started = true;
    logger.info('ChannelGateway started', {
      telegram: !!this.telegramListener,
      whatsapp: !!this.whatsappListener,
      discord: !!this.discordListener,
      slack: !!this.slackListener,
    });
  }

  /**
   * Stop the channel gateway
   */
  async stop(): Promise<void> {
    if (!this.started) return;

    logger.info('Stopping ChannelGateway...');

    // Clear all typing indicators and safety timeouts
    for (const [conversationId, interval] of activeTypingIntervals) {
      clearInterval(interval);
      activeTypingIntervals.delete(conversationId);
    }
    for (const [conversationId, timeout] of activeTypingTimeouts) {
      clearTimeout(timeout);
      activeTypingTimeouts.delete(conversationId);
    }

    this.pendingVoiceReplyConversations.clear();
    this.conversationUserMap.clear();

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

    if (this.discordListener) {
      await this.discordListener.stop();
      this.discordListener = null;
    }

    if (this.slackListener) {
      await this.slackListener.stop();
      this.slackListener = null;
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
  private getBufferKey(channel: GatewayChannel, conversationId: string): string {
    return `${channel}:${conversationId}`;
  }

  private toPersistentConversationPlatform(channel: GatewayChannel): Platform | null {
    // conversations.platform currently supports telegram/whatsapp/discord/api
    if (channel === 'telegram' || channel === 'whatsapp' || channel === 'discord') {
      return channel;
    }
    return null;
  }

  private async resolveUserIdForConversation(
    channel: GatewayChannel,
    conversationId: string
  ): Promise<string | undefined> {
    const key = this.getBufferKey(channel, conversationId);
    const cachedUserId = this.conversationUserMap.get(key);
    if (cachedUserId) return cachedUserId;

    const platform = this.toPersistentConversationPlatform(channel);
    if (!platform || !this.dataComposer) return undefined;

    try {
      const conversation =
        await this.dataComposer.repositories.conversations.findConversationByPlatformId(
          platform,
          conversationId
        );
      const userId = conversation?.user_id;
      if (!userId) return undefined;

      this.conversationUserMap.set(key, userId);
      return userId;
    } catch (error) {
      logger.warn('Failed to resolve conversation user from DB', {
        channel,
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private persistConversationUserMapping(
    channel: GatewayChannel,
    conversationId: string,
    userId: string
  ): void {
    const platform = this.toPersistentConversationPlatform(channel);
    if (!platform || !this.dataComposer) return;

    void this.dataComposer.repositories.conversations
      .upsertConversationByPlatformId({
        user_id: userId,
        platform,
        platform_conversation_id: conversationId,
      })
      .catch((error) => {
        logger.warn('Failed to persist conversation user mapping', {
          channel,
          conversationId,
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /**
   * Buffer an incoming message, batching rapid messages together
   */
  private bufferMessage(
    channel: GatewayChannel,
    conversationId: string,
    sender: { id: string; name?: string },
    content: string,
    metadata?: {
      userId?: string;
      replyToMessageId?: string;
      media?: Array<{
        type: 'image' | 'video' | 'audio' | 'document';
        path?: string;
        url?: string;
      }>;
      chatType?: 'direct' | 'group' | 'channel';
      mentions?: { users: string[]; botMentioned: boolean };
      platformAccountId?: string;
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
        this.flushBuffer(key).catch((err) => {
          logger.error(`Error flushing buffer for ${key}:`, err);
        });
      }, this.bufferDelayMs);

      this.messageBuffers.set(key, {
        channel,
        conversationId,
        sender,
        messages: [
          {
            content,
            timestamp: new Date(),
            media: metadata?.media,
          },
        ],
        timer,
        metadata: {
          userId: metadata?.userId,
          replyToMessageId: metadata?.replyToMessageId,
          chatType: metadata?.chatType,
          mentions: metadata?.mentions,
          platformAccountId: metadata?.platformAccountId,
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
        logger.info(
          `Queued ${buffer.messages.length} messages for ${key} (conversation already processing)`
        );
      }
      return;
    }

    // Mark conversation as processing
    this.processingConversations.add(key);

    // Combine all message contents
    const combinedContent = buffer.messages.map((m) => m.content).join('\n\n');

    // Combine all media
    const allMedia = buffer.messages.flatMap((m) => m.media || []);

    logger.info(`Flushing message buffer for ${key}`, {
      messageCount: buffer.messages.length,
      contentLength: combinedContent.length,
    });

    // Forward the combined message. On error, release the processing lock
    // so the conversation isn't permanently deadlocked.
    // On success, the lock is released by sendResponse → processPendingMessages.
    try {
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
    } catch (error) {
      logger.error(`Error in flushBuffer for ${key}, releasing processing lock:`, error);
      this.processingConversations.delete(key);
    }
  }

  /**
   * Forward a message to the handler (after buffering)
   */
  private async forwardToHandler(
    channel: GatewayChannel,
    conversationId: string,
    sender: { id: string; name?: string },
    content: string,
    metadata?: {
      userId?: string;
      replyToMessageId?: string;
      media?: Array<{
        type: 'image' | 'video' | 'audio' | 'document';
        path?: string;
        url?: string;
      }>;
      chatType?: 'direct' | 'group' | 'channel';
      mentions?: { users: string[]; botMentioned: boolean };
      platformAccountId?: string;
    }
  ): Promise<void> {
    logger.info(`Forwarding message to handler: ${channel}:${conversationId}`);
    if (!this.messageHandler) {
      logger.warn('No message handler set, dropping message');
      return;
    }

    // Resolve userId for activity stream logging
    // metadata.userId may be pre-set, otherwise resolve from platform + sender ID
    let userId = metadata?.userId;
    if (!userId && this.dataComposer && sender.id) {
      try {
        const user = await this.dataComposer.repositories.users.findByPlatformId(
          channel as 'telegram' | 'whatsapp' | 'discord' | 'slack',
          sender.id
        );
        if (user) {
          userId = user.id;
        }
      } catch (err) {
        logger.debug('Could not resolve userId from platform ID for activity logging:', err);
      }
    }
    if (userId) {
      this.conversationUserMap.set(this.getBufferKey(channel, conversationId), userId);
      this.persistConversationUserMapping(channel, conversationId, userId);
    }

    if (
      channel === 'telegram' &&
      this.autoVoiceReplyOnAudio &&
      metadata?.media?.some((attachment) => attachment.type === 'audio')
    ) {
      this.pendingVoiceReplyConversations.add(this.getBufferKey(channel, conversationId));
    }

    // Log incoming message to activity stream
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

    // Pass resolved userId to message handler so SessionService can persist messages
    const enrichedMetadata = userId && !metadata?.userId ? { ...metadata, userId } : metadata;

    try {
      await this.messageHandler(channel, conversationId, sender, content, enrichedMetadata);
    } catch (error) {
      logger.error(`Error forwarding message to handler:`, error);
      this.stopTypingIndicator(conversationId);

      // Release processing lock so conversation isn't permanently deadlocked
      const key = this.getBufferKey(channel, conversationId);
      this.processingConversations.delete(key);
      this.pendingVoiceReplyConversations.delete(key);

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
        } else if (channel === 'discord' && this.discordListener) {
          await this.discordListener.sendMessage(
            conversationId,
            'Sorry, I encountered an error processing your message. Please try again.'
          );
        } else if (channel === 'slack' && this.slackListener) {
          await this.slackListener.sendMessage(
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
        if (await this.trySendTelegramVoiceReply(response)) {
          if (this.includeTextAfterVoiceReply) {
            await this.sendTelegramMessage(conversationId, content, { format, replyToMessageId });
          } else {
            await this.logOutgoingTelegram(conversationId, content);
          }
          break;
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
          const userId = await this.resolveUserIdForConversation('whatsapp', conversationId);
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
              logger.warn(
                'Failed to log outgoing WhatsApp message to activity stream:',
                activityError
              );
            }
          }
        }
        break;

      case 'discord':
        if (!this.discordListener) {
          throw new Error('Discord listener not available');
        }
        await this.discordListener.sendMessage(conversationId, content);
        // Log outgoing Discord message to activity stream
        {
          const userId = await this.resolveUserIdForConversation('discord', conversationId);
          if (this.dataComposer && userId) {
            try {
              await this.dataComposer.repositories.activityStream.logMessage({
                userId,
                agentId: 'benson',
                direction: 'out',
                content,
                platform: 'discord',
                platformChatId: conversationId,
                isDm: true,
              });
            } catch (activityError) {
              logger.warn(
                'Failed to log outgoing Discord message to activity stream:',
                activityError
              );
            }
          }
        }
        break;

      case 'slack':
        if (!this.slackListener) {
          throw new Error('Slack listener not available');
        }
        await this.slackListener.sendMessage(conversationId, content);
        // Log outgoing Slack message to activity stream
        {
          const userId = await this.resolveUserIdForConversation('slack', conversationId);
          if (this.dataComposer && userId) {
            try {
              await this.dataComposer.repositories.activityStream.logMessage({
                userId,
                agentId: 'slack', // Will be resolved by routing
                direction: 'out',
                content,
                platform: 'slack',
                platformChatId: conversationId,
                isDm: true,
              });
            } catch (activityError) {
              logger.warn(
                'Failed to log outgoing Slack message to activity stream:',
                activityError
              );
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
    await this.processPendingMessages(channel as GatewayChannel, conversationId);
  }

  /**
   * Process any messages that were queued while the conversation was being processed.
   * This ensures messages that arrived during Claude Code processing are handled as a batch.
   */
  private async processPendingMessages(
    channel: GatewayChannel,
    conversationId: string
  ): Promise<void> {
    const key = this.getBufferKey(channel, conversationId);
    const pendingBuffer = this.pendingBuffers.get(key);

    if (pendingBuffer) {
      // Remove from pending and process
      this.pendingBuffers.delete(key);

      // Combine all pending message contents
      const combinedContent = pendingBuffer.messages.map((m) => m.content).join('\n\n');

      const allMedia = pendingBuffer.messages.flatMap((m) => m.media || []);

      logger.info(`Processing ${pendingBuffer.messages.length} pending messages for ${key}`, {
        messageCount: pendingBuffer.messages.length,
        contentLength: combinedContent.length,
      });

      // Start typing indicator for the new batch
      this.startTypingIndicator(conversationId, channel);

      // Forward to handler (conversation is still marked as processing)
      await this.forwardToHandler(channel, conversationId, pendingBuffer.sender, combinedContent, {
        ...pendingBuffer.metadata,
        media: allMedia.length > 0 ? allMedia : undefined,
      });
    } else {
      // No pending messages - release the processing lock
      this.processingConversations.delete(key);
      logger.debug(`Released processing lock for ${key}`);
    }
  }

  /**
   * Release the processing lock for a conversation and process any pending messages.
   * Call this when message processing completes, even if no response was sent.
   * This prevents conversations from getting stuck.
   */
  async releaseConversation(
    channel: GatewayChannel,
    conversationId: string,
    autoResponse?: { content: string; format?: 'text' | 'markdown' }
  ): Promise<void> {
    const key = this.getBufferKey(channel, conversationId);

    // If an auto-response was provided, send it first
    if (autoResponse && autoResponse.content) {
      try {
        await this.sendResponse({
          channel,
          conversationId,
          content: autoResponse.content,
          format: autoResponse.format,
        });
        // sendResponse will call processPendingMessages, so we're done
        return;
      } catch (error) {
        logger.error(`Failed to send auto-response for ${key}:`, error);
        // Continue to release the lock even if send fails
      }
    }

    // Stop typing indicator
    this.stopTypingIndicator(conversationId);

    // Process pending messages (which will also release the lock)
    this.pendingVoiceReplyConversations.delete(key);
    await this.processPendingMessages(channel, conversationId);
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

    await this.logOutgoingTelegram(conversationId, content);
  }

  private async logOutgoingTelegram(conversationId: string, content: string): Promise<void> {
    // Log outgoing message to activity stream
    const userId = await this.resolveUserIdForConversation('telegram', conversationId);
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

  private shouldUseVoiceReply(response: AgentResponse): boolean {
    if (response.channel !== 'telegram') return false;

    const key = this.getBufferKey('telegram', response.conversationId);
    const metadata = response.metadata as Record<string, unknown> | undefined;
    const explicitVoiceRequest =
      metadata?.voiceReply === true ||
      metadata?.voice === true ||
      metadata?.outputMode === 'voice' ||
      metadata?.format === 'voice';
    if (explicitVoiceRequest) {
      this.pendingVoiceReplyConversations.delete(key);
      return true;
    }

    if (!this.autoVoiceReplyOnAudio) return false;
    if (!this.pendingVoiceReplyConversations.has(key)) return false;
    this.pendingVoiceReplyConversations.delete(key);
    return true;
  }

  private async trySendTelegramVoiceReply(response: AgentResponse): Promise<boolean> {
    if (!this.telegramListener) return false;
    if (!this.textToSpeech.isEnabled()) return false;
    if (!this.shouldUseVoiceReply(response)) return false;

    const audio = await this.textToSpeech.synthesize({ text: response.content });
    if (!audio) return false;

    try {
      await this.telegramListener.sendVoice(response.conversationId, audio.filePath, {
        replyToMessageId: response.replyToMessageId,
        contentType: audio.contentType,
        filename: audio.filename,
      });
      return true;
    } catch (error) {
      logger.warn('Failed to send Telegram voice reply, falling back to text', {
        conversationId: response.conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      await audio.cleanup().catch((cleanupError) => {
        logger.debug('Failed to clean up synthesized audio file', cleanupError);
      });
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

      await this.mediaPipeline.preprocess(message);

      // In group chats, only respond if bot or any known agent is mentioned
      if (isGroupChat && !this.isAgentMentioned(message.body, message.mentions)) {
        logger.debug('Skipping group message - no agent mentioned');
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
          platformAccountId: message.accountId,
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

      await this.mediaPipeline.preprocess(message);

      // In group chats, only respond if bot or any known agent is mentioned
      if (isGroupChat && !this.isAgentMentioned(message.body, message.mentions)) {
        logger.debug('Skipping WhatsApp group message - no agent mentioned');
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
          platformAccountId: message.accountId,
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
   * Start Discord listener
   */
  private async startDiscord(): Promise<void> {
    if (!env.DISCORD_BOT_TOKEN) {
      logger.warn('DISCORD_BOT_TOKEN not set - Discord listener disabled');
      return;
    }

    logger.info('Creating Discord listener...');
    this.discordListener = createDiscordListener();

    // Wire up message handling
    this.discordListener.onMessage(async (message) => {
      const senderId = message.sender.id || 'unknown';
      const conversationId = message.conversationId || senderId;
      const isGroupChat = message.chatType === 'group' || message.chatType === 'channel';

      await this.mediaPipeline.preprocess(message);

      // In group chats, only respond if bot or any known agent is mentioned
      if (isGroupChat && !this.isAgentMentioned(message.body, message.mentions)) {
        logger.debug('Skipping Discord group message - no agent mentioned');
        return;
      }

      // Start typing indicator
      this.startTypingIndicator(conversationId, 'discord');

      // Buffer the message
      this.bufferMessage(
        'discord',
        conversationId,
        { id: senderId, name: message.sender.name || message.sender.username },
        message.body,
        {
          media: message.media,
          chatType: message.chatType,
          mentions: message.mentions,
          platformAccountId: message.accountId,
        }
      );
    });

    // Forward events
    this.discordListener.on('connected', (bot: { username: string; id: string }) => {
      logger.info(`Discord bot connected: @${bot.username}`);
      this.emit('discord:connected', bot);
    });

    this.discordListener.on('error', (error: Error) => {
      logger.error('Discord listener error:', error);
      this.emit('discord:error', error);
    });

    await this.discordListener.start();
    logger.info('Discord listener started');
  }

  /**
   * Start Slack listener
   */
  private async startSlack(): Promise<void> {
    if (!env.SLACK_BOT_TOKEN || !env.SLACK_APP_TOKEN) {
      logger.warn('SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set - Slack listener disabled');
      return;
    }

    logger.info('Creating Slack listener...');
    this.slackListener = createSlackListener({
      botToken: env.SLACK_BOT_TOKEN,
      appToken: env.SLACK_APP_TOKEN,
    });

    // Wire up message handling
    this.slackListener.onMessage(async (message) => {
      const senderId = message.sender.id || 'unknown';
      const conversationId = message.conversationId || senderId;
      const isGroupChat = message.chatType === 'group' || message.chatType === 'channel';

      await this.mediaPipeline.preprocess(message);

      // In group chats, only respond if bot or any known agent is mentioned
      if (isGroupChat && !this.isAgentMentioned(message.body, message.mentions)) {
        logger.debug('Skipping Slack group message - no agent mentioned');
        return;
      }

      // Start typing indicator (no-op for Slack, but keeps pattern consistent)
      this.startTypingIndicator(conversationId, 'slack');

      // Buffer the message
      this.bufferMessage(
        'slack',
        conversationId,
        { id: senderId, name: message.sender.name || message.sender.username },
        message.body,
        {
          media: message.media,
          chatType: message.chatType,
          mentions: message.mentions,
          platformAccountId: message.accountId,
        }
      );
    });

    // Forward events
    this.slackListener.on('connected', (bot: { username: string; id: string }) => {
      logger.info(`Slack bot connected: @${bot.username} (${bot.id})`);
      this.emit('slack:connected', bot);
    });

    this.slackListener.on('error', (error: Error) => {
      logger.error('Slack listener error:', error);
      this.emit('slack:error', error);
    });

    await this.slackListener.start();
    logger.info('Slack listener started');
  }

  /**
   * Start a typing indicator that refreshes every 4s
   */
  private startTypingIndicator(conversationId: string, channel: GatewayChannel): void {
    this.stopTypingIndicator(conversationId);

    const sendTyping = () => {
      if (channel === 'telegram' && this.telegramListener) {
        this.telegramListener.sendTypingIndicator(conversationId);
      } else if (channel === 'whatsapp' && this.whatsappListener) {
        this.whatsappListener.sendTypingIndicator(conversationId);
      } else if (channel === 'discord' && this.discordListener) {
        this.discordListener.sendTypingIndicator(conversationId);
      } else if (channel === 'slack' && this.slackListener) {
        this.slackListener.sendTypingIndicator(conversationId);
      }
    };

    // Send immediately
    sendTyping();

    // Refresh every 4 seconds
    const interval = setInterval(sendTyping, TYPING_INTERVAL_MS);

    activeTypingIntervals.set(conversationId, interval);

    // Safety net: auto-clear after max duration to prevent infinite loops
    const maxTimeout = setTimeout(() => {
      logger.warn('Typing indicator hit max duration, auto-clearing', {
        conversationId,
        maxDurationMs: TYPING_MAX_DURATION_MS,
      });
      this.stopTypingIndicator(conversationId);
    }, TYPING_MAX_DURATION_MS);

    activeTypingTimeouts.set(conversationId, maxTimeout);
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

    const timeout = activeTypingTimeouts.get(conversationId);
    if (timeout) {
      clearTimeout(timeout);
      activeTypingTimeouts.delete(conversationId);
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

  getDiscordListener(): DiscordListener | null {
    return this.discordListener;
  }

  getSlackListener(): SlackListener | null {
    return this.slackListener;
  }

  isStarted(): boolean {
    return this.started;
  }

  getStatus(): {
    started: boolean;
    telegram: { enabled: boolean; connected: boolean };
    whatsapp: { enabled: boolean; connected: boolean };
    discord: { enabled: boolean; connected: boolean };
    slack: { enabled: boolean; connected: boolean };
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
      discord: {
        enabled: this.config.enableDiscord ?? false,
        connected: this.discordListener?.connected ?? false,
      },
      slack: {
        enabled: this.config.enableSlack ?? false,
        connected: this.slackListener?.connected ?? false,
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
