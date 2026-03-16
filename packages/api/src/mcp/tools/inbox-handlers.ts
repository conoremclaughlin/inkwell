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
      'Whether to trigger (wake) the recipient agent after sending. Defaults to true for ALL message types. Only set to false if the message can genuinely wait 5+ hours for the next heartbeat cycle. Most agents do not have heartbeats — untriggered messages may never be seen.'
    ),
  triggerType: z
    .enum(['task_complete', 'approval_needed', 'message', 'error', 'custom'])
    .optional()
    .describe('Type of trigger (only used if trigger=true)'),
  triggerSummary: z
    .string()
    .optional()
    .describe('Brief summary for the trigger (only used if trigger=true)'),
});

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
});

const updateInboxMessageSchema = userIdentifierBaseSchema.extend({
  messageId: z.string().uuid().describe('Message ID to update'),
  agentId: z.string().describe('Agent ID making the update (must be recipient)'),
  status: z.enum(['read', 'acknowledged', 'completed']).describe('New status'),
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
  const senderStudioId = reqCtx?.workspaceId || sessCtx?.workspaceId || null;

  if (!senderSessionId && senderAgentId) {
    try {
      const activeSession = threadKey
        ? ((await dataComposer.repositories.memory.getActiveSessionByThreadKey(
            resolved.user.id,
            senderAgentId,
            threadKey,
            senderStudioId
          )) ??
          (await dataComposer.repositories.memory.getActiveSession(
            resolved.user.id,
            senderAgentId,
            senderStudioId
          )))
        : await dataComposer.repositories.memory.getActiveSession(
            resolved.user.id,
            senderAgentId,
            senderStudioId
          );
      if (activeSession) {
        senderSessionId = activeSession.id;
      }
    } catch (err) {
      logger.warn('Failed to resolve sender session from active sessions', {
        error: err instanceof Error ? err.message : String(err),
        senderAgentId,
      });
    }
  }

  // ── Thread-first path: when threadKey is provided, route to thread tables ──
  // Single-recipient with threadKey creates a 2-participant thread (spec invariant #5).
  // recipients[] creates a multi-participant thread.
  // Without threadKey, falls through to legacy agent_inbox path.
  if (threadKey) {
    const allRecipients = recipients || [recipientAgentId!];
    // Include sender as participant if they have an identity
    const allParticipants = senderAgentId
      ? [...new Set([senderAgentId, ...allRecipients])]
      : allRecipients;

    // Find or create thread
    let thread = await findOrCreateThread(supabase, {
      userId: resolved.user.id,
      threadKey,
      creatorAgentId: triggerSenderId,
      title: subject || null,
      participants: allParticipants,
    });

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
    const threadMessageMetadata = {
      ...rawMeta,
      pcp: {
        ...existingPcpMeta,
        sender: {
          agentId: triggerSenderId,
          sessionId: senderSessionId,
          studioId: senderStudioId,
        },
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

    logger.info('Thread message sent', {
      messageId: threadMessage.id,
      threadKey,
      to: allRecipients,
      from: triggerSenderId,
      type: messageType,
      isNewThread: thread.isNew,
    });

    // Trigger: on thread creation, trigger all initial participants
    const triggeredAgents: string[] = [];
    if (trigger) {
      const gateway = getAgentGateway();
      const agentsToTrigger = allRecipients.filter((a) => a !== senderAgentId);

      for (const toAgentId of agentsToTrigger) {
        // Auto-resolve recipientSessionId: find the recipient's most recent
        // message on this thread to extract their sender session. This ensures
        // replies route back to the session that originated the conversation,
        // not whatever session happens to be most recently updated.
        let resolvedRecipientSessionId: string | undefined =
          effectiveRecipientSessionId || undefined;
        if (!resolvedRecipientSessionId) {
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

  if (trigger) {
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

    // Auto-mark as read: if the trigger was accepted, the recipient agent
    // has been woken up to process this message.
    if (result.accepted) {
      await supabase
        .from('agent_inbox')
        .update({ status: 'read', read_at: new Date().toISOString() })
        .eq('id', message.id)
        .eq('status', 'unread'); // Only transition unread → read
    }
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

  const { status = 'unread', priority, messageType, limit = 20 } = parsed;
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

  // Count unread for context
  let unreadQuery = supabase
    .from('agent_inbox')
    .select('*', { count: 'exact', head: true })
    .eq('recipient_user_id', resolved.user.id)
    .eq('status', 'unread');
  if (agentId) {
    unreadQuery = unreadQuery.eq('recipient_agent_id', agentId);
  }
  const { count: unreadCount } = await unreadQuery;

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
      // Get open threads for this user
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
                    content: m.content.slice(0, 200),
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
                  'You have unread thread messages. Use get_thread_messages(threadKey) to read them, reply_to_thread to respond, or mark_thread_read to acknowledge.',
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

  // Verify the message belongs to this agent
  const { data: existing, error: fetchError } = await supabase
    .from('agent_inbox')
    .select('*')
    .eq('id', messageId)
    .eq('recipient_user_id', resolved.user.id)
    .eq('recipient_agent_id', agentId)
    .single();

  if (fetchError) {
    throw new Error(`Message not found or not accessible: ${messageId}`);
  }

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

  // Get unread message count
  const { count: unreadCount } = await supabase
    .from('agent_inbox')
    .select('*', { count: 'exact', head: true })
    .eq('recipient_user_id', resolved.user.id)
    .eq('recipient_agent_id', agentId)
    .eq('status', 'unread');

  // Get urgent message count
  const { count: urgentCount } = await supabase
    .from('agent_inbox')
    .select('*', { count: 'exact', head: true })
    .eq('recipient_user_id', resolved.user.id)
    .eq('recipient_agent_id', agentId)
    .eq('status', 'unread')
    .eq('priority', 'urgent');

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

  // Batch queries: legacy inbox unreads, sessions, thread unreads
  const [inboxCounts, sessionResults] = await Promise.all([
    // Legacy inbox unreads per agent
    Promise.all(
      agentIds.map(async (agentId) => {
        const { count } = await supabase
          .from('agent_inbox')
          .select('*', { count: 'exact', head: true })
          .eq('recipient_user_id', userId)
          .eq('recipient_agent_id', agentId)
          .eq('status', 'unread');
        return { agentId, count: count || 0 };
      })
    ),
    // Active (non-ended) sessions per agent — no limit so we get accurate counts
    Promise.all(
      agentIds.map(async (agentId) => {
        const { data } = await supabase
          .from('sessions')
          .select('id, agent_id, lifecycle, current_phase, started_at, ended_at, workspace_id')
          .eq('user_id', userId)
          .eq('agent_id', agentId)
          .is('ended_at', null)
          .order('started_at', { ascending: false });
        return { agentId, sessions: data || [] };
      })
    ),
  ]);

  // Thread unreads per agent (with proper per-agent last_read_at)
  const threadUnreadByAgent: Record<string, number> = {};
  try {
    // Get all threads this user's agents participate in
    const participantData = await Promise.all(
      agentIds.map(async (agentId) => {
        const { data: rows } = await threadTable(supabase, 'inbox_thread_participants')
          .select('thread_id')
          .eq('agent_id', agentId);
        return { agentId, threadIds: (rows || []).map((r: { thread_id: string }) => r.thread_id) };
      })
    );

    // For each agent's threads, compute unread count using their last_read_at
    await Promise.all(
      participantData.map(async ({ agentId, threadIds }) => {
        if (!threadIds.length) {
          threadUnreadByAgent[agentId] = 0;
          return;
        }

        // Filter to open threads owned by this user
        const { data: openThreads } = await threadTable(supabase, 'inbox_threads')
          .select('id')
          .eq('user_id', userId)
          .eq('status', 'open')
          .in('id', threadIds);

        const openThreadIds = (openThreads || []).map((t: { id: string }) => t.id);
        if (!openThreadIds.length) {
          threadUnreadByAgent[agentId] = 0;
          return;
        }

        // Get read status for each thread
        const { data: readStatuses } = await threadTable(supabase, 'inbox_thread_read_status')
          .select('thread_id, last_read_at')
          .eq('agent_id', agentId)
          .in('thread_id', openThreadIds);

        const readMap = new Map<string, string>();
        for (const rs of readStatuses || []) {
          readMap.set(
            (rs as { thread_id: string }).thread_id,
            (rs as { last_read_at: string }).last_read_at
          );
        }

        // Count unread messages per thread
        let totalUnread = 0;
        await Promise.all(
          openThreadIds.map(async (threadId: string) => {
            const lastReadAt = readMap.get(threadId);
            let query = threadTable(supabase, 'inbox_thread_messages')
              .select('*', { count: 'exact', head: true })
              .eq('thread_id', threadId);
            if (lastReadAt) {
              query = query.gt('created_at', lastReadAt);
            }
            const { count } = await query;
            totalUnread += count || 0;
          })
        );

        threadUnreadByAgent[agentId] = totalUnread;
      })
    );
  } catch {
    // Thread tables may not exist yet — graceful fallback
    logger.debug('get_agent_summaries: thread tables not available, skipping thread unreads');
  }

  // Build per-agent inbox count map
  const inboxCountMap = new Map<string, number>();
  for (const { agentId, count } of inboxCounts) {
    inboxCountMap.set(agentId, count);
  }

  // Build per-agent session map
  const sessionMap = new Map<
    string,
    Array<{
      id: string;
      lifecycle: string | null;
      current_phase: string | null;
      started_at: string | null;
      ended_at: string | null;
      workspace_id: string | null;
    }>
  >();
  for (const { agentId, sessions } of sessionResults) {
    sessionMap.set(agentId, sessions);
  }

  // Assemble summaries
  const agents = agentIds.map((agentId) => {
    const sessions = sessionMap.get(agentId) || [];
    const latest = sessions[0] || null;

    // Count sessions by lifecycle state
    const byLifecycle: Record<string, number> = {};
    for (const s of sessions) {
      const lc = s.lifecycle || 'unknown';
      byLifecycle[lc] = (byLifecycle[lc] || 0) + 1;
    }

    const inboxUnread = inboxCountMap.get(agentId) || 0;
    const threadUnread = threadUnreadByAgent[agentId] || 0;

    return {
      agentId,
      inboxUnread,
      threadUnread,
      totalUnread: inboxUnread + threadUnread,
      activeSessions: sessions.length,
      sessionsByLifecycle: byLifecycle,
      latestSession: latest
        ? {
            id: latest.id,
            lifecycle: latest.lifecycle,
            phase: latest.current_phase,
            startedAt: latest.started_at,
            endedAt: latest.ended_at,
            workspaceId: latest.workspace_id,
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
      'Send a message to agent(s). Supports both simple inbox messages and group threads.\n\nSingle recipient: send_to_inbox(recipientAgentId: "lumen", content: "...")\nGroup thread: send_to_inbox(recipients: ["lumen", "aster"], threadKey: "pr:165", content: "...")\n\nWhen threadKey is provided, messages go to inbox_thread_messages (thread-first model). Late joiners see full history. Without threadKey, creates a simple agent_inbox row (unchanged behavior).\n\nFor existing threads, use reply_to_thread instead — it has smarter trigger defaults (1:1 triggers other participant, group triggers creator only).\n\nMessage types:\n- message: General communication\n- task_request: Request another agent to do work\n- session_resume: Request agent to resume a specific session\n- notification: FYI, no response needed\n- permission_grant: Grant or revoke tool permissions\n\nTrigger behavior:\nAll message types trigger recipients by default. On thread creation, all initial participants are triggered. Set trigger=false only if the message can wait 5+ hours.\n\nUser can be identified by ONE of: userId, email, phone, or platform + platformId',
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
