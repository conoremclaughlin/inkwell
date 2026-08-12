/**
 * Thread Handlers
 *
 * MCP tools for group thread messaging. Threads are first-class conversation
 * entities where messages belong to the thread, not individual recipients.
 * Late joiners see full history.
 *
 * Spec: ink://specs/cross-agent-communication v7
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { resolveUserOrThrow, userIdentifierBaseSchema } from '../../services/user-resolver';
import { getEffectiveAgentId } from '../../auth/enforce-identity';
import { logger } from '../../utils/logger';
import type { Json } from '../../data/supabase/types';
import { getAgentGateway, type AgentTriggerPayload } from '../../channels/agent-gateway.js';
import { advanceThreadReadPointer } from './read-state.js';

// The thread tables are new and not yet in generated Supabase types.
// Use type-safe wrappers that cast the table name for PostgREST queries.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = ReturnType<DataComposer['getClient']>;
const threadTable = (supabase: SupabaseClient, table: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (supabase as any).from(table);

// Cold-start guard bounds (spec inkmail-read-state §4): a delivery poll with
// a missing/stale read pointer is limited to the last 48h of unseen messages,
// with a floor of the newest 10 so quiet threads still surface context. The
// per-thread ceiling is the caller's `limit` (plugin passes 50).
const COLD_START_WINDOW_MS = 48 * 60 * 60 * 1000;
const COLD_START_MIN_MESSAGES = 10;

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
  fullHistory: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Return the full timeline regardless of read state. Without this (and without an explicit cursor), results fall back to messages newer than the last-read pointer — which hides already-delivered messages from watchers/pollers that manage their own cursor (e.g., ink wait).'
    ),
  newerThan: z
    .string()
    .datetime()
    .optional()
    .describe(
      'Explicit floor: only messages created after this timestamp. Combined with the read-state cursor (the later of the two wins).'
    ),
  latestN: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Return only the newest N of the matching messages (truncates older ones first). skippedOlderCount reports what was cut.'
    ),
  channelPoll: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Delivery-poll mode (channel plugin): activates the cold-start guard — with no explicit cursor, unseen messages are bounded to the last 48h (floor: last 10), newest-first-truncated, so a stale or missing read pointer can never replay a months-long backlog (spec: inkmail-read-state §4).'
    ),
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
  throughMessageId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Exact-id acknowledgement (spec inkmail-read-state §1): advance the read pointer through THIS message only — the last one actually delivered — instead of the whole thread. Used by delivery consumers (channel plugin) to ack after successful injection.'
    ),
});

// ============== Helpers (exported for use by inbox-handlers) ==============

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
export async function findThread(
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
export async function getParticipants(
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
export async function isParticipant(
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
 * Rules:
 * 1. triggerAgents [...] → wake exactly these (filter to participants)
 * 2. triggerAll: true → wake all participants except sender
 * 3. Actionable messages (task_request, session_resume) → trigger all recipients
 * 4. Default: 1:1 → other participant; group with explicit recipients → those recipients;
 *    group non-creator → creator; group creator → all others
 *
 * Cross-studio self-messaging: when selfStudioTarget is true, the sender is NOT
 * excluded from trigger lists. This allows an agent to message themselves in a
 * different studio (e.g., wren-omega sends a review request to wren-review).
 */
