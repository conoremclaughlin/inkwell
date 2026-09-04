/**
 * MCP Tool Handlers for Response Routing
 *
 * These tools enable Claude to send responses back to specific channels.
 * This is the standardized output mechanism for the agent backends.
 */

import { z } from 'zod';
import { isoDateTime } from './schema-primitives.js';
import type { DataComposer } from '../../data/composer';
import type { ChannelType, AgentResponse, ResponseFormat, OutboundMedia } from '../../agent/types';
import { logger } from '../../utils/logger';
import { hasDeliveryEvidence } from '../../services/channel-forward.js';
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

// Best-effort delivery marker, keyed per CONVERSATION — "channel:conversationId"
// — not per turn. The value is a timestamp for debugging only; nothing reads it.
//
// The distinction matters and is easy to lose: a marker says *someone* delivered
// on this conversation, not that the turn now reading it is the turn that sent.
// Two turns on the same conversation share one key, so a reader cannot tell its
// own delivery from a concurrent one. Consuming on read (below) stops a marker
// being seen twice; it does not establish who it belonged to. Real turn
// ownership needs a per-turn identity and is tracked separately.
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
 * Read the marker and clear it in ONE step.
 *
 * The two-call form — check, then act, then clear — has an ordering hazard that
 * is easy to reintroduce and hard to see: `releaseConversation` drains a pending
 * next turn SYNCHRONOUSLY, so a marker still standing at that moment is read by
 * the nested turn as its own delivery, suppressing that turn's fallback and its
 * warning (Lumen, PR #580 r2).
 *
 * Reordering two lines fixes today's instance and leaves the hazard. Making the
 * read consume the marker removes it: there is no window because there is no
 * interval. Callers cannot get the order wrong when there is only one call.
 *
 * What this does NOT do: establish that the marker belonged to the calling turn.
 * The key is the conversation, so a same-conversation turn that delivered while
 * this one was queued leaves a marker this call will happily consume and read as
 * its own. Consuming bounds the damage to one reader; it does not identify the
 * writer. Treat the result as "this conversation was answered recently," never
 * as "this turn answered." Turn ownership is deliberately out of scope here —
 * it needs a per-turn identity threaded to the runner, which is its own change.
 */
export function consumeExplicitResponse(channel: string, conversationId: string): boolean {
  const key = `${channel}:${conversationId}`;
  const had = explicitResponseTracker.has(key);
  explicitResponseTracker.delete(key);
  return had;
}

/**
 * Mark a conversation as having received an explicit response. Only called once
 * delivery evidence exists — a send that threw, or that carried nothing, must
 * leave the conversation looking unanswered so the fallback can still fire.
 *
 * No sweep here: the map holds one entry per active conversation, and the entry
 * is removed by whoever consumes it after the auto-forward decision.
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

    // Mark AFTER the send has actually succeeded, never before.
    //
    // This used to run before the callback/HTTP attempt, so a send that threw,
    // returned a non-ok status, or hit the no-routing early return still left
    // the conversation marked as answered. The server then read that mark,
    // concluded an explicit response had been delivered, and suppressed BOTH
    // the auto-forward fallback and the warning that says nothing was
    // delivered — so a failed send became a silent one (Lumen, PR #580).
    //
    // Every path between here and the top either threw into the catch or
    // returned early, so reaching this line is the only proof of delivery we
    // have.
    // ...and only when something actually reached the user. A resolved
    // transport call is not proof: a blank body with no media, or a media-only
    // send where every attachment failed, both resolve normally while
    // delivering nothing (Lumen, PR #580 r2). Marking those would suppress the
    // fallback and the warning for the most complete failure there is.
    if (
      !hasDeliveryEvidence({
        content: args.content,
        mediaRequested: args.media?.length ?? 0,
        mediaSent: callbackResult?.mediaSent,
      })
    ) {
      logger.warn('send_response delivered nothing', {
        channel: args.channel,
        conversationId: args.conversationId,
        contentLength: args.content.trim().length,
        mediaRequested: args.media?.length ?? 0,
        mediaSent: callbackResult?.mediaSent,
      });
      return mcpResponse(
        {
          success: false,
          error:
            'Nothing was delivered: the message body was blank and no media was sent. The user received nothing.',
          channel: args.channel,
          conversationId: args.conversationId,
        },
        true
      );
    }

    markExplicitResponse(args.channel, args.conversationId);

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
  since: isoDateTime().optional().describe('Only messages after this timestamp'),
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
