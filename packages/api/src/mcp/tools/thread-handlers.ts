/**
 * Thread Handlers
 *
 * MCP tools for group thread messaging. Threads are first-class conversation
 * entities where messages belong to the thread, not individual recipients.
 * Late joiners see full history.
 *
 * Spec: pcp://specs/cross-agent-communication v7
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { resolveUserOrThrow, userIdentifierBaseSchema } from '../../services/user-resolver';
import { getEffectiveAgentId } from '../../auth/enforce-identity';
import { logger } from '../../utils/logger';
import type { Json } from '../../data/supabase/types';
import { getAgentGateway, type AgentTriggerPayload } from '../../channels/agent-gateway.js';

// The thread tables are new and not yet in generated Supabase types.
// Use type-safe wrappers that cast the table name for PostgREST queries.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = ReturnType<DataComposer['getClient']>;
const threadTable = (supabase: SupabaseClient, table: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (supabase as any).from(table);

// ============== Schemas ==============

const threadKeySchema = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*:[^\s]+$/, 'threadKey must look like "type:identifier"');

const agentIdSchema = z.string().min(1).max(64);

const getThreadMessagesSchema = userIdentifierBaseSchema.extend({
  threadKey: threadKeySchema,
  agentId: z.string().describe('Agent ID requesting access (must be a participant)'),
  limit: z.number().int().min(1).max(200).optional().default(50),
  beforeMessageId: z.string().uuid().optional().describe('Cursor: get messages before this ID'),
  afterMessageId: z.string().uuid().optional().describe('Cursor: get messages after this ID'),
  includeSystemEvents: z.boolean().optional().default(true),
  markRead: z.boolean().optional().default(true),
});

const replyToThreadSchema = userIdentifierBaseSchema.extend({
  threadKey: threadKeySchema,
  content: z.string().min(1).max(20000),
  senderAgentId: z.string().optional(),
  messageType: z
    .enum(['message', 'task_request', 'session_resume', 'notification'])
    .optional()
    .default('message'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().default('normal'),
  triggerAll: z.boolean().optional().default(false),
  triggerAgents: z
    .array(agentIdSchema)
    .max(16)
    .optional()
    .describe(
      'Trigger specific participants by agent ID. Overrides default trigger rules. Non-participants are silently ignored.'
    ),
  metadata: z.record(z.unknown()).optional(),
});

const addThreadParticipantSchema = userIdentifierBaseSchema.extend({
  threadKey: threadKeySchema,
  agentId: agentIdSchema.describe('Agent ID to add to the thread'),
  addedByAgentId: agentIdSchema.optional(),
  reason: z.string().max(500).optional(),
  triggerNewParticipant: z.boolean().optional().default(true),
  metadata: z.record(z.unknown()).optional(),
});

const closeThreadSchema = userIdentifierBaseSchema.extend({
  threadKey: threadKeySchema,
  agentId: agentIdSchema.describe('Agent ID closing the thread (must be a participant)'),
});

const listThreadsSchema = userIdentifierBaseSchema.extend({
  agentId: agentIdSchema.describe('Agent ID to list threads for'),
  status: z.enum(['open', 'closed', 'all']).optional().default('open'),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

const markThreadReadSchema = userIdentifierBaseSchema.extend({
  threadKey: threadKeySchema,
  agentId: agentIdSchema.describe('Agent ID marking the thread as read'),
});

// ============== Helpers ==============

interface ThreadRow {
  id: string;
  thread_key: string;
  user_id: string;
  created_by_agent_id: string;
  title: string | null;
  status: string;
  metadata: Json;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_by_agent_id: string | null;
}

/**
 * Look up a thread by (user_id, thread_key). Returns null if not found.
 */
async function findThread(
  supabase: ReturnType<DataComposer['getClient']>,
  userId: string,
  threadKey: string
): Promise<ThreadRow | null> {
  const { data, error } = await threadTable(supabase, 'inbox_threads')
    .select('*')
    .eq('user_id', userId)
    .eq('thread_key', threadKey)
    .maybeSingle();

  if (error) {
    logger.error('Failed to find thread', { error, threadKey });
    throw new Error(`Failed to find thread: ${error.message}`);
  }
  return data;
}

/**
 * Get all participant agent IDs for a thread.
 */
