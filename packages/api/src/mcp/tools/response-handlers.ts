/**
 * MCP Tool Handlers for Response Routing
 *
 * These tools enable Claude to send responses back to specific channels.
 * This is the standardized output mechanism for the agent backends.
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import type { ChannelType, AgentResponse, ResponseFormat, OutboundMedia } from '../../agent/types';
import { logger } from '../../utils/logger';
import { getPinnedAgentId, getRequestContext } from '../../utils/request-context';

// Response result returned by the callback (optional — void is still accepted)
export interface ResponseResult {
  mediaSent?: number;
  mediaFailed?: number;
  mediaErrors?: string[];
}

// Response handler callback type
export type ResponseCallback = (response: AgentResponse) => Promise<ResponseResult | void>;

// Global response callback - set by the session host
let globalResponseCallback: ResponseCallback | null = null;

// Track which conversations have received explicit responses via send_response
// Key: "channel:conversationId", Value: timestamp of last response
const explicitResponseTracker: Map<string, number> = new Map();

/**
 * Register the global response callback
 * Called by the session host to handle send_response tool calls
 */
export function setResponseCallback(callback: ResponseCallback): void {
  globalResponseCallback = callback;
}

/**
 * Get the current response callback
 */
export function getResponseCallback(): ResponseCallback | null {
  return globalResponseCallback;
}

/**
 * Check if a conversation has received an explicit send_response during this
 * turn. Turn-scoped, not time-windowed — ink turns can run for many minutes,
 * so a fixed time window would miss early responses. Call clearExplicitResponse
 * after the auto-forward decision to reset for the next turn.
 */
export function hasExplicitResponse(channel: string, conversationId: string): boolean {
  const key = `${channel}:${conversationId}`;
  return explicitResponseTracker.has(key);
}

/**
 * Clear explicit response tracking for a conversation (call after the
 * auto-forward decision in server.ts). No time-based sweep — the map is
 * naturally bounded (one entry per active conversation) and each turn
 * clears its own key. Stale entries from error paths are overwritten on
 * the next message to the same conversation.
 */
export function clearExplicitResponse(channel: string, conversationId: string): void {
  const key = `${channel}:${conversationId}`;
  explicitResponseTracker.delete(key);
}

/**
 * Mark a conversation as having received an explicit response. No cleanup
 * here — concurrent turns' markers must not be swept mid-turn. Cleanup
 * happens in clearExplicitResponse after the auto-forward decision.
 */
function markExplicitResponse(channel: string, conversationId: string): void {
  const key = `${channel}:${conversationId}`;
  explicitResponseTracker.set(key, Date.now());
}

interface TtsConfig {
  defaultVoice?: string;
  voices?: Record<string, string>;
}

async function resolveAgentDefaultVoice(dataComposer: DataComposer): Promise<string | undefined> {
  try {
    const reqCtx = getRequestContext();
    const agentId = reqCtx?.agentId || getPinnedAgentId();
    if (!agentId) return undefined;

    const { data } = await dataComposer
      .getClient()
      .from('agent_identities')
      .select('tts_config')
      .eq('agent_id', agentId)
      .not('tts_config', 'is', null)
      .limit(1)
      .single();

    const config = data?.tts_config as TtsConfig | null;
    return config?.defaultVoice || undefined;
  } catch {
    return undefined;
  }
}

// ============================================================================
// SEND RESPONSE
// ============================================================================

const outboundMediaSchema = z.object({
  type: z
    .enum(['image', 'video', 'audio', 'document'])
    .describe('Media type (determines upload method per channel)'),
  path: z.string().optional().describe('Local file path to upload'),
  url: z.string().optional().describe('Remote URL (some channels support direct URL sending)'),
  contentType: z.string().optional().describe('MIME type (auto-detected if omitted)'),
  filename: z.string().optional().describe('Display filename'),
  caption: z.string().optional().describe('Caption for this attachment'),
});

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv']);
const AUDIO_EXTENSIONS = new Set(['m4a', 'mp3', 'ogg', 'oga', 'opus', 'wav', 'aac', 'flac']);

