/**
 * Clawdbot Bridge
 *
 * This module bridges clawdbot's message context format to our personal context system.
 * It provides utilities to:
 * 1. Convert clawdbot's MsgContext to our InboundMessage format
 * 2. Hook into clawdbot's message flow
 * 3. Send responses back through clawdbot's channel system
 *
 * Integration approach:
 * - Clawdbot uses a plugin system with channel adapters
 * - We create a middleware that intercepts messages before AI processing
 * - Extract and save relevant context (links, notes, etc.)
 * - Optionally modify or augment the AI's context with saved data
 */

import type { ChannelAdapter } from './adapter';
import type { InboundMessage, ChannelPlatform, ChatType, ProcessingResult } from './types';
import { logger } from '../utils/logger';

/**
 * Clawdbot message context format (simplified version of their MsgContext)
 * This mirrors the structure in clawdbot's auto-reply/templating.ts
 */
export interface ClawdbotMsgContext {
  // Core fields
  Body: string;
  RawBody?: string;
  From: string;
  To?: string;
  Provider: string;
  Surface?: string;

  // Chat/conversation info
  ChatType?: 'direct' | 'group' | 'channel' | 'thread';
  ConversationLabel?: string;
  GroupSubject?: string;
  SessionKey?: string;
  AccountId?: string;

  // Sender info
  SenderName?: string;
  SenderId?: string;
  SenderUsername?: string;

  // Message metadata
  MessageSid?: string;
  Timestamp?: number;

  // Reply context
  ReplyToId?: string;
  ReplyToBody?: string;
  ReplyToSender?: string;

  // Forwarded content
  ForwardedFrom?: string;
  ForwardedFromId?: string;
  ForwardedDate?: number;

  // Media
  MediaPath?: string;
  MediaPaths?: string[];
  MediaType?: string;
  MediaTypes?: string[];
  MediaUrl?: string;
  MediaUrls?: string[];

  // Location
  Latitude?: number;
  Longitude?: number;
  LocationName?: string;
  LocationAddress?: string;

  // Mention/command state
  WasMentioned?: boolean;
  CommandAuthorized?: boolean;
  CommandBody?: string;
}

/**
 * Map clawdbot provider names to our platform types
 */
const PROVIDER_TO_PLATFORM: Record<string, ChannelPlatform> = {
  telegram: 'telegram',
  whatsapp: 'whatsapp',
  discord: 'discord',
  slack: 'slack',
  signal: 'signal',
  imessage: 'imessage',
  bluebubbles: 'imessage',
};

/**
 * Convert clawdbot's MsgContext to our InboundMessage format
 */
export function convertClawdbotContext(ctx: ClawdbotMsgContext): InboundMessage | null {
  const platform = PROVIDER_TO_PLATFORM[ctx.Provider?.toLowerCase() || ''];
  if (!platform) {
    logger.warn(`Unknown clawdbot provider: ${ctx.Provider}`);
    return null;
  }

  // Parse the "From" field to extract sender ID
  // Clawdbot format: "telegram:123456789" or "whatsapp:+1234567890"
  const fromParts = ctx.From?.split(':') || [];
  const senderId = fromParts.length > 1 ? fromParts.slice(1).join(':') : ctx.SenderId;

  // Determine phone number for WhatsApp
  let phone: string | undefined;
  if (platform === 'whatsapp' && senderId) {
    // WhatsApp IDs are often phone numbers
    phone = senderId.replace('@s.whatsapp.net', '').replace('@c.us', '');
  }

  // Build media attachments
  const media = buildMediaAttachments(ctx);

  const message: InboundMessage = {
    body: ctx.Body,
    rawBody: ctx.RawBody || ctx.Body,
    timestamp: ctx.Timestamp,
    messageId: ctx.MessageSid,
    platform,
    chatType: mapChatType(ctx.ChatType),
    accountId: ctx.AccountId,
    sender: {
      id: senderId || ctx.SenderId,
      username: ctx.SenderUsername,
      name: ctx.SenderName,
      phone,
    },
    conversationId: ctx.SessionKey,
    conversationLabel: ctx.ConversationLabel,
    groupSubject: ctx.GroupSubject,
    raw: ctx,
  };

  // Add reply context if present
  if (ctx.ReplyToId || ctx.ReplyToBody) {
    message.replyTo = {
      id: ctx.ReplyToId,
      body: ctx.ReplyToBody,
      sender: ctx.ReplyToSender,
    };
  }

  // Add forwarded context if present
  if (ctx.ForwardedFrom || ctx.ForwardedFromId) {
    message.forwarded = {
      from: ctx.ForwardedFrom,
      fromId: ctx.ForwardedFromId,
      date: ctx.ForwardedDate,
    };
  }

  // Add media if present
  if (media.length > 0) {
    message.media = media;
  }

  // Add location if present
  if (ctx.Latitude != null && ctx.Longitude != null) {
    message.location = {
      latitude: ctx.Latitude,
      longitude: ctx.Longitude,
      name: ctx.LocationName,
      address: ctx.LocationAddress,
    };
  }

  return message;
}