async function getParticipants(
  supabase: ReturnType<DataComposer['getClient']>,
  threadId: string
): Promise<string[]> {
  const { data, error } = await threadTable(supabase, 'inbox_thread_participants')
    .select('agent_id')
    .eq('thread_id', threadId);

  if (error) {
    logger.error('Failed to get participants', { error, threadId });
    throw new Error(`Failed to get participants: ${error.message}`);
  }
  return (data || []).map((p: { agent_id: string }) => p.agent_id);
}

/**
 * Check if an agent is a participant in a thread.
 */
async function isParticipant(
  supabase: ReturnType<DataComposer['getClient']>,
  threadId: string,
  agentId: string
): Promise<boolean> {
  const { data } = await threadTable(supabase, 'inbox_thread_participants')
    .select('agent_id')
    .eq('thread_id', threadId)
    .eq('agent_id', agentId)
    .maybeSingle();
  return !!data;
}

/**
 * Determine which agents to trigger based on thread context.
 *
 * Rules (from spec v7):
 * 1. triggerAgents [...] → wake exactly these (filter to participants)
 * 2. triggerAll: true → wake all participants except sender
 * 3. Default: 1:1 → other participant; group non-creator → creator; group creator → no one
 */
function resolveTriggeredAgents(opts: {
  senderAgentId: string;
  participants: string[];
  creatorAgentId: string;
  triggerAgents?: string[];
  triggerAll?: boolean;
}): string[] {
  const { senderAgentId, participants, creatorAgentId, triggerAgents, triggerAll } = opts;

  // Precedence 1: explicit triggerAgents (filter to actual participants, exclude sender)
  if (triggerAgents && triggerAgents.length > 0) {
    const participantSet = new Set(participants);
    return triggerAgents.filter((a) => a !== senderAgentId && participantSet.has(a));
  }

  // Precedence 2: triggerAll — everyone except sender
  if (triggerAll) {
    return participants.filter((a) => a !== senderAgentId);
  }

  // Precedence 3: default rules by thread size
  const otherParticipants = participants.filter((a) => a !== senderAgentId);

  // Self-thread (1 participant): no trigger
  if (otherParticipants.length === 0) {
    return [];
  }

  // 1:1 thread (2 participants): trigger the other one
  if (participants.length === 2) {
    return otherParticipants;
  }

  // Group thread: non-creator reply → trigger creator only
  if (senderAgentId !== creatorAgentId) {
    return [creatorAgentId];
  }

  // Group thread: creator reply → trigger no one
  return [];
}

/**
 * Dispatch triggers to a list of agents.
 */
function dispatchTriggers(
  agentsToTrigger: string[],
  opts: {
    fromAgentId: string;
    threadKey: string;
    summary: string;
    priority: string;
    threadMessageId?: string;
    threadId?: string;
  }
): void {
  if (agentsToTrigger.length === 0) return;

  const gateway = getAgentGateway();
  for (const toAgentId of agentsToTrigger) {
    const payload: AgentTriggerPayload = {
      fromAgentId: opts.fromAgentId,
      toAgentId,
      threadMessageId: opts.threadMessageId,
      threadId: opts.threadId,
      triggerType: 'message',
      summary: opts.summary,
      priority: opts.priority as AgentTriggerPayload['priority'],
      threadKey: opts.threadKey,
    };
    gateway.dispatchTrigger(payload);
  }
}

// ============== Handlers ==============