export function resolveTriggeredAgents(opts: {
  senderAgentId: string;
  participants: string[];
  creatorAgentId: string;
  triggerAgents?: string[];
  triggerAll?: boolean;
  messageType?: string;
  recipients?: string[];
  selfStudioTarget?: boolean;
}): string[] {
  const {
    senderAgentId,
    participants,
    creatorAgentId,
    triggerAgents,
    triggerAll,
    messageType,
    selfStudioTarget,
  } = opts;

  // When targeting self in a different studio, don't exclude sender from triggers
  const excludeSelf = (a: string) => (selfStudioTarget ? true : a !== senderAgentId);

  // Precedence 1: explicit triggerAgents (filter to actual participants)
  if (triggerAgents && triggerAgents.length > 0) {
    const participantSet = new Set(participants);
    return triggerAgents.filter((a) => excludeSelf(a) && participantSet.has(a));
  }

  // Precedence 2: triggerAll — everyone (except sender unless selfStudioTarget)
  if (triggerAll) {
    return participants.filter(excludeSelf);
  }

  // Precedence 3: default rules by thread size
  const otherParticipants = participants.filter((a) => a !== senderAgentId);

  // Self-thread (1 participant): trigger if cross-studio OR actionable message type.
  // session_resume / task_request to self are inherently "wake me up" signals
  // (e.g., strategy triggers) and must not be silently dropped.
  if (otherParticipants.length === 0) {
    if (selfStudioTarget) return [senderAgentId];
    const selfActionable = new Set(['task_request', 'session_resume']);
    if (messageType && selfActionable.has(messageType)) return [senderAgentId];
    return [];
  }

  // 1:1 thread (2 participants): trigger the other one
  if (participants.length === 2) {
    return otherParticipants;
  }

  // Group thread: actionable message types (task_request, session_resume) always
  // trigger all recipients. The sender explicitly wants someone to act — silently
  // triggering nobody violates the contract that "all message types trigger by default."
  const actionableTypes = new Set(['task_request', 'session_resume']);
  if (messageType && actionableTypes.has(messageType)) {
    // Trigger explicit recipients if provided, otherwise all other participants
    const targets = opts.recipients?.filter(excludeSelf) ?? otherParticipants;
    return targets.filter((a) => participants.includes(a));
  }

  // Group thread: when explicit recipients are provided, use them — even if the
  // filtered result is empty (e.g., self-target without selfStudioTarget). This
  // respects the caller's intent rather than falling through to role-based defaults.
  if (opts.recipients && opts.recipients.length > 0) {
    return opts.recipients.filter((a) => excludeSelf(a) && participants.includes(a));
  }

  // No explicit recipients — fall back to role-based defaults:
  // Non-creator → trigger creator only; Creator → trigger all others
  if (senderAgentId !== creatorAgentId) {
    return [creatorAgentId];
  }
  return otherParticipants;
}

/**
 * Dispatch triggers to a list of agents.
 */