export function inferMediaTypeFromPath(
  pathOrUrl: string
): 'image' | 'video' | 'audio' | 'document' {
  const ext =
    pathOrUrl
      .toLowerCase()
      .replace(/[?#].*$/, '')
      .split('.')
      .pop() ?? '';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return 'document';
}

/**
 * One media entry: the canonical {type, path|url, ...} object, or a bare
 * path/URL string coerced into one. Agents naturally write
 * media: ["/path/file.m4a"], and rejecting that shape cost a real outbound
 * Telegram message (Aug 13 silent-drop bug) — coerce it, inferring the type
 * from the file extension.
 */
export const outboundMediaEntrySchema = z.union([
  outboundMediaSchema,
  z
    .string()
    .transform(
      (entry): z.infer<typeof outboundMediaSchema> =>
        /^https?:\/\//i.test(entry)
          ? { type: inferMediaTypeFromPath(entry), url: entry }
          : { type: inferMediaTypeFromPath(entry), path: entry }
    ),
]);

export const sendResponseSchema = z.object({
  channel: z
    .enum(['telegram', 'terminal', 'discord', 'whatsapp', 'slack', 'http', 'api', 'agent'])
    .describe('Channel to send the response to'),
  conversationId: z.string().describe('Conversation ID to route the response to'),
  content: z.string().describe('The response content to send'),
  format: z
    .enum(['text', 'markdown', 'code', 'json'])
    .optional()
    .describe('Format of the response content'),
  replyToMessageId: z.string().optional().describe('Message ID to reply to (for threading)'),
  voiceReply: z
    .boolean()
    .optional()
    .describe(
      'Send as a voice note instead of text (Telegram only). Uses on-device TTS, zero API cost.'
    ),
  ttsVoice: z
    .enum(['serena', 'vivian', 'sohee', 'ono_anna', 'ryan', 'aiden', 'eric', 'dylan'])
    .optional()
    .describe(
      'Override voice for TTS synthesis. Only used when voiceReply is true. Omit to use the agent default from tts_config.'
    ),
  metadata: z.record(z.unknown()).optional().describe('Additional channel-specific metadata'),
  media: z
    .array(outboundMediaEntrySchema)
    .optional()
    .describe(
      'Media attachments to send. Each entry is {type, path|url, ...} — a bare path/URL string is also accepted and coerced.'
    ),
});

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

// Myra's HTTP endpoint for message routing (fallback when no local callback)
const MYRA_SEND_ENDPOINT = process.env.MYRA_SEND_URL || 'http://localhost:3003/api/admin/send';

export async function handleSendResponse(
  args: z.infer<typeof sendResponseSchema>,
  _dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    logger.info(`send_response called for channel: ${args.channel}`, {
      conversationId: args.conversationId,
      contentLength: args.content.length,
      mediaCount: args.media?.length || 0,
      mediaPaths: args.media?.map((m) => m.path || m.url || 'none'),
    });

    // Merge voice fields into metadata so the gateway's TTS path picks them up
    const metadata: Record<string, unknown> = { ...args.metadata };
    if (args.voiceReply) metadata.voiceReply = true;
    if (args.ttsVoice) {
      metadata.ttsVoice = args.ttsVoice;
    } else {
      // Resolve default voice from agent's tts_config
      const resolvedVoice = await resolveAgentDefaultVoice(_dataComposer);
      if (resolvedVoice) metadata.ttsVoice = resolvedVoice;
    }

    const response: AgentResponse = {
      channel: args.channel as ChannelType,
      conversationId: args.conversationId,
      content: args.content,
      format: args.format as ResponseFormat | undefined,
      replyToMessageId: args.replyToMessageId,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      media: args.media as OutboundMedia[] | undefined,
    };

    // Mark this conversation as having received an explicit response
    markExplicitResponse(args.channel, args.conversationId);

    // Try local callback first (when running in same process as session host)
    let callbackResult: ResponseResult | void = undefined;
    if (globalResponseCallback) {
      callbackResult = await globalResponseCallback(response);
      logger.info(`Response sent to ${args.channel}:${args.conversationId} via local callback`);
    } else {
      // Fallback: route through Myra's HTTP endpoint for external channels
      if (args.channel === 'telegram' || args.channel === 'whatsapp' || args.channel === 'slack') {
        logger.info(`Routing ${args.channel} message through Myra's HTTP endpoint`);
        const httpResponse = await fetch(MYRA_SEND_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel: args.channel,
            conversationId: args.conversationId,
            content: args.content,
            media: args.media,
          }),
        });

        if (!httpResponse.ok) {
          const errorData = (await httpResponse.json().catch(() => ({}))) as { error?: string };
          throw new Error(`Myra send failed: ${errorData.error || httpResponse.statusText}`);
        }

        logger.info(`Response sent to ${args.channel}:${args.conversationId} via Myra HTTP`);
      } else {
        logger.warn(`No routing available for channel: ${args.channel}`);
        return mcpResponse(
          {
            success: false,
            error: `No routing configured for channel: ${args.channel}`,
          },
          true
        );
      }
    }

    const result: Record<string, unknown> = {
      success: true,
      channel: args.channel,
      conversationId: args.conversationId,
      contentLength: args.content.length,
      mediaRequested: args.media?.length || 0,
    };

    // Surface media delivery counters from the gateway if available
    if (callbackResult) {
      if (callbackResult.mediaSent !== undefined) result.mediaSent = callbackResult.mediaSent;
      if (callbackResult.mediaFailed !== undefined) result.mediaFailed = callbackResult.mediaFailed;
      if (callbackResult.mediaErrors?.length) result.mediaErrors = callbackResult.mediaErrors;
    }

    return mcpResponse(result);
  } catch (error) {
    logger.error('Error in send_response:', error);
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to send response',
      },
      true
    );
  }
}