export async function handleGetThreadMessages(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = getThreadMessagesSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const agentId = getEffectiveAgentId(parsed.agentId) ?? parsed.agentId;
  const { threadKey, limit, beforeMessageId, afterMessageId, includeSystemEvents, markRead } =
    parsed;

  // Find thread
  const thread = await findThread(supabase, resolved.user.id, threadKey);
  if (!thread) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ success: false, error: `Thread not found: ${threadKey}` }),
        },
      ],
    };
  }

  // Verify participant membership
  if (!(await isParticipant(supabase, thread.id, agentId))) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: false,
            error: `Agent ${agentId} is not a participant in thread ${threadKey}`,
          }),
        },
      ],
    };
  }

  // Build query
  let query = threadTable(supabase, 'inbox_thread_messages')
    .select('*')
    .eq('thread_id', thread.id)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (!includeSystemEvents) {
    query = query.neq('message_type', 'system');
  }

  if (beforeMessageId) {
    // Get the created_at of the cursor message for pagination
    const { data: cursor } = await threadTable(supabase, 'inbox_thread_messages')
      .select('created_at')
      .eq('id', beforeMessageId)
      .single();
    if (cursor) {
      query = query.lt('created_at', cursor.created_at);
    }
  }

  if (afterMessageId) {
    const { data: cursor } = await threadTable(supabase, 'inbox_thread_messages')
      .select('created_at')
      .eq('id', afterMessageId)
      .single();
    if (cursor) {
      query = query.gt('created_at', cursor.created_at);
    }
  }

  const { data: messages, error } = await query;
  if (error) {
    throw new Error(`Failed to get thread messages: ${error.message}`);
  }

  // Get participants
  const participants = await getParticipants(supabase, thread.id);

  // Mark as read
  if (markRead && messages && messages.length > 0) {
    await threadTable(supabase, 'inbox_thread_read_status').upsert(
      {
        thread_id: thread.id,
        agent_id: agentId,
        last_read_at: new Date().toISOString(),
      },
      { onConflict: 'thread_id,agent_id' }
    );
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          threadKey,
          threadId: thread.id,
          title: thread.title,
          status: thread.status,
          createdBy: thread.created_by_agent_id,
          participants,
          messageCount: messages?.length || 0,
          messages: (messages || []).map((m: Record<string, unknown>) => ({
            id: m.id,
            senderAgentId: m.sender_agent_id,
            content: m.content,
            messageType: m.message_type,
            priority: m.priority,
            metadata: m.metadata,
            createdAt: m.created_at,
          })),
        }),
      },
    ],
  };
}

