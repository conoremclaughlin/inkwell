/**
 * Agent Inbox Handlers
 *
 * MCP tools for cross-agent messaging. Allows AI beings to send messages
 * to each other asynchronously for coordination and task handoff.
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { resolveUserOrThrow, userIdentifierBaseSchema } from '../../services/user-resolver';
import { resolveIdentityId } from '../../auth/resolve-identity';
import { getEffectiveAgentId } from '../../auth/enforce-identity';
import { logger } from '../../utils/logger';
import type { Json } from '../../data/supabase/types';
import { getRequestContext, getSessionContext } from '../../utils/request-context';
import { getAgentGateway, type AgentTriggerPayload } from '../../channels/agent-gateway.js';
import {
  findThread as findExistingThread,
  getParticipants,
  resolveTriggeredAgents,
} from './thread-handlers.js';
import { resolveStudioHint } from '../../services/sessions/index.js';

// The thread tables are new and not yet in generated Supabase types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const threadTable = (supabase: ReturnType<DataComposer['getClient']>, table: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (supabase as any).from(table);

// ============== Schemas ==============

const sendToInboxSchema = userIdentifierBaseSchema.extend({
  recipientAgentId: z
    .string()
    .optional()
    .describe('Agent ID to send message to. Required unless recipients[] is provided.'),
  recipients: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(16)
    .optional()
    .describe('Multiple recipient agent IDs for group thread creation. Requires threadKey.'),
  senderAgentId: z.string().optional().describe('Agent ID of sender (optional if from human)'),
  subject: z.string().optional().describe('Message subject'),
  content: z.string().describe('Message content'),
  messageType: z
    .enum(['message', 'task_request', 'session_resume', 'notification', 'permission_grant'])
    .optional()
    .default('message')
    .describe('Type of message'),
  priority: z
    .enum(['low', 'normal', 'high', 'urgent'])
    .optional()
    .default('normal')
    .describe('Message priority'),
  recipientSessionId: z
    .string()
    .uuid()
    .optional()
    .describe('Recipient session ID to resume/route to (preferred)'),
  recipientStudioId: z
    .string()
    .uuid()
    .optional()
    .describe('Recipient studio ID hint for session routing'),
  recipientStudioHint: z
    .enum(['main'])
    .optional()
    .describe('Recipient studio routing hint (e.g., "main")'),
  relatedArtifactUri: z.string().optional().describe('Related artifact URI'),
  metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
  expiresAt: z.string().datetime().optional().describe('When this message expires'),
  threadKey: z
    .string()
    .optional()
    .describe(
      'Thread key for conversation continuity (e.g., "pr:32", "spec:cli-hooks"). When provided, messages are stored in thread tables and all participants see the full history. Without it, messages go to the simple agent_inbox. Format: <type>:<identifier>.'
    ),
  // Trigger options - automatically trigger the recipient after sending
  trigger: z
    .boolean()
    .optional()
    .describe(
      'Whether to trigger (wake) recipient agents after sending. Defaults to true. When false, overrides triggerAll and triggerAgents — no agents are triggered. Only set to false if the message can genuinely wait 5+ hours. Most agents do not have heartbeats — untriggered messages may never be seen.'
    ),
  triggerType: z
    .enum(['task_complete', 'approval_needed', 'message', 'error', 'custom'])
    .optional()
    .describe('Type of trigger (only used if trigger=true)'),
  triggerSummary: z
    .string()
    .optional()
    .describe('Brief summary for the trigger (only used if trigger=true)'),
  triggerAll: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Trigger all thread participants (except sender). Only applies to thread messages. Overridden by triggerAgents.'
    ),
  triggerAgents: z
    .array(z.string().min(1).max(64))
    .max(16)
    .optional()
    .describe(
      'Trigger specific thread participants by agent ID. Takes highest precedence. Non-participants are silently ignored.'
    ),
});

/**
 * Check if a thread is owned by a specific studio based on the agent's
 * message metadata. Used by channelPoll filtering.
 *
 * Returns true (accept) when:
 * - Agent has no messages on the thread (new/broadcast — accept in any studio)
 * - Agent's messages include one sent FROM this studioId
 * - Agent's messages include one with recipient.studioId matching this studio
 *   (cross-studio self-message targeting this studio)
 *
 * Returns false (skip) when:
 * - Agent has messages but none match this studioId as sender or recipient
 */
export function isThreadOwnedByStudio(
  agentMessages: Array<{ metadata: unknown }>,
  callerStudioId: string
): boolean {
  if (!agentMessages.length) return true; // no messages from us — broadcast

  return agentMessages.some((m) => {
    const pcp = (m.metadata as Record<string, unknown>)?.pcp as Record<string, unknown> | undefined;
    // Check sender studioId (standard ownership)
    const sender = pcp?.sender as Record<string, unknown> | undefined;
    if (sender?.studioId === callerStudioId) return true;
    // Check recipient studioId (cross-studio self-message targeting this studio)
    const recipient = pcp?.recipient as Record<string, unknown> | undefined;
    if (recipient?.studioId === callerStudioId) return true;
    return false;
  });
}

const getInboxSchema = userIdentifierBaseSchema.extend({
  agentId: z
    .string()
    .optional()
    .describe(
      'Agent ID to get inbox for. Omit to get inbox across ALL agents (useful for unified timelines).'
    ),
  status: z
    .enum(['unread', 'read', 'acknowledged', 'completed', 'all'])
    .optional()
    .default('unread')
    .describe('Filter by status'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('Filter by priority'),
  messageType: z
    .enum(['message', 'task_request', 'session_resume', 'notification', 'permission_grant'])
    .optional(),
  limit: z.number().min(1).max(200).optional().default(20).describe('Max messages'),
  since: z
    .string()
    .datetime()
    .optional()
    .describe('Only return messages created after this ISO timestamp'),
  channelPoll: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'When true, filter threads by studio ownership using the studioId from request context. ' +
        'Used by channel plugins to only receive threads belonging to their studio. ' +
        'Threads with no studio affinity (new, unrouted) are included as broadcast.'
    ),
});

const updateInboxMessageSchema = userIdentifierBaseSchema.extend({
  messageId: z.string().uuid().describe('Message ID to update'),
  agentId: z.string().describe('Agent ID making the update (must be recipient)'),
  status: z.enum(['read', 'acknowledged', 'completed']).describe('New status'),
});

const markInboxReadSchema = userIdentifierBaseSchema.extend({
  agentId: z.string().describe('Agent ID whose inbox to mark as read'),
  before: z
    .string()
    .datetime()
    .optional()
    .describe(
      'Mark messages as read up to this timestamp (ISO 8601). Defaults to now — marks all current messages as read.'
    ),
});

const getAgentStatusSchema = userIdentifierBaseSchema.extend({
  agentId: z.string().describe('Agent ID to check status for'),
});

const getAgentSummariesSchema = userIdentifierBaseSchema.extend({
  agentIds: z
    .array(z.string())
    .optional()
    .describe(
      'Specific agent IDs to summarize. Omit to auto-discover all agents from agent_identities.'
    ),
});

