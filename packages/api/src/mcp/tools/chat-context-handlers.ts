/**
 * MCP Tool Handlers for Chat Context
 *
 * These tools enable Claude to fetch recent chat history for context
 * and clear it after summarizing (privacy-respecting pattern).
 *
 * Messages are ephemeral - stored in memory only, with TTL expiration.
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import type { TelegramListener } from '../../channels/telegram-listener';
import { logger } from '../../utils/logger';

// Type for the ephemeral message from channel listeners
interface EphemeralMessage {
  messageId: number | string;
  chatId: string;
  from: string;
  fromId: string;
  text: string;
  timestamp: Date;
}

// Channel listener interface (can extend to other platforms)
interface ChannelListener {
  getRecentMessages(chatId: string, limit?: number): EphemeralMessage[];
  clearMessageCache(chatId: string): void;
  getCacheStats?(): { chatCount: number; totalMessages: number };
}

// Registered channel listeners
const channelListeners: Map<string, ChannelListener> = new Map();

/**
 * Register a channel listener for chat context fetching
 * Called by server.ts after creating channel listeners
 */
export function registerChannelListener(channel: string, listener: ChannelListener): void {
  channelListeners.set(channel, listener);
  logger.info(`Channel listener registered for ${channel}`);
}

/**
 * Register Telegram listener specifically (convenience method)
 */
export function setTelegramListener(listener: TelegramListener): void {
  registerChannelListener('telegram', listener);
}

/**
 * Get a registered channel listener
 */
export function getChannelListener(channel: string): ChannelListener | null {
  return channelListeners.get(channel) || null;
}

// ============================================================================
// MCP Tool Response Helper
// ============================================================================

type McpResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function mcpResponse(data: object, isError = false): McpResponse {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    isError,
  };
}

// ============================================================================
// GET CHAT CONTEXT
// ============================================================================

export const getChatContextSchema = z.object({
  channel: z.enum(['telegram', 'discord', 'whatsapp']).describe('Channel to get context from'),
  conversationId: z.string().describe('Conversation/chat ID to get history from'),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(50)
    .describe('Maximum messages to return (default: 50)'),
});

export async function handleGetChatContext(
  args: z.infer<typeof getChatContextSchema>,
  _dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const listener = channelListeners.get(args.channel);

    if (!listener) {
      return mcpResponse(
        {
          success: false,
          error: `No listener registered for channel: ${args.channel}`,
          hint: 'The channel may not be configured or running.',
        },
        true
      );
    }

    // Clean up conversation ID (remove prefix if present)
    const chatId = args.conversationId.startsWith(`${args.channel}:`)
      ? args.conversationId.replace(`${args.channel}:`, '')
      : args.conversationId;

    const messages = listener.getRecentMessages(chatId, args.limit);

    if (messages.length === 0) {
      return mcpResponse({
        success: true,
        messages: [],
        count: 0,
        note: 'No recent messages in cache. Messages are cached for 30 minutes.',
      });
    }

    // Format messages for readability
    const formattedMessages = messages.map((msg) => ({
      from: msg.from,
      text: msg.text,
      timestamp: msg.timestamp.toISOString(),
      messageId: msg.messageId,
    }));

    logger.info(`Retrieved ${messages.length} messages for context`, {
      channel: args.channel,
      chatId,
    });

    return mcpResponse({
      success: true,
      channel: args.channel,
      conversationId: chatId,
      messages: formattedMessages,
      count: messages.length,
      note: 'These messages are ephemeral (30 min TTL). Call clear_chat_context after summarizing.',
    });
  } catch (error) {
    logger.error('Error in get_chat_context:', error);
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get chat context',
      },
      true
    );
  }
}

// ============================================================================
// CLEAR CHAT CONTEXT
// ============================================================================

export const clearChatContextSchema = z.object({
  channel: z.enum(['telegram', 'discord', 'whatsapp']).describe('Channel to clear context for'),
  conversationId: z.string().describe('Conversation/chat ID to clear'),
});

export async function handleClearChatContext(
  args: z.infer<typeof clearChatContextSchema>,
  _dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const listener = channelListeners.get(args.channel);

    if (!listener) {
      return mcpResponse(
        {
          success: false,
          error: `No listener registered for channel: ${args.channel}`,
        },
        true
      );
    }

    // Clean up conversation ID
    const chatId = args.conversationId.startsWith(`${args.channel}:`)
      ? args.conversationId.replace(`${args.channel}:`, '')
      : args.conversationId;

    listener.clearMessageCache(chatId);

    logger.info(`Cleared message cache for ${args.channel}:${chatId}`);

    return mcpResponse({
      success: true,
      channel: args.channel,
      conversationId: chatId,
      message: 'Message cache cleared. Memory freed.',
    });
  } catch (error) {
    logger.error('Error in clear_chat_context:', error);
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to clear chat context',
      },
      true
    );
  }
}

// ============================================================================
// GET CACHE STATS (for debugging/monitoring)
// ============================================================================

export const getCacheStatsSchema = z.object({
  channel: z
    .enum(['telegram', 'discord', 'whatsapp'])
    .optional()
    .describe('Specific channel to get stats for (default: all)'),
});

export async function handleGetCacheStats(
  args: z.infer<typeof getCacheStatsSchema>,
  _dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const stats: Record<string, { chatCount: number; totalMessages: number }> = {};

    if (args.channel) {
      const listener = channelListeners.get(args.channel);
      if (listener?.getCacheStats) {
        stats[args.channel] = listener.getCacheStats();
      }
    } else {
      for (const [channel, listener] of channelListeners) {
        if (listener.getCacheStats) {
          stats[channel] = listener.getCacheStats();
        }
      }
    }

    return mcpResponse({
      success: true,
      stats,
      registeredChannels: Array.from(channelListeners.keys()),
    });
  } catch (error) {
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get cache stats',
      },
      true
    );
  }
}