export function dispatchTriggers(
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
  const {
    threadKey,
    limit,
    beforeMessageId,
    afterMessageId,
    includeSystemEvents,
    markRead,
    newerThan,
    latestN,
    channelPoll,
  } = parsed;

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

  // Resolve explicit cursor bounds (created_at of the cursor messages)
  let beforeTs: string | null = null;
  let afterTs: string | null = null;
  if (beforeMessageId) {
    const { data: cursor } = await threadTable(supabase, 'inbox_thread_messages')
      .select('created_at')
      .eq('id', beforeMessageId)
      .single();
    beforeTs = (cursor as { created_at?: string } | null)?.created_at || null;
  }
  if (afterMessageId) {
    const { data: cursor } = await threadTable(supabase, 'inbox_thread_messages')
      .select('created_at')
      .eq('id', afterMessageId)
      .single();
    afterTs = (cursor as { created_at?: string } | null)?.created_at || null;
  }

  // Implicit read-state floor — only when no explicit cursor and not
  // fullHistory. A client whose in-memory cursor was reset must not replay
  // the full thread history; watchers (ink wait) pass fullHistory to anchor
  // on the true timeline. Baseline priority:
  //   1. last_read_at (explicit read pointer from prior reads)
  //   2. joined_at (participant join time — no replay of pre-join history)
  let readStateFloor: string | null = null;
  if (!afterMessageId && !beforeMessageId && !parsed.fullHistory) {
    const { data: readStatus } = await threadTable(supabase, 'inbox_thread_read_status')
      .select('last_read_at')
      .eq('thread_id', thread.id)
      .eq('agent_id', agentId)
      .maybeSingle();
    readStateFloor = (readStatus as { last_read_at?: string } | null)?.last_read_at || null;

    if (!readStateFloor) {
      const { data: participant } = await threadTable(supabase, 'inbox_thread_participants')
        .select('joined_at')
        .eq('thread_id', thread.id)
        .eq('agent_id', agentId)
        .maybeSingle();
      readStateFloor = (participant as { joined_at?: string } | null)?.joined_at || null;
    }
  }

  // Effective floor: the latest of read-state floor / after-cursor / newerThan.
  let floorTs: string | null = readStateFloor;
  if (afterTs && (!floorTs || afterTs > floorTs)) floorTs = afterTs;
  if (newerThan && (!floorTs || newerThan > floorTs)) floorTs = newerThan;

  const buildQuery = (selectArg: string, head = false) => {
    let q = threadTable(supabase, 'inbox_thread_messages')
      .select(selectArg, head ? { count: 'exact', head: true } : undefined)
      .eq('thread_id', thread.id);
    if (!includeSystemEvents) q = q.neq('message_type', 'system');
    if (floorTs) q = q.gt('created_at', floorTs);
    if (beforeTs) q = q.lt('created_at', beforeTs);
    return q;
  };

  // Cold-start guard (spec inkmail-read-state §4): a delivery poll with no
  // explicit cursor must never replay a stale backlog — a missing or
  // months-old read pointer bounds to the last 48h (floor: newest 10),
  // truncated NEWEST-first. Explicit cursors and fullHistory bypass: those
  // callers asked for a specific window.
  const guardActive = channelPoll && !afterMessageId && !beforeMessageId && !parsed.fullHistory;
  const newestFirst = guardActive || Boolean(latestN);
  const effectiveLimit = Math.min(limit, latestN ?? limit);

  let messages: Record<string, unknown>[] | null = null;
  let skippedOlderCount = 0;

  if (!newestFirst) {
    const { data, error } = await buildQuery('*')
      .order('created_at', { ascending: true })
      .limit(effectiveLimit);
    if (error) {
      throw new Error(`Failed to get thread messages: ${error.message}`);
    }
    messages = data;
  } else {
    // Count everything past the floor so truncation is visible, not silent.
    const { count: totalMatching, error: countErr } = await buildQuery('id', true);
    if (countErr) {
      throw new Error(`Failed to count thread messages: ${countErr.message}`);
    }

    let windowed = buildQuery('*');
    if (guardActive) {
      const guardFloor = new Date(Date.now() - COLD_START_WINDOW_MS).toISOString();
      // Repeated created_at filters AND together — the later floor wins.
      if (!floorTs || guardFloor > floorTs) {
        windowed = windowed.gt('created_at', guardFloor);
      }
    }
    const { data: newest, error } = await windowed
      .order('created_at', { ascending: false })
      .limit(effectiveLimit);
    if (error) {
      throw new Error(`Failed to get thread messages: ${error.message}`);
    }
    let delivered = (newest || []) as Record<string, unknown>[];

    // Myra floor: if the 48h window under-delivers relative to what's unseen,
    // deliver the newest 10 unseen regardless of age — quiet threads still
    // surface recent context on a cold start.
    const floorCount = Math.min(COLD_START_MIN_MESSAGES, effectiveLimit);
    if (guardActive && delivered.length < floorCount && (totalMatching ?? 0) > delivered.length) {
      const { data: fallback, error: fallbackErr } = await buildQuery('*')
        .order('created_at', { ascending: false })
        .limit(floorCount);
      if (fallbackErr) {
        throw new Error(`Failed to get thread messages: ${fallbackErr.message}`);
      }
      delivered = (fallback || delivered) as Record<string, unknown>[];
    }

    skippedOlderCount = Math.max(0, (totalMatching ?? delivered.length) - delivered.length);
    // Response stays oldest-first regardless of how the window was cut.
    messages = delivered.reverse();
  }

  // Get participants
  const participants = await getParticipants(supabase, thread.id);

  // Pointer advance semantics (Lumen, PR #473):
  // - GUARD MODE (cold-start delivery poll): fetched-but-not-yet-rendered
  //   messages must remain unread — the delivery consumer acks after
  //   injection via mark_thread_read(throughMessageId). Only the range the
  //   guard DELIBERATELY skipped is durably consumed here, by advancing
  //   through the newest skipped message (the cutoff below the delivered
  //   window) — never through the returned batch.
  // - Non-guard paths keep the pre-existing fetch-time advance through the
  //   returned batch (the global fetch≠delivered fix is the ack-protocol
  //   step, tracked separately).
  if (markRead && messages && messages.length > 0) {
    if (guardActive) {
      if (skippedOlderCount > 0) {
        const oldestDelivered = messages[0] as { created_at?: string };
        if (oldestDelivered?.created_at) {
          const { data: newestSkipped } = await buildQuery('id, created_at')
            .lt('created_at', oldestDelivered.created_at)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (newestSkipped?.id) {
            await advanceThreadReadPointer(supabase, {
              threadId: thread.id,
              agentId,
              throughMessageId: newestSkipped.id,
              source: 'get_thread_messages:deliberate_skip',
            });
          }
        }
      }
    } else {
      let maxCreatedAt = '';
      let maxMessageId = '';
      for (const m of messages as Array<{ id?: string; created_at?: string }>) {
        const ts = m.created_at;
        if (ts && m.id && ts > maxCreatedAt) {
          maxCreatedAt = ts;
          maxMessageId = m.id;
        }
      }
      if (maxMessageId) {
        await advanceThreadReadPointer(supabase, {
          threadId: thread.id,
          agentId,
          throughMessageId: maxMessageId,
          source: 'get_thread_messages:markRead',
        });
      }
    }
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
          // Truncation is visible, never silent: how many older matching
          // messages were cut by the cold-start guard or latestN window.
          ...(skippedOlderCount > 0 ? { skippedOlderCount } : {}),
          ...(guardActive ? { coldStartGuard: true } : {}),
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

  // Exact-id acknowledgement (spec §1): a delivery consumer acks the LAST
  // message it actually injected — the pointer advances exactly through it,
  // never past messages that were fetched but not yet rendered.
  if (parsed.throughMessageId) {
    const { data: ackMsg, error: ackErr } = await threadTable(supabase, 'inbox_thread_messages')
      .select('id')
      .eq('id', parsed.throughMessageId)
      .eq('thread_id', thread.id)
      .maybeSingle();
    if (ackErr) {
      throw new Error(`Failed to validate ack message for ${threadKey}: ${ackErr.message}`);
    }
    if (!ackMsg?.id) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Message ${parsed.throughMessageId} not found in thread ${threadKey}`,
            }),
          },
        ],
      };
    }
    const advanced = await advanceThreadReadPointer(supabase, {
      threadId: thread.id,
      agentId,
      throughMessageId: ackMsg.id,
      source: 'mark_thread_read:ack',
    });
    if (!advanced) {
      throw new Error(`Failed to persist read state for thread ${threadKey}`);
    }
    logger.info('Thread read acknowledged through message', {
      threadKey,
      agentId,
      throughMessageId: ackMsg.id,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: `Thread ${threadKey} acknowledged through ${ackMsg.id}`,
            threadKey,
            agentId,
            throughMessageId: ackMsg.id,
          }),
        },
      ],
    };
  }

  // "Mark whole thread read" = advance through the thread's current max
  // message, never wall-clock NOW() — a concurrently inserted, never-seen
  // message must not be marked read. Empty thread → nothing to advance.
  // This API's purpose IS the durable write: a lookup or advance failure must
  // surface as failure, never as a positive acknowledgement.
  const { data: latestMsg, error: latestErr } = await threadTable(supabase, 'inbox_thread_messages')
    .select('id')
    .eq('thread_id', thread.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestErr) {
    throw new Error(`Failed to resolve latest message for ${threadKey}: ${latestErr.message}`);
  }
  if (latestMsg?.id) {
    const advanced = await advanceThreadReadPointer(supabase, {
      threadId: thread.id,
      agentId,
      throughMessageId: latestMsg.id,
      source: 'mark_thread_read',
    });
    if (!advanced) {
      throw new Error(`Failed to persist read state for thread ${threadKey}`);
    }
  }

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
      'Get the message timeline of a thread. Requires participant membership. By default returns messages newer than your last-read pointer and advances it (markRead); pass fullHistory: true for the complete timeline regardless of read state, or an explicit before/afterMessageId cursor.',
    schema: getThreadMessagesSchema,
    handler: handleGetThreadMessages,
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