// ============== Handlers ==============

export async function handleSendToInbox(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = sendToInboxSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const {
    recipientAgentId,
    recipients,
    subject,
    content,
    messageType = 'message',
    priority = 'normal',
    recipientSessionId,
    recipientStudioId,
    recipientStudioHint,
    relatedArtifactUri,
    metadata = {},
    expiresAt,
    triggerType,
    triggerSummary,
    threadKey,
    triggerAll,
    triggerAgents,
  } = parsed;

  // Validate: exactly one of recipientAgentId or recipients
  const hasSingle = !!recipientAgentId;
  const hasMany = !!recipients?.length;
  if (hasSingle === hasMany) {
    throw new Error('Provide exactly one of recipientAgentId or recipients');
  }
  if (hasMany && !threadKey) {
    throw new Error('threadKey is required when using recipients[]');
  }
  if (recipients && (recipientSessionId || recipientStudioId || recipientStudioHint)) {
    throw new Error(
      'recipientSessionId/recipientStudioId/recipientStudioHint are only valid for single-recipient sends'
    );
  }

  // Enforce identity on sender (who is performing the action), not recipient (target)
  const senderAgentId = getEffectiveAgentId(parsed.senderAgentId);
  const triggerSenderId = senderAgentId || 'system';
  const effectiveRecipientSessionId = recipientSessionId;

  // Default trigger behavior:
  // All message types trigger by default. Most agents don't have heartbeats,
  // so untriggered messages may sit unread for hours. Only set trigger=false
  // for messages that can genuinely wait 5+ hours.
  const trigger = parsed.trigger ?? true;

  // ── Resolve sender session context (shared by both thread and legacy paths) ──
  // This must happen BEFORE the thread/legacy branch so thread messages also
  // capture the sender's session ID for reply-routing.
  const reqCtx = getRequestContext();
  const sessCtx = getSessionContext();
  let senderSessionId: string | null = reqCtx?.sessionId || sessCtx?.sessionId || null;
  const senderStudioId = reqCtx?.studioId || sessCtx?.studioId || null;

  // When the caller's session ID wasn't provided via request context headers
  // (x-ink-session-id), try threadKey-scoped lookup as a deterministic fallback.
  // We intentionally do NOT fall back to "most recent active session" — that's
  // non-deterministic and can route replies to the wrong worktree/studio.
  if (!senderSessionId && senderAgentId && threadKey) {
    try {
      const threadSession = await dataComposer.repositories.memory.getActiveSessionByThreadKey(
        resolved.user.id,
        senderAgentId,
        threadKey,
        senderStudioId
      );
      if (threadSession) {
        senderSessionId = threadSession.id;
        logger.debug('Resolved sender session from threadKey match (no header)', {
          senderAgentId,
          threadKey,
          senderSessionId,
        });
      }
    } catch (err) {
      logger.warn('Failed to resolve sender session from threadKey', {
        error: err instanceof Error ? err.message : String(err),
        senderAgentId,
        threadKey,
      });
    }
  }

  // Track whether session context is missing — used to suppress triggers
  // and warn the sender. Without session context, reply routing is broken
  // (recipients can't auto-resolve back to the sender's session/studio).
  const missingSenderSession = !senderSessionId && !!senderAgentId;

  // ── Thread-first path: when threadKey is provided, route to thread tables ──
  // Unified handler for both new thread creation and replies to existing threads.
  // Single-recipient with threadKey creates a 2-participant thread (spec invariant #5).
  // recipients[] creates a multi-participant thread.
  // Without threadKey, falls through to legacy agent_inbox path.
  if (threadKey) {
    const allRecipients = recipients || [recipientAgentId!];

    // Check if thread already exists — determines reply vs create behavior
    const existingThread = await findExistingThread(supabase, resolved.user.id, threadKey);

    // ── Reply semantics: enforce participant membership and closed-thread rejection ──
    if (existingThread) {
      // Reject replies on closed threads
      if (existingThread.status === 'closed') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Thread ${threadKey} is closed. Cannot send to closed threads.`,
              }),
            },
          ],
        };
      }

      // If sender is already a participant, this is a reply — enforce membership
      // If sender is NOT a participant, auto-add them (join-on-send)
    }

    // Find or create thread
    let thread = await findOrCreateThread(supabase, {
      userId: resolved.user.id,
      threadKey,
      creatorAgentId: triggerSenderId,
      title: subject || null,
      participants: senderAgentId ? [...new Set([senderAgentId, ...allRecipients])] : allRecipients,
    });

    // Include sender as participant if they have an identity
    const allParticipants = senderAgentId
      ? [...new Set([senderAgentId, ...allRecipients])]
      : allRecipients;

    // Ensure all participants are registered (recipients + sender for existing threads)
    for (const agentId of allParticipants) {
      const { data: existing } = await threadTable(supabase, 'inbox_thread_participants')
        .select('agent_id')
        .eq('thread_id', thread.id)
        .eq('agent_id', agentId)
        .maybeSingle();

      if (!existing) {
        await threadTable(supabase, 'inbox_thread_participants').insert({
          thread_id: thread.id,
          agent_id: agentId,
        });
      }
    }

    // Enrich thread message metadata with sender session context so replies
    // can route back to the correct session/studio.
    const rawMeta =
      metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
    const existingPcpMeta =
      rawMeta.pcp && typeof rawMeta.pcp === 'object'
        ? (rawMeta.pcp as Record<string, unknown>)
        : {};
    // Cross-studio self-messaging: stamp recipient studio on the message
    // so the channelPoll filter can recognize the target studio as an owner.
    // Resolve recipientStudioHint to a studioId if needed.
    let resolvedRecipientStudioId: string | undefined = recipientStudioId || undefined;
    if (!resolvedRecipientStudioId && recipientStudioHint && senderAgentId) {
      try {
        // Reuse the shared resolution function (worktree path → branch fallback
        // for 'main', slug match for named hints).
        const reqCtxForHint = getRequestContext();
        resolvedRecipientStudioId = await resolveStudioHint(
          supabase,
          resolved.user.id,
          recipientStudioHint,
          senderAgentId,
          reqCtxForHint?.repoRoot
        );
      } catch {
        // Best-effort resolution — proceed without stamping
      }
    }

    const selfStudioRecipient = !!(
      senderAgentId &&
      resolvedRecipientStudioId &&
      allRecipients.includes(senderAgentId)
    );
    const threadMessageMetadata = {
      ...rawMeta,
      pcp: {
        ...existingPcpMeta,
        sender: {
          agentId: triggerSenderId,
          sessionId: senderSessionId,
          studioId: senderStudioId,
        },
        ...(selfStudioRecipient ? { recipient: { studioId: resolvedRecipientStudioId } } : {}),
      },
    };

    // Insert thread message
    const { data: threadMessage, error: tmError } = await threadTable(
      supabase,
      'inbox_thread_messages'
    )
      .insert({
        thread_id: thread.id,
        sender_agent_id: triggerSenderId,
        content,
        message_type: messageType === 'permission_grant' ? 'message' : messageType,
        priority,
        metadata: threadMessageMetadata as Json,
      })
      .select()
      .single();

    if (tmError) {
      throw new Error(`Failed to send thread message: ${tmError.message}`);
    }

    // Update thread updated_at
    await threadTable(supabase, 'inbox_threads')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', thread.id);

    // Update sender's read status
    if (senderAgentId) {
      await threadTable(supabase, 'inbox_thread_read_status').upsert(
        {
          thread_id: thread.id,
          agent_id: senderAgentId,
          last_read_at: new Date().toISOString(),
        },
        { onConflict: 'thread_id,agent_id' }
      );
    }

    // ── Trigger resolution ──
    // For existing threads (replies), use smart trigger rules from resolveTriggeredAgents.
    // For new threads, trigger all recipients (existing behavior).
    let agentsToTrigger: string[] = [];

    // Cross-studio self-messaging: when the sender targets themselves in a
    // different studio (via recipientStudioId/recipientStudioHint), don't
    // exclude self from trigger resolution.
    const selfStudioTarget = !!(
      senderAgentId &&
      (recipientStudioId || recipientStudioHint) &&
      allRecipients.includes(senderAgentId)
    );

    if (trigger !== false && !missingSenderSession) {
      if (existingThread && senderAgentId) {
        // Reply: fetch current participants from DB for accurate trigger resolution
        const currentParticipants = await getParticipants(supabase, thread.id);
        agentsToTrigger = resolveTriggeredAgents({
          senderAgentId,
          participants: currentParticipants,
          creatorAgentId: existingThread.created_by_agent_id,
          triggerAgents,
          triggerAll,
          messageType,
          recipients: allRecipients,
          selfStudioTarget,
        });
      } else {
        // New thread: trigger all recipients (exclude sender unless cross-studio self-message)
        agentsToTrigger = allRecipients.filter((a) => selfStudioTarget || a !== senderAgentId);
      }
    }

    logger.info('Thread message sent', {
      messageId: threadMessage.id,
      threadKey,
      to: allRecipients,
      from: triggerSenderId,
      type: messageType,
      isNewThread: thread.isNew,
      triggering: agentsToTrigger,
    });

    // Dispatch triggers with session routing from thread history
    const triggeredAgents: string[] = [];
    if (agentsToTrigger.length > 0) {
      const gateway = getAgentGateway();

      for (const toAgentId of agentsToTrigger) {
        // Auto-resolve recipientSessionId: find the recipient's most recent
        // message on this thread to extract their sender session. This ensures
        // replies route back to the session that originated the conversation,
        // not whatever session happens to be most recently updated.
        //
        // Cross-studio self-message: when sender === recipient, skip auto-resolve
        // from thread history (it would find our own session). The trigger system
        // will use recipientStudioId to route to the correct studio session.
        let resolvedRecipientSessionId: string | undefined =
          effectiveRecipientSessionId || undefined;
        const isSelfStudioMessage = selfStudioTarget && toAgentId === senderAgentId;
        if (!resolvedRecipientSessionId && !isSelfStudioMessage) {
          try {
            const { data: recipientMsg } = await threadTable(supabase, 'inbox_thread_messages')
              .select('metadata')
              .eq('thread_id', thread.id)
              .eq('sender_agent_id', toAgentId)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();
            const recipientPcp = (recipientMsg?.metadata as Record<string, unknown>)?.pcp as
              | Record<string, unknown>
              | undefined;
            const recipientSender = recipientPcp?.sender as Record<string, unknown> | undefined;
            if (recipientSender?.sessionId && typeof recipientSender.sessionId === 'string') {
              resolvedRecipientSessionId = recipientSender.sessionId;
              logger.debug('[ThreadTrigger] Auto-resolved recipientSessionId from thread history', {
                threadKey,
                toAgentId,
                recipientSessionId: resolvedRecipientSessionId,
              });
            }
          } catch (err) {
            logger.warn('[ThreadTrigger] Failed to resolve recipientSessionId from thread', {
              threadKey,
              toAgentId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const payload: AgentTriggerPayload = {
          fromAgentId: triggerSenderId,
          toAgentId,
          threadMessageId: threadMessage.id,
          triggerType: triggerType || 'message',
          summary:
            triggerSummary ||
            subject ||
            `New ${messageType} in thread ${threadKey} from ${triggerSenderId}`,
          priority,
          threadKey,
          recipientSessionId: resolvedRecipientSessionId,
          // Cross-studio self-message: route to the target studio explicitly
          ...(isSelfStudioMessage && resolvedRecipientStudioId
            ? { studioId: resolvedRecipientStudioId }
            : {}),
          ...(isSelfStudioMessage && !resolvedRecipientStudioId && recipientStudioHint
            ? { studioHint: recipientStudioHint }
            : {}),
        };
        const result = gateway.dispatchTrigger(payload);
        if (result.accepted) {
          triggeredAgents.push(toAgentId);
        }
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: `Thread message sent to ${threadKey}`,
            messageId: threadMessage.id,
            threadKey,
            threadId: thread.id,
            isNewThread: thread.isNew,
            recipients: allRecipients,
            participants: allParticipants,
            messageType,
            priority,
            triggered: triggeredAgents,
            createdAt: threadMessage.created_at,
            ...(missingSenderSession
              ? {
                  warning:
                    'Session context missing (no x-ink-session-id header). Triggers suppressed — recipients will not be woken. They will see this message on their next inbox check. To fix: set the x-ink-session-id header on your MCP connection (the sb CLI does this automatically). For unsupported runtimes, use a heartbeat cron to periodically call get_inbox and process pending messages.',
                }
              : {}),
          }),
        },
      ],
    };
  }

  // ── Legacy path: simple inbox message (no threadKey) ──
  const hasRoutingAnchor = Boolean(
    effectiveRecipientSessionId || recipientStudioId || recipientStudioHint
  );
  const requiresRoutingAnchor = Boolean(senderAgentId) && messageType !== 'message';
  const missingRoutingAnchor = requiresRoutingAnchor && !hasRoutingAnchor;
  if (missingRoutingAnchor) {
    logger.warn('send_to_inbox missing routing anchor for actionable handoff', {
      messageType,
      recipientAgentId,
      senderAgentId,
    });
  }

  // senderSessionId and senderStudioId already resolved above (shared with thread path)
  const metadataRecord =
    metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
  const existingPcp =
    metadataRecord.pcp && typeof metadataRecord.pcp === 'object'
      ? (metadataRecord.pcp as Record<string, unknown>)
      : {};
  const enrichedMetadata = {
    ...metadataRecord,
    pcp: {
      ...existingPcp,
      sender: {
        agentId: triggerSenderId,
        sessionId: senderSessionId,
        studioId: senderStudioId,
      },
      recipient: {
        sessionId: effectiveRecipientSessionId || null,
        studioId: recipientStudioId || null,
        studioHint: recipientStudioHint || null,
      },
    },
  };

  // Resolve canonical identity UUIDs for sender and recipient
  const recipientIdentityId = await resolveIdentityId(
    supabase,
    resolved.user.id,
    recipientAgentId!
  );
  const senderIdentityId = senderAgentId
    ? await resolveIdentityId(supabase, resolved.user.id, senderAgentId)
    : null;

  const { data: message, error } = await supabase
    .from('agent_inbox')
    .insert({
      recipient_user_id: resolved.user.id,
      recipient_agent_id: recipientAgentId!,
      recipient_identity_id: recipientIdentityId,
      sender_user_id: senderAgentId ? null : resolved.user.id,
      sender_agent_id: senderAgentId || null,
      sender_identity_id: senderIdentityId,
      subject,
      content,
      message_type: messageType,
      priority,
      recipient_session_id: effectiveRecipientSessionId || null,
      related_artifact_uri: relatedArtifactUri || null,
      metadata: enrichedMetadata as Json,
      expires_at: expiresAt || null,
      thread_key: null, // threadKey messages route to thread tables above
    })
    .select()
    .single();

  if (error) {
    logger.error('Failed to send inbox message', { error, recipientAgentId });
    throw new Error(`Failed to send message: ${error.message}`);
  }

  logger.info('Inbox message sent', {
    messageId: message.id,
    to: recipientAgentId,
    from: senderAgentId || 'user',
    type: messageType,
    priority,
    trigger,
  });

  // Optionally trigger the recipient agent
  let triggerResult: {
    triggered: boolean;
    triggerId?: string;
    processed?: boolean;
    accepted?: boolean;
    error?: string;
  } = {
    triggered: false,
  };

  if (trigger && !missingSenderSession) {
    const gateway = getAgentGateway();
    const payload: AgentTriggerPayload = {
      fromAgentId: triggerSenderId,
      toAgentId: recipientAgentId!,
      inboxMessageId: message.id,
      triggerType: triggerType || 'message',
      summary: triggerSummary || subject || `New ${messageType} from ${triggerSenderId}`,
      priority,
      recipientSessionId: effectiveRecipientSessionId,
      studioId: recipientStudioId,
      studioHint: recipientStudioHint,
    };

    logger.info('Inbox message trigger dispatched (async)', {
      messageId: message.id,
      recipientAgentId,
    });

    const result = gateway.dispatchTrigger(payload);

    logger.info('Inbox message trigger accepted', {
      messageId: message.id,
      triggerId: result.triggerId,
      accepted: result.accepted,
      processed: result.processed,
      error: result.error,
    });

    triggerResult = {
      triggered: true,
      triggerId: result.triggerId,
      processed: result.processed,
      accepted: result.accepted,
      error: result.error,
    };
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          message: `Message sent to ${recipientAgentId}${triggerResult.triggered ? ' and triggered' : ''}`,
          messageId: message.id,
          recipientAgentId,
          messageType,
          priority,
          threadKey: null,
          recipientSessionId: effectiveRecipientSessionId || null,
          recipientStudioId: recipientStudioId || null,
          recipientStudioHint: recipientStudioHint || null,
          createdAt: message.created_at,
          trigger: triggerResult,
          ...(missingRoutingAnchor
            ? {
                routingHint:
                  'Actionable handoff is missing a routing anchor. Add one of: threadKey, recipientSessionId, recipientStudioId, or recipientStudioHint.',
              }
            : {}),
          ...(missingSenderSession
            ? {
                warning:
                  'Session context missing (no x-ink-session-id header). Triggers suppressed — recipient will not be woken. They will see this message on their next inbox check. To fix: set the x-ink-session-id header on your MCP connection (the sb CLI does this automatically). For unsupported runtimes, use a heartbeat cron to periodically call get_inbox and process pending messages.',
              }
            : {}),
          hint: 'Consider adding a threadKey (e.g., "pr:32", "spec:cli-hooks") to route this message to a group thread.',
        }),
      },
    ],
  };
}

/**
 * Find or create a thread. Returns the thread row with an `isNew` flag.
 */
async function findOrCreateThread(
  supabase: ReturnType<DataComposer['getClient']>,
  opts: {
    userId: string;
    threadKey: string;
    creatorAgentId: string;
    title: string | null;
    participants: string[];
  }
): Promise<{ id: string; isNew: boolean }> {
  // Try to find existing
  const { data: existing } = await threadTable(supabase, 'inbox_threads')
    .select('id')
    .eq('user_id', opts.userId)
    .eq('thread_key', opts.threadKey)
    .maybeSingle();

  if (existing) {
    return { id: existing.id, isNew: false };
  }

  // Create new thread
  const { data: thread, error } = await threadTable(supabase, 'inbox_threads')
    .insert({
      thread_key: opts.threadKey,
      user_id: opts.userId,
      created_by_agent_id: opts.creatorAgentId,
      title: opts.title,
    })
    .select()
    .single();

  if (error) {
    // Race condition: another request may have created it
    if (error.code === '23505') {
      const { data: retry } = await threadTable(supabase, 'inbox_threads')
        .select('id')
        .eq('user_id', opts.userId)
        .eq('thread_key', opts.threadKey)
        .single();
      if (retry) return { id: retry.id, isNew: false };
    }
    throw new Error(`Failed to create thread: ${error.message}`);
  }

  // Add all participants
  const participantRows = opts.participants.map((agentId) => ({
    thread_id: thread.id,
    agent_id: agentId,
  }));
  await threadTable(supabase, 'inbox_thread_participants').insert(participantRows);

  return { id: thread.id, isNew: true };
}

export async function handleGetInbox(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = getInboxSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const { status = 'unread', priority, messageType, limit = 20, since, channelPoll } = parsed;
  // Enforce identity: pinned agents can only read their own inbox.
  // When agentId is omitted, return inbox across ALL agents (unified timeline).
  const agentId = parsed.agentId
    ? (getEffectiveAgentId(parsed.agentId) ?? parsed.agentId)
    : undefined;

  let query = supabase
    .from('agent_inbox')
    .select('*')
    .eq('recipient_user_id', resolved.user.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (agentId) {
    query = query.eq('recipient_agent_id', agentId);
  }
  if (status !== 'all') {
    query = query.eq('status', status);
  }
  if (since) {
    query = query.gt('created_at', since);
  }
  if (priority) {
    query = query.eq('priority', priority);
  }
  if (messageType) {
    query = query.eq('message_type', messageType);
  }

  // Exclude expired messages
  query = query.or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);

  const { data: messages, error } = await query;

  if (error) {
    throw new Error(`Failed to get inbox: ${error.message}`);
  }

  // Auto-advance read pointer: when an agent reads their inbox, advance
  // the pointer to the latest message timestamp. No need for explicit
  // mark_inbox_read calls.
  if (agentId && messages?.length) {
    const maxCreatedAt = (messages as Array<{ created_at: string }>).reduce(
      (max: string, m) => (m.created_at > max ? m.created_at : max),
      (messages[0] as { created_at: string }).created_at
    );
    await threadTable(supabase, 'agent_inbox_read_status').upsert(
      {
        user_id: resolved.user.id,
        agent_id: agentId,
        last_read_at: maxCreatedAt,
      },
      { onConflict: 'user_id,agent_id' }
    );
    logger.debug('Auto-advanced inbox read pointer', { agentId, lastReadAt: maxCreatedAt });
  }

  // Count unread using pointer-based tracking (agent_inbox_read_status)
  // Uses the same untyped table helper as thread tables (not yet in generated types)
  let inboxUnread = 0;
  if (agentId) {
    // Single agent: one pointer lookup + one count
    const { data: readStatus } = await threadTable(supabase, 'agent_inbox_read_status')
      .select('last_read_at')
      .eq('user_id', resolved.user.id)
      .eq('agent_id', agentId)
      .maybeSingle();

    let countQuery = supabase
      .from('agent_inbox')
      .select('*', { count: 'exact', head: true })
      .eq('recipient_user_id', resolved.user.id)
      .eq('recipient_agent_id', agentId);

    if (readStatus?.last_read_at) {
      countQuery = countQuery.gt('created_at', readStatus.last_read_at);
    }
    // Exclude expired messages from unread count
    countQuery = countQuery.or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
    const { count } = await countQuery;
    inboxUnread = count || 0;
  } else {
    // All agents: fall back to aggregate count
    const { data: readStatuses } = await threadTable(supabase, 'agent_inbox_read_status')
      .select('agent_id, last_read_at')
      .eq('user_id', resolved.user.id);

    const oldestPointer = (readStatuses || []).reduce(
      (oldest: string | null, rs: { last_read_at: string }) =>
        !oldest || rs.last_read_at < oldest ? rs.last_read_at : oldest,
      null
    );

    // Count messages after the oldest pointer (overcount, but correct for "any unread")
    let countQuery = supabase
      .from('agent_inbox')
      .select('*', { count: 'exact', head: true })
      .eq('recipient_user_id', resolved.user.id);
    if (oldestPointer) {
      countQuery = countQuery.gt('created_at', oldestPointer);
    }
    countQuery = countQuery.or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
    const { count } = await countQuery;
    inboxUnread = count || 0;
  }
  const unreadCount = inboxUnread;

  // Get threads with unread counts and preview messages.
  // Works with or without agentId — when omitted, finds threads for ALL agents
  // (used by `sb mission` unified timeline).
  interface ThreadSummary {
    threadKey: string;
    title: string | null;
    participants: string[];
    unreadCount: number;
    lastMessageAt: string | null;
    previewMessages: Array<{
      senderAgentId: string;
      content: string;
      messageType: string;
      createdAt: string;
    }>;
  }
  let threadsWithUnread: ThreadSummary[] = [];
  let threadUnreadCount = 0;

  try {
    // Find thread IDs this agent (or any agent for this user) participates in
    let participantQuery = threadTable(supabase, 'inbox_thread_participants').select('thread_id');
    if (agentId) {
      participantQuery = participantQuery.eq('agent_id', agentId);
    }
    const { data: participantRows } = await participantQuery;

    const threadIds = [
      ...new Set((participantRows || []).map((p: { thread_id: string }) => p.thread_id)),
    ];

    if (threadIds.length > 0) {
      // Get open threads for this user.
      // NOTE: `since` is NOT applied to threads — thread read pointers
      // (inbox_thread_read_status.last_read_at) already handle "which
      // messages have I seen." Filtering threads by updated_at would
      // cause missed messages when lastPollTime advances past the
      // thread's updated_at between polls.
      const { data: threads } = await threadTable(supabase, 'inbox_threads')
        .select('id, thread_key, title, user_id, created_by_agent_id, updated_at')
        .eq('user_id', resolved.user.id)
        .eq('status', 'open')
        .in('id', threadIds)
        .order('updated_at', { ascending: false })
        .limit(20);

      if (threads?.length) {
        threadsWithUnread = await Promise.all(
          threads.map(
            async (t: {
              id: string;
              thread_key: string;
              title: string | null;
              created_by_agent_id: string;
              updated_at: string;
            }) => {
              // Get participants
              const { data: parts } = await threadTable(supabase, 'inbox_thread_participants')
                .select('agent_id')
                .eq('thread_id', t.id);
              const participants = (parts || []).map((p: { agent_id: string }) => p.agent_id);

              // Get last read timestamp (only meaningful with agentId)
              let lastReadAt: string | null = null;
              if (agentId) {
                const { data: readStatus } = await threadTable(supabase, 'inbox_thread_read_status')
                  .select('last_read_at')
                  .eq('thread_id', t.id)
                  .eq('agent_id', agentId)
                  .maybeSingle();
                lastReadAt = readStatus?.last_read_at || null;
              }

              // Count unread messages (after last read, or all if no read status)
              let countQuery = threadTable(supabase, 'inbox_thread_messages')
                .select('*', { count: 'exact', head: true })
                .eq('thread_id', t.id);

              if (lastReadAt) {
                countQuery = countQuery.gt('created_at', lastReadAt);
              }

              const { count } = await countQuery;

              // Get preview messages (last 3 non-system messages)
              const { data: previewRows } = await threadTable(supabase, 'inbox_thread_messages')
                .select('sender_agent_id, content, message_type, created_at')
                .eq('thread_id', t.id)
                .neq('message_type', 'system')
                .order('created_at', { ascending: false })
                .limit(3);

              const previewMessages = (previewRows || [])
                .reverse()
                .map(
                  (m: {
                    sender_agent_id: string;
                    content: string;
                    message_type: string;
                    created_at: string;
                  }) => ({
                    senderAgentId: m.sender_agent_id,
                    content: m.content,
                    messageType: m.message_type,
                    createdAt: m.created_at,
                  })
                );

              return {
                threadKey: t.thread_key,
                title: t.title,
                participants,
                unreadCount: count || 0,
                lastMessageAt: t.updated_at,
                previewMessages,
              };
            }
          )
        );

        // Only include threads that actually have unread messages
        threadsWithUnread = threadsWithUnread.filter((t) => t.unreadCount > 0);

        // Channel poll studio filtering: when channelPoll=true, filter threads
        // to only those owned by the requesting studio. Uses the same sender
        // metadata that the trigger system stamps on thread messages.
        if (channelPoll && agentId) {
          const reqCtx = getRequestContext();
          const sessCtx = getSessionContext();
          const callerStudioId = reqCtx?.studioId || sessCtx?.studioId || null;

          if (callerStudioId) {
            const filteredThreads: typeof threadsWithUnread = [];

            for (const thread of threadsWithUnread) {
              // Fetch our agent's messages on this thread to check studio ownership
              const threadRow = threads?.find(
                (t: { thread_key: string }) => t.thread_key === thread.threadKey
              );
              if (!threadRow) {
                filteredThreads.push(thread); // safety fallback — include if we can't check
                continue;
              }

              const { data: ourMessages } = await threadTable(supabase, 'inbox_thread_messages')
                .select('metadata')
                .eq('thread_id', (threadRow as { id: string }).id)
                .eq('sender_agent_id', agentId)
                .order('created_at', { ascending: false })
                .limit(5);

              if (isThreadOwnedByStudio(ourMessages || [], callerStudioId)) {
                filteredThreads.push(thread);
              } else {
                logger.debug('[ChannelPoll] Filtered thread (owned by different studio)', {
                  threadKey: thread.threadKey,
                  callerStudioId,
                });
              }
            }

            threadsWithUnread = filteredThreads;
          }
        }

        threadUnreadCount = threadsWithUnread.reduce((sum, t) => sum + t.unreadCount, 0);
      }
    }
  } catch (err) {
    // Thread tables may not exist yet (migration not applied) — graceful fallback
    logger.debug('Failed to fetch thread unread counts (tables may not exist)', { err });
  }

  const inboxUnreadCount = unreadCount || 0;
  const totalUnreadCount = inboxUnreadCount + threadUnreadCount;

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          ...(agentId ? { agentId } : { allAgents: true }),
          unreadCount: inboxUnreadCount,
          threadUnreadCount,
          totalUnreadCount,
          count: messages?.length || 0,
          messages: (messages || []).map((m) => ({
            id: m.id,
            subject: m.subject,
            content: m.content,
            messageType: m.message_type,
            priority: m.priority,
            status: m.status,
            senderAgentId: m.sender_agent_id,
            recipientAgentId: m.recipient_agent_id,
            threadKey: m.thread_key || null,
            recipientSessionId: m.recipient_session_id,
            relatedArtifactUri: m.related_artifact_uri,
            metadata: m.metadata,
            createdAt: m.created_at,
            readAt: m.read_at,
          })),
          ...(threadsWithUnread.length > 0
            ? {
                threadsWithUnread,
                threadHint:
                  'You have unread thread messages. Use get_thread_messages(threadKey) to read them, send_to_inbox(threadKey) to respond, or mark_thread_read to acknowledge.',
              }
            : {}),
        }),
      },
    ],
  };
}

export async function handleUpdateInboxMessage(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = updateInboxMessageSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const { messageId, agentId, status } = parsed;

  // Try legacy agent_inbox first
  const { data: existing } = await supabase
    .from('agent_inbox')
    .select('*')
    .eq('id', messageId)
    .eq('recipient_user_id', resolved.user.id)
    .eq('recipient_agent_id', agentId)
    .maybeSingle();

  if (existing) {
    // Legacy inbox message — update in agent_inbox
    const updates: Record<string, unknown> = { status };
    if (status === 'read' && !existing.read_at) {
      updates.read_at = new Date().toISOString();
    }
    if (status === 'acknowledged') {
      updates.acknowledged_at = new Date().toISOString();
    }

    const { data: updated, error: updateError } = await supabase
      .from('agent_inbox')
      .update(updates)
      .eq('id', messageId)
      .select()
      .single();

    if (updateError) {
      throw new Error(`Failed to update message: ${updateError.message}`);
    }

    logger.info('Inbox message updated', { messageId, agentId, newStatus: status });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: 'Message updated',
            messageId,
            status: updated.status,
            readAt: updated.read_at,
            acknowledgedAt: updated.acknowledged_at,
          }),
        },
      ],
    };
  }

  // Try thread message — verify thread belongs to this user AND agent is a participant
  const { data: threadMsg } = await threadTable(supabase, 'inbox_thread_messages')
    .select('id, thread_id')
    .eq('id', messageId)
    .maybeSingle();

  if (threadMsg) {
    // Verify the thread belongs to this user
    const { data: thread } = await threadTable(supabase, 'inbox_threads')
      .select('id')
      .eq('id', threadMsg.thread_id)
      .eq('user_id', resolved.user.id)
      .maybeSingle();

    if (!thread) {
      throw new Error(`Message not found or not accessible: ${messageId}`);
    }

    // Verify this agent is a participant on the thread
    const { data: participant } = await threadTable(supabase, 'inbox_thread_participants')
      .select('agent_id')
      .eq('thread_id', threadMsg.thread_id)
      .eq('agent_id', agentId)
      .maybeSingle();

    if (!participant) {
      throw new Error(`Message not found or not accessible: ${messageId}`);
    }

    // Thread messages don't have a status column — mark the thread as read instead
    if (status === 'read' || status === 'acknowledged' || status === 'completed') {
      await threadTable(supabase, 'inbox_thread_read_status').upsert(
        {
          thread_id: threadMsg.thread_id,
          agent_id: agentId,
          last_read_at: new Date().toISOString(),
        },
        { onConflict: 'thread_id,agent_id' }
      );
    }

    logger.info('Thread message status updated (via read pointer)', {
      messageId,
      threadId: threadMsg.thread_id,
      agentId,
      newStatus: status,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: 'Thread message acknowledged (thread marked as read)',
            messageId,
            threadId: threadMsg.thread_id,
            status,
          }),
        },
      ],
    };
  }

  // Neither table had this message
  throw new Error(`Message not found or not accessible: ${messageId}`);
}

export async function handleMarkInboxRead(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = markInboxReadSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const agentId = getEffectiveAgentId(parsed.agentId) ?? parsed.agentId;
  const lastReadAt = parsed.before || new Date().toISOString();

  // Upsert the read pointer — only advance forward, never backwards
  const { error } = await threadTable(supabase, 'agent_inbox_read_status').upsert(
    {
      user_id: resolved.user.id,
      agent_id: agentId,
      last_read_at: lastReadAt,
    },
    { onConflict: 'user_id,agent_id' }
  );

  if (error) {
    throw new Error(`Failed to mark inbox read: ${error.message}`);
  }

  logger.info('Inbox marked as read', { agentId, lastReadAt });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          agentId,
          lastReadAt,
          message: 'Inbox read pointer advanced. Messages before this timestamp are now read.',
        }),
      },
    ],
  };
}

export async function handleGetAgentStatus(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = getAgentStatusSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const { agentId } = parsed;

  // Get latest session for this agent
  const { data: latestSession } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_id', resolved.user.id)
    .eq('agent_id', agentId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Get unread message count (pointer-based)
  const { data: readStatus } = await threadTable(supabase, 'agent_inbox_read_status')
    .select('last_read_at')
    .eq('user_id', resolved.user.id)
    .eq('agent_id', agentId)
    .maybeSingle();

  let unreadQuery = supabase
    .from('agent_inbox')
    .select('*', { count: 'exact', head: true })
    .eq('recipient_user_id', resolved.user.id)
    .eq('recipient_agent_id', agentId);
  if (readStatus?.last_read_at) {
    unreadQuery = unreadQuery.gt('created_at', readStatus.last_read_at);
  }
  const { count: unreadCount } = await unreadQuery;

  // Get urgent unread message count (pointer-based)
  let urgentQuery = supabase
    .from('agent_inbox')
    .select('*', { count: 'exact', head: true })
    .eq('recipient_user_id', resolved.user.id)
    .eq('recipient_agent_id', agentId)
    .eq('priority', 'urgent');
  if (readStatus?.last_read_at) {
    urgentQuery = urgentQuery.gt('created_at', readStatus.last_read_at);
  }
  const { count: urgentCount } = await urgentQuery;

  // Get active workspaces for this agent
  const { data: workspaces } = await supabase
    .from('studios')
    .select('id, branch, worktree_path, purpose, status, work_type, session_id, created_at')
    .eq('user_id', resolved.user.id)
    .eq('agent_id', agentId)
    .in('status', ['active', 'idle'])
    .order('created_at', { ascending: false });

  // Determine agent status based on session
  let agentStatus = 'inactive';
  if (latestSession) {
    if (!latestSession.ended_at) {
      agentStatus = 'active';
    } else {
      const endedAt = new Date(latestSession.ended_at);
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      agentStatus = endedAt > hourAgo ? 'recently_active' : 'inactive';
    }
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          agentId,
          status: agentStatus,
          inbox: {
            unreadCount: unreadCount || 0,
            urgentCount: urgentCount || 0,
          },
          lastSession: latestSession
            ? {
                id: latestSession.id,
                claudeSessionId: latestSession.claude_session_id,
                startedAt: latestSession.started_at,
                endedAt: latestSession.ended_at,
                summary: latestSession.summary,
                workingDir: latestSession.working_dir,
              }
            : null,
          workspaces: (workspaces || []).map((w) => ({
            id: w.id,
            branch: w.branch,
            path: w.worktree_path,
            purpose: w.purpose,
            status: w.status,
            workType: w.work_type,
            hasLinkedSession: !!w.session_id,
            createdAt: w.created_at,
          })),
        }),
      },
    ],
  };
}

export async function handleGetAgentSummaries(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = getAgentSummariesSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);
  const userId = resolved.user.id;

  // Discover agents
  let agentIds = parsed.agentIds;
  if (!agentIds?.length) {
    const { data: identities } = await supabase
      .from('agent_identities')
      .select('agent_id')
      .eq('user_id', userId);
    agentIds = (identities || []).map((i: { agent_id: string }) => i.agent_id);
  }

  if (!agentIds.length) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true, agents: [] }) }],
    };
  }

  // ── Round 1: four independent bulk queries in parallel ──────────────
  const now = new Date();
  const staleThresholdMs = 30 * 60 * 1000; // 30 minutes
  const todayCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const [readPointers, allSessions, allParticipation, allStudios] = await Promise.all([
    // 1. All inbox read pointers for this user
    threadTable(supabase, 'agent_inbox_read_status')
      .select('agent_id, last_read_at')
      .eq('user_id', userId)
      .then((r: { data: unknown }) => r.data || []),

    // 2. All sessions: non-ended OR started today (covers active + today counts)
    supabase
      .from('sessions')
      .select('id, agent_id, lifecycle, current_phase, started_at, ended_at, studio_id, updated_at')
      .eq('user_id', userId)
      .in('agent_id', agentIds)
      .or(`ended_at.is.null,started_at.gte.${todayCutoff}`)
      .order('started_at', { ascending: false })
      .then((r: { data: unknown }) => r.data || []),

    // 3. All thread participation for these agents
    threadTable(supabase, 'inbox_thread_participants')
      .select('thread_id, agent_id')
      .in('agent_id', agentIds)
      .then((r: { data: unknown }) => r.data || [])
      .catch(() => []), // Thread tables may not exist yet

    // 4. Studios per agent (ownership-based, not session-based)
    supabase
      .from('studios')
      .select('id, agent_id')
      .eq('user_id', userId)
      .in('agent_id', agentIds)
      .in('status', ['active', 'idle'])
      .then((r: { data: unknown }) => r.data || []),
  ]);

  // Build read pointer map
  const readPointerMap = new Map<string, string>();
  for (const rp of readPointers as Array<{ agent_id: string; last_read_at: string }>) {
    readPointerMap.set(rp.agent_id, rp.last_read_at);
  }

  // Find the earliest pointer so we can fetch all potentially-unread messages in one query
  let minPointer: string | null = null;
  for (const [, ts] of readPointerMap) {
    if (!minPointer || ts < minPointer) minPointer = ts;
  }

  // Collect unique thread IDs from participation
  const threadIdSet = new Set<string>();
  for (const p of allParticipation as Array<{ thread_id: string; agent_id: string }>) {
    threadIdSet.add(p.thread_id);
  }
  const allThreadIds = [...threadIdSet];

  // ── Round 2: inbox messages + open threads (depend on round 1) ─────
  const [inboxMessages, openThreads] = await Promise.all([
    // 4. All inbox messages after earliest pointer (just agent_id + created_at for counting)
    (async () => {
      let q = supabase
        .from('agent_inbox')
        .select('recipient_agent_id, created_at')
        .eq('recipient_user_id', userId)
        .in('recipient_agent_id', agentIds);
      if (minPointer) {
        q = q.gt('created_at', minPointer);
      }
      const { data } = await q;
      return (data || []) as Array<{ recipient_agent_id: string; created_at: string }>;
    })(),

    // 5. Open threads for this user (filtered to threads agents participate in)
    (async () => {
      if (!allThreadIds.length) return [];
      const { data } = await threadTable(supabase, 'inbox_threads')
        .select('id')
        .eq('user_id', userId)
        .eq('status', 'open')
        .in('id', allThreadIds);
      return (data || []) as Array<{ id: string }>;
    })(),
  ]);

  const openThreadIds = openThreads.map((t) => t.id);

  // ── Round 3: thread read statuses + thread messages (depend on round 2) ─
  const [threadReadStatuses, threadMessages] = await Promise.all([
    // 6. All thread read statuses for open threads × agents
    (async () => {
      if (!openThreadIds.length) return [];
      const { data } = await threadTable(supabase, 'inbox_thread_read_status')
        .select('thread_id, agent_id, last_read_at')
        .in('thread_id', openThreadIds)
        .in('agent_id', agentIds);
      return (data || []) as Array<{
        thread_id: string;
        agent_id: string;
        last_read_at: string;
      }>;
    })(),

    // 7. All messages in open threads (just thread_id + created_at for counting)
    (async () => {
      if (!openThreadIds.length) return [];
      const { data } = await threadTable(supabase, 'inbox_thread_messages')
        .select('thread_id, created_at')
        .in('thread_id', openThreadIds);
      return (data || []) as Array<{ thread_id: string; created_at: string }>;
    })(),
  ]);

  // ── Aggregate in JS ───────────────────────────────────────────────────

  // Inbox unreads: count messages per agent where created_at > that agent's pointer
  const inboxUnreadMap = new Map<string, number>();
  for (const m of inboxMessages) {
    const pointer = readPointerMap.get(m.recipient_agent_id);
    if (!pointer || m.created_at > pointer) {
      inboxUnreadMap.set(m.recipient_agent_id, (inboxUnreadMap.get(m.recipient_agent_id) || 0) + 1);
    }
  }

  // Thread unreads: build per-agent read pointer lookup, then count messages
  const threadReadMap = new Map<string, string>(); // "threadId:agentId" → last_read_at
  for (const rs of threadReadStatuses) {
    threadReadMap.set(`${rs.thread_id}:${rs.agent_id}`, rs.last_read_at);
  }

  // Build agent → set of open thread IDs they participate in
  const agentOpenThreads = new Map<string, Set<string>>();
  const openThreadIdSet = new Set(openThreadIds);
  for (const p of allParticipation as Array<{ thread_id: string; agent_id: string }>) {
    if (!openThreadIdSet.has(p.thread_id)) continue;
    if (!agentOpenThreads.has(p.agent_id)) agentOpenThreads.set(p.agent_id, new Set());
    agentOpenThreads.get(p.agent_id)!.add(p.thread_id);
  }

  // Count unread thread messages per agent
  const threadUnreadMap = new Map<string, number>();
  for (const msg of threadMessages) {
    // For each agent that participates in this thread, check if message is unread
    for (const [aid, threads] of agentOpenThreads) {
      if (!threads.has(msg.thread_id)) continue;
      const lastRead = threadReadMap.get(`${msg.thread_id}:${aid}`);
      if (!lastRead || msg.created_at > lastRead) {
        threadUnreadMap.set(aid, (threadUnreadMap.get(aid) || 0) + 1);
      }
    }
  }

  // Sessions: group by agent_id in JS
  type SessionRow = {
    id: string;
    agent_id: string;
    lifecycle: string | null;
    current_phase: string | null;
    started_at: string | null;
    ended_at: string | null;
    studio_id: string | null;
    updated_at: string | null;
  };
  const sessionsByAgent = new Map<string, SessionRow[]>();
  const todayCountMap = new Map<string, number>();

  for (const s of allSessions as SessionRow[]) {
    // Active sessions (non-ended)
    if (!s.ended_at) {
      if (!sessionsByAgent.has(s.agent_id)) sessionsByAgent.set(s.agent_id, []);
      sessionsByAgent.get(s.agent_id)!.push(s);
    }
    // Sessions today (started in last 24h, including ended)
    if (s.started_at && s.started_at >= todayCutoff) {
      todayCountMap.set(s.agent_id, (todayCountMap.get(s.agent_id) || 0) + 1);
    }
  }

  // Studios: count per agent from the studios table (ownership-based)
  const studioCountMap = new Map<string, number>();
  for (const s of allStudios as Array<{ id: string; agent_id: string }>) {
    studioCountMap.set(s.agent_id, (studioCountMap.get(s.agent_id) || 0) + 1);
  }

  // Assemble summaries
  const agents = agentIds.map((agentId) => {
    const sessions = sessionsByAgent.get(agentId) || [];
    const latest = sessions[0] || null; // already sorted by started_at DESC

    const byLifecycle: Record<string, number> = {};
    for (const s of sessions) {
      const lc = s.lifecycle || 'unknown';
      byLifecycle[lc] = (byLifecycle[lc] || 0) + 1;
    }

    const generating = sessions.filter((s) => {
      if (s.lifecycle !== 'running') return false;
      if (!s.updated_at) return true;
      const updatedMs = Date.parse(s.updated_at);
      return !Number.isNaN(updatedMs) && now.getTime() - updatedMs < staleThresholdMs;
    }).length;

    const inboxUnread = inboxUnreadMap.get(agentId) || 0;
    const threadUnread = threadUnreadMap.get(agentId) || 0;

    return {
      agentId,
      inboxUnread,
      threadUnread,
      totalUnread: inboxUnread + threadUnread,
      activeSessions: sessions.length,
      sessionsByLifecycle: byLifecycle,
      generating,
      sessionsToday: todayCountMap.get(agentId) || 0,
      studioCount: studioCountMap.get(agentId) || 0,
      latestSession: latest
        ? {
            id: latest.id,
            lifecycle: latest.lifecycle,
            phase: latest.current_phase,
            startedAt: latest.started_at,
            endedAt: latest.ended_at,
            studioId: latest.studio_id,
          }
        : null,
    };
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ success: true, agents }),
      },
    ],
  };
}

// ============== Tool Registration ==============

export const inboxToolDefinitions = [
  {
    name: 'send_to_inbox',
    description:
      'Send a message to agent(s) or reply to a thread. Unified tool for all cross-agent messaging.\n\nSingle recipient: send_to_inbox(recipientAgentId: "lumen", content: "...")\nGroup thread: send_to_inbox(recipients: ["lumen", "aster"], threadKey: "pr:165", content: "...")\nReply to thread: send_to_inbox(recipientAgentId: "lumen", threadKey: "pr:165", content: "...")\n\nWhen threadKey is provided, messages go to inbox_thread_messages (thread-first model). Late joiners see full history. Without threadKey, creates a simple agent_inbox row.\n\nFor existing threads, reply semantics are automatic: closed threads are rejected, and smart trigger defaults apply (1:1 → other participant; group non-creator → creator; group creator → no one). Override with triggerAll or triggerAgents.\n\nMessage types:\n- message: General communication\n- task_request: Request another agent to do work\n- session_resume: Request agent to resume a specific session\n- notification: FYI, no response needed\n- permission_grant: Grant or revoke tool permissions\n\nTrigger behavior:\nAll message types trigger recipients by default. Set trigger=false only if the message can wait 5+ hours.\n\nUser can be identified by ONE of: userId, email, phone, or platform + platformId',
    schema: sendToInboxSchema,
    handler: handleSendToInbox,
  },
  {
    name: 'get_inbox',
    description:
      "Get messages from an agent's inbox. Returns unread messages by default. Omit agentId to get inbox across ALL agents in one query (useful for unified timelines like mission control). Sorted by created_at descending.",
    schema: getInboxSchema,
    handler: handleGetInbox,
  },
  {
    name: 'update_inbox_message',
    description: 'Update message status (mark as read, acknowledged, or completed).',
    schema: updateInboxMessageSchema,
    handler: handleUpdateInboxMessage,
  },
  {
    name: 'mark_inbox_read',
    description:
      "Advance the agent's inbox read pointer. All messages created before the pointer are considered read. Defaults to now (marks everything read). Use 'before' to mark up to a specific timestamp.",
    schema: markInboxReadSchema,
    handler: handleMarkInboxRead,
  },
  {
    name: 'get_agent_status',
    description:
      'Get status of an agent: active/inactive, unread message count, last session info.',
    schema: getAgentStatusSchema,
    handler: handleGetAgentStatus,
  },
  {
    name: 'get_agent_summaries',
    description:
      'Get summaries for all agents in one call. Returns per-agent unread counts (legacy inbox + thread-aware with proper per-agent read status), active session count, and latest session lifecycle/phase. Ideal for dashboards and mission control. Omit agentIds to auto-discover all agents.',
    schema: getAgentSummariesSchema,
    handler: handleGetAgentSummaries,
  },
];