// ============================================================================
// GET PENDING MESSAGES (for checking inbox from other channels)
// ============================================================================

export const getPendingMessagesSchema = z.object({
  channel: z
    .enum(['telegram', 'terminal', 'discord', 'whatsapp', 'slack', 'http', 'api', 'agent', 'all'])
    .optional()
    .default('all')
    .describe('Filter by channel (default: all)'),
  limit: z.number().min(1).max(50).optional().default(10).describe('Maximum messages to return'),
  since: z.string().datetime().optional().describe('Only messages after this timestamp'),
});

// In-memory message queue for cross-channel visibility
interface PendingMessage {
  id: string;
  channel: ChannelType;
  conversationId: string;
  sender: { id: string; name?: string };
  content: string;
  timestamp: Date;
  read: boolean;
  /** Target agent ID — scopes delivery to the right CLI session */
  agentId?: string;
  /** Target session ID — for precise routing */
  sessionId?: string;
}

const pendingMessages: PendingMessage[] = [];
const MAX_PENDING_MESSAGES = 100;

/**
 * Add a message to the pending queue (called by session host)
 */
export function addPendingMessage(message: PendingMessage): void {
  pendingMessages.unshift(message);

  // Trim old messages
  while (pendingMessages.length > MAX_PENDING_MESSAGES) {
    pendingMessages.pop();
  }
}

/**
 * Mark messages as read
 */
export function markMessagesRead(messageIds: string[]): void {
  for (const msg of pendingMessages) {
    if (messageIds.includes(msg.id)) {
      msg.read = true;
    }
  }
}

export async function handleGetPendingMessages(
  args: z.infer<typeof getPendingMessagesSchema>,
  _dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    let filtered = pendingMessages;

    // Scope by calling agent + session — prevents cross-agent and
    // cross-session message leaks. Uses request context for identity.
    const callerAgentId = getPinnedAgentId();
    const reqCtx = getRequestContext();
    const callerSessionId = reqCtx?.sessionId;

    if (callerAgentId) {
      filtered = filtered.filter((m) => !m.agentId || m.agentId === callerAgentId);
    }
    if (callerSessionId) {
      filtered = filtered.filter((m) => !m.sessionId || m.sessionId === callerSessionId);
    }

    // Filter by channel
    if (args.channel && args.channel !== 'all') {
      filtered = filtered.filter((m) => m.channel === args.channel);
    }

    // Filter by timestamp
    if (args.since) {
      const sinceDate = new Date(args.since);
      filtered = filtered.filter((m) => m.timestamp > sinceDate);
    }

    // Apply limit
    filtered = filtered.slice(0, args.limit);

    return mcpResponse({
      success: true,
      messages: filtered.map((m) => ({
        id: m.id,
        channel: m.channel,
        conversationId: m.conversationId,
        sender: m.sender,
        content: m.content,
        timestamp: m.timestamp.toISOString(),
        read: m.read,
      })),
      totalPending: pendingMessages.filter((m) => !m.read).length,
    });
  } catch (error) {
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get pending messages',
      },
      true
    );
  }
}

// ============================================================================
// MARK MESSAGES READ
// ============================================================================

export const markReadSchema = z.object({
  messageIds: z.array(z.string()).describe('Message IDs to mark as read'),
});

export async function handleMarkRead(
  args: z.infer<typeof markReadSchema>,
  _dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    markMessagesRead(args.messageIds);

    return mcpResponse({
      success: true,
      markedRead: args.messageIds.length,
    });
  } catch (error) {
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to mark messages read',
      },
      true
    );
  }
}
