/**
 * Agent Inbox Handlers
 *
 * MCP tools for cross-agent messaging. Allows AI beings to send messages
 * to each other asynchronously for coordination and task handoff.
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { resolveUserOrThrow, userIdentifierBaseSchema } from '../../services/user-resolver';
import { logger } from '../../utils/logger';
import type { Json } from '../../data/supabase/types';
import { getAgentGateway, type AgentTriggerPayload } from '../../channels/agent-gateway.js';

// ============== Schemas ==============

const sendToInboxSchema = userIdentifierBaseSchema.extend({
  recipientAgentId: z
    .string()
    .describe('Agent ID to send message to (e.g., "wren", "myra", "claude-code")'),
  senderAgentId: z.string().optional().describe('Agent ID of sender (optional if from human)'),
  subject: z.string().optional().describe('Message subject'),
  content: z.string().describe('Message content'),
  messageType: z
    .enum(['message', 'task_request', 'session_resume', 'notification'])
    .optional()
    .default('message')
    .describe('Type of message'),
  priority: z
    .enum(['low', 'normal', 'high', 'urgent'])
    .optional()
    .default('normal')
    .describe('Message priority'),
  relatedSessionId: z
    .string()
    .uuid()
    .optional()
    .describe('Related session ID (for resume requests)'),
  relatedArtifactUri: z.string().optional().describe('Related artifact URI'),
  metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
  expiresAt: z.string().datetime().optional().describe('When this message expires'),
  threadKey: z
    .string()
    .optional()
    .describe(
      'Thread key for conversation continuity (e.g., "pr:32", "spec:cli-hooks"). Messages with the same threadKey are routed to the same session on the recipient side. See PROCESS.md for format guidelines.'
    ),
  // Trigger options - automatically trigger the recipient after sending
  trigger: z
    .boolean()
    .optional()
    .describe(
      'If true, automatically trigger the recipient agent after sending. Defaults to true for task_request and session_resume, false for notification and message.'
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
  agentId: z.string().describe('Agent ID to get inbox for'),
  status: z
    .enum(['unread', 'read', 'acknowledged', 'completed', 'all'])
    .optional()
    .default('unread')
    .describe('Filter by status'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('Filter by priority'),
  messageType: z.enum(['message', 'task_request', 'session_resume', 'notification']).optional(),
  limit: z.number().min(1).max(100).optional().default(20).describe('Max messages'),
});

const updateInboxMessageSchema = userIdentifierBaseSchema.extend({
  messageId: z.string().uuid().describe('Message ID to update'),
  agentId: z.string().describe('Agent ID making the update (must be recipient)'),
  status: z.enum(['read', 'acknowledged', 'completed']).describe('New status'),
});

const getAgentStatusSchema = userIdentifierBaseSchema.extend({
  agentId: z.string().describe('Agent ID to check status for'),
});

// ============== Handlers ==============

export async function handleSendToInbox(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = sendToInboxSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const {
    recipientAgentId,
    senderAgentId,
    subject,
    content,
    messageType = 'message',
    priority = 'normal',
    relatedSessionId,
    relatedArtifactUri,
    metadata = {},
    expiresAt,
    triggerType,
    triggerSummary,
    threadKey,
  } = parsed;

  // Default trigger behavior based on message type:
  // task_request and session_resume trigger immediately (time-sensitive handoffs)
  // notification and message wait for natural wake-up (heartbeat)
  const shouldTriggerByDefault = messageType === 'task_request' || messageType === 'session_resume';
  const trigger = parsed.trigger ?? shouldTriggerByDefault;

  const { data: message, error } = await supabase
    .from('agent_inbox')
    .insert({
      recipient_user_id: resolved.user.id,
      recipient_agent_id: recipientAgentId,
      sender_user_id: senderAgentId ? null : resolved.user.id,
      sender_agent_id: senderAgentId || null,
      subject,
      content,
      message_type: messageType,
      priority,
      related_session_id: relatedSessionId || null,
      related_artifact_uri: relatedArtifactUri || null,
      metadata: metadata as Json,
      expires_at: expiresAt || null,
      thread_key: threadKey || null,
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
    error?: string;
  } = {
    triggered: false,
  };

  if (trigger && senderAgentId) {
    const gateway = getAgentGateway();
    const payload: AgentTriggerPayload = {
      fromAgentId: senderAgentId,
      toAgentId: recipientAgentId,
      inboxMessageId: message.id,
      triggerType: triggerType || 'message',
      summary: triggerSummary || subject || `New ${messageType} from ${senderAgentId}`,
      priority,
      threadKey,
    };

    // Fire-and-forget: don't await the trigger processing
    // The message is already in the inbox - we just need to wake the agent
    gateway
      .processTrigger(payload)
      .then((result) => {
        logger.info('Inbox message trigger completed', {
          messageId: message.id,
          triggerId: result.triggerId,
          processed: result.processed,
          error: result.error,
        });
      })
      .catch((error) => {
        logger.error('Inbox message trigger failed', {
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    triggerResult = {
      triggered: true,
      triggerId: 'async', // Trigger ID assigned asynchronously
      processed: undefined, // Processing happens in background
    };

    logger.info('Inbox message trigger dispatched (async)', {
      messageId: message.id,
      recipientAgentId,
    });
  } else if (trigger && !senderAgentId) {
    logger.warn('Trigger requested but no senderAgentId provided', { messageId: message.id });
    triggerResult = {
      triggered: false,
      error: 'Cannot trigger without senderAgentId',
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
          threadKey: threadKey || null,
          createdAt: message.created_at,
          trigger: triggerResult,
          ...(!threadKey
            ? {
                hint: 'Consider adding a threadKey (e.g., "pr:32", "spec:cli-hooks") so the recipient can resume the same session for follow-up messages on this topic.',
              }
            : {}),
        }),
      },
    ],
  };
}

export async function handleGetInbox(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = getInboxSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const { agentId, status = 'unread', priority, messageType, limit = 20 } = parsed;

  let query = supabase
    .from('agent_inbox')
    .select('*')
    .eq('recipient_user_id', resolved.user.id)
    .eq('recipient_agent_id', agentId)
    .order('priority', { ascending: false }) // urgent first
    .order('created_at', { ascending: false })
    .limit(limit);

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
  const { count: unreadCount } = await supabase
    .from('agent_inbox')
    .select('*', { count: 'exact', head: true })
    .eq('recipient_user_id', resolved.user.id)
    .eq('recipient_agent_id', agentId)
    .eq('status', 'unread');

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          agentId,
          unreadCount: unreadCount || 0,
          count: messages?.length || 0,
          messages: (messages || []).map((m) => ({
            id: m.id,
            subject: m.subject,
            content: m.content,
            messageType: m.message_type,
            priority: m.priority,
            status: m.status,
            senderAgentId: m.sender_agent_id,
            threadKey: m.thread_key || null,
            relatedSessionId: m.related_session_id,
            relatedArtifactUri: m.related_artifact_uri,
            metadata: m.metadata,
            createdAt: m.created_at,
            readAt: m.read_at,
          })),
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
    .from('workspaces')
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

// ============== Tool Registration ==============

export const inboxToolDefinitions = [
  {
    name: 'send_to_inbox',
    description:
      "Send a message to another agent's inbox. Use for cross-agent communication, task handoff, or session resume requests.\n\nMessage types:\n- message: General communication\n- task_request: Request another agent to do work\n- session_resume: Request agent to resume a specific session\n- notification: FYI, no response needed\n\nUser can be identified by ONE of: userId, email, phone, or platform + platformId",
    schema: sendToInboxSchema,
    handler: handleSendToInbox,
  },
  {
    name: 'get_inbox',
    description: "Get messages from an agent's inbox. Returns unread messages by default.",
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
];