/**
 * Map clawdbot chat type to our chat type
 */
function mapChatType(chatType?: string): ChatType {
  switch (chatType?.toLowerCase()) {
    case 'group':
      return 'group';
    case 'channel':
      return 'channel';
    case 'thread':
      return 'group'; // Treat threads as groups
    default:
      return 'direct';
  }
}

/**
 * Build media attachments from clawdbot context
 */
function buildMediaAttachments(ctx: ClawdbotMsgContext) {
  const media: InboundMessage['media'] = [];

  if (ctx.MediaPaths && ctx.MediaPaths.length > 0) {
    const types = ctx.MediaTypes || [];
    const urls = ctx.MediaUrls || [];

    for (let i = 0; i < ctx.MediaPaths.length; i++) {
      media.push({
        type: guessMediaType(types[i] || ctx.MediaType),
        path: ctx.MediaPaths[i],
        url: urls[i] || ctx.MediaUrls?.[i],
        contentType: types[i] || ctx.MediaType,
      });
    }
  } else if (ctx.MediaPath) {
    media.push({
      type: guessMediaType(ctx.MediaType),
      path: ctx.MediaPath,
      url: ctx.MediaUrl,
      contentType: ctx.MediaType,
    });
  }

  return media;
}

/**
 * Guess media type from content type
 */
function guessMediaType(contentType?: string): 'image' | 'video' | 'audio' | 'document' {
  if (!contentType) return 'document';

  const lower = contentType.toLowerCase();
  if (lower.startsWith('image/')) return 'image';
  if (lower.startsWith('video/')) return 'video';
  if (lower.startsWith('audio/') || lower.includes('voice')) return 'audio';
  return 'document';
}

/**
 * ClawdbotBridge class for managing the integration
 */
export class ClawdbotBridge {
  private adapter: ChannelAdapter;

  constructor(adapter: ChannelAdapter) {
    this.adapter = adapter;
  }

  /**
   * Process a clawdbot message context
   * This is the main entry point for the bridge
   */
  async processContext(ctx: ClawdbotMsgContext): Promise<ProcessingResult> {
    const message = convertClawdbotContext(ctx);
    if (!message) {
      return {
        success: false,
        saved: { links: 0, notes: 0, tasks: 0, reminders: 0 },
        errors: ['Could not convert clawdbot context'],
      };
    }

    return this.adapter.processMessage(message);
  }

  /**
   * Create a middleware function for clawdbot's message pipeline
   * This can be inserted into clawdbot's processing chain
   *
   * Usage in clawdbot:
   * ```ts
   * const bridge = new ClawdbotBridge(adapter);
   * // In message handler:
   * await bridge.middleware(ctx, async () => {
   *   // Continue with normal processing
   * });
   * ```
   */
  middleware() {
    return async (ctx: ClawdbotMsgContext, next: () => Promise<void>) => {
      // Process the message through our system
      const result = await this.processContext(ctx);

      if (result.success && result.response) {
        logger.info(`Processed message: ${result.response}`);
      }

      // Continue with clawdbot's normal processing
      await next();
    };
  }
}

/**
 * Create a clawdbot bridge instance
 */
export function createClawdbotBridge(adapter: ChannelAdapter): ClawdbotBridge {
  return new ClawdbotBridge(adapter);
}

/**
 * Example integration with clawdbot's Telegram bot
 *
 * This shows how you would integrate with clawdbot's message handling:
 *
 * ```ts
 * // In your main setup file:
 * import { createChannelAdapter } from './channels/adapter';
 * import { createClawdbotBridge } from './channels/clawdbot-bridge';
 * import { DataComposer } from './data/composer';
 *
 * const dataComposer = new DataComposer(supabaseClient);
 * const adapter = createChannelAdapter(dataComposer, {
 *   enabledPlatforms: ['telegram', 'whatsapp'],
 *   autoExtract: { links: true },
 * });
 * const bridge = createClawdbotBridge(adapter);
 *
 * // In clawdbot's telegram bot handler (e.g., bot-message.ts):
 * // After building the message context, call:
 * const result = await bridge.processContext(ctxPayload);
 *
 * // Optionally include saved context in the AI prompt:
 * if (result.saved.links > 0) {
 *   ctxPayload.Body += `\n\n[System: Saved ${result.saved.links} links to your personal context]`;
 * }
 * ```
 */