export async function handleReplyToThread(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = replyToThreadSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const senderAgentId = getEffectiveAgentId(parsed.senderAgentId) ?? parsed.senderAgentId;
  if (!senderAgentId) {
    throw new Error('senderAgentId is required (or must be resolvable from auth context)');
  }

  const { threadKey, content, messageType, priority, triggerAll, triggerAgents, metadata } = parsed;

  // Find thread
  const thread = await findThread(supabase, resolved.user.id, threadKey);
  if (!thread) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ success: false, error: `Thread not found: ${threadKey}` }),
        },
      ],
    };
  }

  // Reject replies on closed threads
  if (thread.status === 'closed') {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: false,
            error: `Thread ${threadKey} is closed. Cannot reply to closed threads.`,
          }),
        },
      ],
    };
  }

  // Verify participant membership
  if (!(await isParticipant(supabase, thread.id, senderAgentId))) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: false,
            error: `Agent ${senderAgentId} is not a participant in thread ${threadKey}`,
          }),
        },
      ],
    };
  }

  // Insert message
  const { data: message, error } = await threadTable(supabase, 'inbox_thread_messages')
    .insert({
      thread_id: thread.id,
      sender_agent_id: senderAgentId,
      content,
      message_type: messageType,
      priority,
      metadata: (metadata || {}) as Json,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to reply to thread: ${error.message}`);
  }

  // Update thread updated_at
  await threadTable(supabase, 'inbox_threads')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', thread.id);

  // Update sender's read status
  await threadTable(supabase, 'inbox_thread_read_status').upsert(
    {
      thread_id: thread.id,
      agent_id: senderAgentId,
      last_read_at: new Date().toISOString(),
    },
    { onConflict: 'thread_id,agent_id' }
  );

  // Resolve triggers
  const participants = await getParticipants(supabase, thread.id);
  const agentsToTrigger = resolveTriggeredAgents({
    senderAgentId,
    participants,
    creatorAgentId: thread.created_by_agent_id,
    triggerAgents,
    triggerAll,
  });

  logger.info('Thread reply sent', {
    threadKey,
    messageId: message.id,
    from: senderAgentId,
    triggering: agentsToTrigger,
  });

  // Dispatch triggers
  dispatchTriggers(agentsToTrigger, {
    fromAgentId: senderAgentId,
    threadKey,
    summary: `Reply in thread ${threadKey} from ${senderAgentId}`,
    priority,
    threadMessageId: message.id,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          message: 'Reply sent',
          messageId: message.id,
          threadKey,
          senderAgentId,
          triggered: agentsToTrigger,
          participants,
        }),
      },
    ],
  };
}

export async function handleAddThreadParticipant(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = addThreadParticipantSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const { threadKey, agentId, reason, triggerNewParticipant, metadata } = parsed;
  const addedByAgentId = getEffectiveAgentId(parsed.addedByAgentId) ?? parsed.addedByAgentId;

  // Find thread
  const thread = await findThread(supabase, resolved.user.id, threadKey);
  if (!thread) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ success: false, error: `Thread not found: ${threadKey}` }),
        },
      ],
    };
  }

  // Idempotent: check if already participant
  if (await isParticipant(supabase, thread.id, agentId)) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: `${agentId} is already a participant in thread ${threadKey}`,
            alreadyParticipant: true,
            threadKey,
          }),
        },
      ],
    };
  }

  // Add participant
  const { error: addError } = await threadTable(supabase, 'inbox_thread_participants').insert({
    thread_id: thread.id,
    agent_id: agentId,
  });

  if (addError) {
    throw new Error(`Failed to add participant: ${addError.message}`);
  }

  // Add system message for audit trail
  const systemContent = addedByAgentId
    ? `${agentId} was added to the thread by ${addedByAgentId}${reason ? `: ${reason}` : ''}`
    : `${agentId} joined the thread${reason ? `: ${reason}` : ''}`;

  await threadTable(supabase, 'inbox_thread_messages').insert({
    thread_id: thread.id,
    sender_agent_id: 'system',
    content: systemContent,
    message_type: 'system',
    metadata: {
      type: 'participant_added',
      agentId,
      addedBy: addedByAgentId || null,
      reason: reason || null,
      ...(metadata || {}),
    } as Json,
  });

  logger.info('Thread participant added', { threadKey, agentId, addedBy: addedByAgentId });

  // Trigger the new participant
  if (triggerNewParticipant) {
    dispatchTriggers([agentId], {
      fromAgentId: addedByAgentId || 'system',
      threadKey,
      summary: `You were added to thread ${threadKey}${reason ? `: ${reason}` : ''}`,
      priority: 'normal',
      threadId: thread.id,
    });
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          message: `${agentId} added to thread ${threadKey}`,
          threadKey,
          agentId,
          triggered: triggerNewParticipant,
        }),
      },
    ],
  };
}

export async function handleCloseThread(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = closeThreadSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const agentId = getEffectiveAgentId(parsed.agentId) ?? parsed.agentId;
  const { threadKey } = parsed;

  // Find thread
  const thread = await findThread(supabase, resolved.user.id, threadKey);
  if (!thread) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ success: false, error: `Thread not found: ${threadKey}` }),
        },
      ],
    };
  }

  if (thread.status === 'closed') {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: `Thread ${threadKey} is already closed`,
            alreadyClosed: true,
          }),
        },
      ],
    };
  }

  // Verify participant
  if (!(await isParticipant(supabase, thread.id, agentId))) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: false,
            error: `Agent ${agentId} is not a participant in thread ${threadKey}`,
          }),
        },
      ],
    };
  }

  // Close the thread
  const now = new Date().toISOString();
  const { error } = await threadTable(supabase, 'inbox_threads')
    .update({
      status: 'closed',
      closed_by_agent_id: agentId,
      closed_at: now,
      updated_at: now,
    })
    .eq('id', thread.id);

  if (error) {
    throw new Error(`Failed to close thread: ${error.message}`);
  }

  // Add system message
  await threadTable(supabase, 'inbox_thread_messages').insert({
    thread_id: thread.id,
    sender_agent_id: 'system',
    content: `Thread closed by ${agentId}`,
    message_type: 'system',
    metadata: { type: 'thread_closed', closedBy: agentId } as Json,
  });

  logger.info('Thread closed', { threadKey, closedBy: agentId });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          message: `Thread ${threadKey} closed`,
          threadKey,
          closedBy: agentId,
        }),
      },
    ],
  };
}

export async function handleListThreads(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = listThreadsSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const agentId = getEffectiveAgentId(parsed.agentId) ?? parsed.agentId;
  const { status, limit } = parsed;

  // Get thread IDs where this agent is a participant
  const { data: participantRows, error: pError } = await threadTable(
    supabase,
    'inbox_thread_participants'
  )
    .select('thread_id')
    .eq('agent_id', agentId);

  if (pError) {
    throw new Error(`Failed to list threads: ${pError.message}`);
  }

  const threadIds = (participantRows || []).map((p: { thread_id: string }) => p.thread_id);
  if (threadIds.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ success: true, agentId, count: 0, threads: [] }),
        },
      ],
    };
  }

  // Get threads
  let query = threadTable(supabase, 'inbox_threads')
    .select('*')
    .eq('user_id', resolved.user.id)
    .in('id', threadIds)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (status !== 'all') {
    query = query.eq('status', status);
  }

  const { data: threads, error: tError } = await query;
  if (tError) {
    throw new Error(`Failed to list threads: ${tError.message}`);
  }

  // For each thread, get unread count and participant list
  const threadsWithMeta = await Promise.all(
    (threads || []).map(async (t: ThreadRow) => {
      const participants = await getParticipants(supabase, t.id);

      // Get last read timestamp for this agent
      const { data: readStatus } = await threadTable(supabase, 'inbox_thread_read_status')
        .select('last_read_at')
        .eq('thread_id', t.id)
        .eq('agent_id', agentId)
        .maybeSingle();

      // Count messages after last read
      let unreadQuery = threadTable(supabase, 'inbox_thread_messages')
        .select('*', { count: 'exact', head: true })
        .eq('thread_id', t.id);

      if (readStatus?.last_read_at) {
        unreadQuery = unreadQuery.gt('created_at', readStatus.last_read_at);
      }

      const { count: unreadCount } = await unreadQuery;

      // Get latest message preview
      const { data: latestMsg } = await threadTable(supabase, 'inbox_thread_messages')
        .select('sender_agent_id, content, created_at')
        .eq('thread_id', t.id)
        .neq('message_type', 'system')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      return {
        threadKey: t.thread_key,
        title: t.title,
        status: t.status,
        createdBy: t.created_by_agent_id,
        participants,
        unreadCount: unreadCount || 0,
        lastMessage: latestMsg
          ? {
              from: latestMsg.sender_agent_id,
              preview: latestMsg.content.slice(0, 120),
              at: latestMsg.created_at,
            }
          : null,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      };
    })
  );

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          agentId,
          count: threadsWithMeta.length,
          threads: threadsWithMeta,
        }),
      },
    ],
  };
}

export async function handleMarkThreadRead(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = markThreadReadSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const agentId = getEffectiveAgentId(parsed.agentId) ?? parsed.agentId;
  const { threadKey } = parsed;

  // Find thread
  const thread = await findThread(supabase, resolved.user.id, threadKey);
  if (!thread) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ success: false, error: `Thread not found: ${threadKey}` }),
        },
      ],
    };
  }

  // Verify participant membership
  if (!(await isParticipant(supabase, thread.id, agentId))) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: false,
            error: `Agent ${agentId} is not a participant in thread ${threadKey}`,
          }),
        },
      ],
    };
  }

  // Upsert read status
  await threadTable(supabase, 'inbox_thread_read_status').upsert(
    {
      thread_id: thread.id,
      agent_id: agentId,
      last_read_at: new Date().toISOString(),
    },
    { onConflict: 'thread_id,agent_id' }
  );

  logger.info('Thread marked as read', { threadKey, agentId });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          message: `Thread ${threadKey} marked as read`,
          threadKey,
          agentId,
        }),
      },
    ],
  };
}

// ============== Tool Registration ==============

export const threadToolDefinitions = [
  {
    name: 'get_thread_messages',
    description:
      'Get the full message timeline of a thread. Requires participant membership. Automatically marks the thread as read for the requesting agent.',
    schema: getThreadMessagesSchema,
    handler: handleGetThreadMessages,
  },
  {
    name: 'reply_to_thread',
    description:
      'Reply to a thread. Trigger behavior depends on thread size:\n- 1:1 thread: triggers the other participant by default\n- Group thread (non-creator reply): triggers creator by default\n- Group thread (creator reply): triggers no one by default\nUse triggerAgents for targeted waking, triggerAll for broadcast.',
    schema: replyToThreadSchema,
    handler: handleReplyToThread,
  },
  {
    name: 'add_thread_participant',
    description:
      'Add an agent to a thread. Idempotent (no-op if already a participant). Creates an audited system event in the thread. Triggers the new participant by default.',
    schema: addThreadParticipantSchema,
    handler: handleAddThreadParticipant,
  },
  {
    name: 'close_thread',
    description:
      'Close a thread. Closed threads can still be read but new messages are rejected. Any participant can close.',
    schema: closeThreadSchema,
    handler: handleCloseThread,
  },
  {
    name: 'list_threads',
    description:
      'List threads an agent participates in, with unread counts and last message preview. Useful for heartbeat triage and inbox overview.',
    schema: listThreadsSchema,
    handler: handleListThreads,
  },
  {
    name: 'mark_thread_read',
    description:
      'Mark a thread as read without fetching messages. Useful when you see thread activity in get_inbox and want to acknowledge it without reading the full history.',
    schema: markThreadReadSchema,
    handler: handleMarkThreadRead,
  },
];
