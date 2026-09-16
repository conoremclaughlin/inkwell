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
import { isoDateTime } from './schema-primitives.js';
import type { DataComposer } from '../../data/composer';
import { resolveUserOrThrow, userIdentifierBaseSchema } from '../../services/user-resolver';
import { getEffectiveSlug } from '../../auth/enforce-identity';
import { resolveSbId } from '../../auth/resolve-identity';
import { senderRoutingContext, isBridgeIdentity, senderSbId } from './sender-context.js';
import { logger } from '../../utils/logger';
import type { Json } from '../../data/supabase/types';
import { getAgentGateway, type AgentTriggerPayload } from '../../channels/agent-gateway.js';
import { advanceThreadReadPointer } from './read-state.js';
import { THREAD_TITLE_MAX, THREAD_SUMMARY_MAX } from './thread-bounds.js';
import { StudioLeaseService } from '../../services/studio-lease.service.js';
import { StudioOverflowService } from '../../services/studio-overflow.service.js';

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

/**
 * Is `candidate` a later INSTANT than `current`?
 *
 * These floors used to be compared as strings, which worked only because every
 * timestamp reaching them was UTC — `Z` from `toISOString()`, `+00:00` from
 * Postgres — so lexical order of the date-time prefix happened to match
 * chronological order. That is an accident of spelling, and it stops holding
 * the moment a caller may send an offset (PR #554, which widened the schemas to
 * accept the ISO 8601 they always advertised).
 *
 * Concretely: with a read floor of `2026-09-01T12:00:00Z`, a `newerThan` of
 * `2026-09-01T23:00:00+14:00` is 09:00Z — three hours EARLIER — but sorts
 * later as text, wins the floor, and lowers it. Already-read messages replay.
 *
 * An unparseable value never wins; it cannot be shown to be later, so the
 * existing floor stands. That is the safe direction here: a floor that is too
 * high under-delivers and is visible, while a floor that is too low silently
 * replays what the caller already saw.
 */
export function isLaterInstant(candidate: string | null, current: string | null): boolean {
  if (!candidate) return false;
  if (!current) return true;
  const a = Date.parse(candidate);
  const b = Date.parse(current);
  if (Number.isNaN(a)) return false;
  if (Number.isNaN(b)) return true;
  return a > b;
}

/**
 * The effective read floor: the latest of the read-state pointer, the
 * after-cursor, and an explicit `newerThan`.
 *
 * Extracted so the comparison can be tested without a database. The bug it
 * replaced was one character of operator — `>` on two strings — in a line that
 * read correctly right up until the input format widened underneath it.
 */
export function resolveEffectiveFloor(params: {
  readStateFloor: string | null;
  afterTs: string | null;
  newerThan?: string | null;
}): string | null {
  let floor = params.readStateFloor;
  if (isLaterInstant(params.afterTs, floor)) floor = params.afterTs;
  if (isLaterInstant(params.newerThan ?? null, floor)) floor = params.newerThan ?? null;
  return floor;
}
const COLD_START_MIN_MESSAGES = 10;

// ============== Schemas ==============

const threadKeySchema = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*:[^\s]+$/, 'threadKey must look like "type:identifier"');

const sbSlugSchema = z.string().min(1).max(64);

const getThreadMessagesSchema = userIdentifierBaseSchema.extend({
  threadKey: threadKeySchema,
  sbSlug: z.string().describe('SB slug requesting access (must be a participant)'),
  limit: z.number().int().min(1).max(200).optional().default(50),
  beforeMessageId: z.string().guid().optional().describe('Cursor: get messages before this ID'),
  afterMessageId: z.string().guid().optional().describe('Cursor: get messages after this ID'),
  includeSystemEvents: z.boolean().optional().default(true),
  markRead: z.boolean().optional().default(true),
  fullHistory: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Return the full timeline regardless of read state. Without this (and without an explicit cursor), results fall back to messages newer than the last-read pointer — which hides already-delivered messages from watchers/pollers that manage their own cursor (e.g., ink wait).'
    ),
  newerThan: isoDateTime()
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
  sbSlug: sbSlugSchema.describe('SB slug to add to the thread'),
  addedBySlug: sbSlugSchema.optional(),
  reason: z.string().max(500).optional(),
  triggerNewParticipant: z.boolean().optional().default(true),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const closeThreadSchema = userIdentifierBaseSchema.extend({
  threadKey: threadKeySchema,
  sbSlug: sbSlugSchema.describe('SB slug closing the thread (must be a participant)'),
});

const reopenThreadSchema = userIdentifierBaseSchema.extend({
  threadKey: threadKeySchema,
  sbSlug: sbSlugSchema.describe('SB slug reopening the thread (must be a participant)'),
});

// Bounds live in thread-bounds.ts so findOrCreateThread can reach them without
// importing this module. Re-exported because callers already import them here.
export { THREAD_TITLE_MAX, THREAD_SUMMARY_MAX };

const updateThreadSchema = userIdentifierBaseSchema
  .extend({
    threadKey: threadKeySchema,
    sbSlug: sbSlugSchema.describe('SB slug making the change (must be a participant)'),
    title: z
      .string()
      .max(THREAD_TITLE_MAX)
      .nullable()
      .optional()
      .describe(
        `Short label for the thread, max ${THREAD_TITLE_MAX} chars. The threadKey identifies the thread; this describes it. Pass null to clear.`
      ),
    summary: z
      .string()
      .max(THREAD_SUMMARY_MAX)
      .nullable()
      .optional()
      .describe(
        `Brief, concise description of what the thread is about NOW, max ${THREAD_SUMMARY_MAX} chars. Rewrite it as the discussion moves on. Pass null to clear.`
      ),
  })
  // Distinguishing "not provided" from "explicitly cleared" is the whole point
  // of allowing null, so a call that provides neither is a caller error rather
  // than a silent no-op that reports success.
  .refine((v) => v.title !== undefined || v.summary !== undefined, {
    message: 'Provide at least one of title or summary',
  });

const listThreadsSchema = userIdentifierBaseSchema.extend({
  sbSlug: sbSlugSchema.describe('SB slug to list threads for'),
  status: z.enum(['open', 'closed', 'all']).optional().default('open'),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

const markThreadReadSchema = userIdentifierBaseSchema.extend({
  threadKey: threadKeySchema,
  sbSlug: sbSlugSchema.describe('SB slug marking the thread as read'),
  throughMessageId: z
    .string()
    .guid()
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
  summary: string | null;
  /**
   * NULL means the field still holds its creation-time value. That is the
   * signal a reader needs: it distinguishes a description someone has kept
   * current from one that has never been touched since the thread opened.
   */
  title_updated_at: string | null;
  title_updated_by_sb_id: string | null;
  summary_updated_at: string | null;
  summary_updated_by_sb_id: string | null;
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
 * Get all participant SB slugs for a thread.
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
  sbSlug: string
): Promise<boolean> {
  const { data } = await threadTable(supabase, 'inbox_thread_participants')
    .select('agent_id')
    .eq('thread_id', threadId)
    .eq('agent_id', sbSlug)
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
  senderSlug: string;
  participants: string[];
  creatorSlug: string;
  triggerAgents?: string[];
  triggerAll?: boolean;
  messageType?: string;
  recipients?: string[];
  selfStudioTarget?: boolean;
}): string[] {
  const {
    senderSlug,
    participants,
    creatorSlug,
    triggerAgents,
    triggerAll,
    messageType,
    selfStudioTarget,
  } = opts;

  // When targeting self in a different studio, don't exclude sender from triggers
  const excludeSelf = (a: string) => (selfStudioTarget ? true : a !== senderSlug);

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
  const otherParticipants = participants.filter((a) => a !== senderSlug);

  // Self-thread (1 participant): trigger if cross-studio OR actionable message type.
  // session_resume / task_request to self are inherently "wake me up" signals
  // (e.g., strategy triggers) and must not be silently dropped.
  if (otherParticipants.length === 0) {
    if (selfStudioTarget) return [senderSlug];
    const selfActionable = new Set(['task_request', 'session_resume']);
    if (messageType && selfActionable.has(messageType)) return [senderSlug];
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
  if (senderSlug !== creatorSlug) {
    return [creatorSlug];
  }
  return otherParticipants;
}

/**
 * Dispatch triggers to a list of agents.
 */
export function dispatchTriggers(
  agentsToTrigger: string[],
  opts: {
    fromSlug: string;
    threadKey: string;
    summary: string;
    priority: string;
    threadMessageId?: string;
    threadId?: string;
    /** Sender is a relay — excluded from caller-repo inference. */
    senderIsBridge?: boolean;
  }
): void {
  if (agentsToTrigger.length === 0) return;

  const gateway = getAgentGateway();
  for (const toSlug of agentsToTrigger) {
    const payload: AgentTriggerPayload = {
      fromSlug: opts.fromSlug,
      toSlug,
      threadMessageId: opts.threadMessageId,
      threadId: opts.threadId,
      triggerType: 'message',
      summary: opts.summary,
      priority: opts.priority as AgentTriggerPayload['priority'],
      threadKey: opts.threadKey,
      // Without this the recipient loses caller-repo inference entirely and
      // every thread dispatched here lands on refuse-and-hold.
      ...senderRoutingContext(opts.senderIsBridge),
    };
    gateway.dispatchTrigger(payload);
  }
}

// ============== Handlers ==============

export async function handleGetThreadMessages(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = getThreadMessagesSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const sbSlug = getEffectiveSlug(parsed.sbSlug) ?? parsed.sbSlug;
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
  if (!(await isParticipant(supabase, thread.id, sbSlug))) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: false,
            error: `Agent ${sbSlug} is not a participant in thread ${threadKey}`,
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
      .eq('agent_id', sbSlug)
      .maybeSingle();
    readStateFloor = (readStatus as { last_read_at?: string } | null)?.last_read_at || null;

    if (!readStateFloor) {
      const { data: participant } = await threadTable(supabase, 'inbox_thread_participants')
        .select('joined_at')
        .eq('thread_id', thread.id)
        .eq('agent_id', sbSlug)
        .maybeSingle();
      readStateFloor = (participant as { joined_at?: string } | null)?.joined_at || null;
    }
  }

  // Effective floor: the latest of read-state floor / after-cursor / newerThan.
  const floorTs = resolveEffectiveFloor({ readStateFloor, afterTs, newerThan });

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
      // By instant, not by spelling: see isLaterInstant.
      if (isLaterInstant(guardFloor, floorTs)) {
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
  let advanceFailed = false;
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
            const advanced = await advanceThreadReadPointer(supabase, {
              threadId: thread.id,
              sbSlug,
              throughMessageId: newestSkipped.id,
              source: 'get_thread_messages:deliberate_skip',
            });
            if (!advanced) {
              // Checked write (spec §5): a failed skip-consume must be
              // visible — the range will re-offer next cold fetch.
              advanceFailed = true;
              logger.error('[GetThreadMessages] deliberate_skip advance failed', {
                threadKey,
                sbSlug,
                throughMessageId: newestSkipped.id,
              });
            }
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
        const advanced = await advanceThreadReadPointer(supabase, {
          threadId: thread.id,
          sbSlug,
          throughMessageId: maxMessageId,
          source: 'get_thread_messages:markRead',
        });
        if (!advanced) {
          advanceFailed = true;
          logger.error('[GetThreadMessages] markRead advance failed', {
            threadKey,
            sbSlug,
            throughMessageId: maxMessageId,
          });
        }
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
          summary: thread.summary ?? null,
          titleUpdatedAt: thread.title_updated_at ?? null,
          summaryUpdatedAt: thread.summary_updated_at ?? null,
          status: thread.status,
          createdBy: thread.created_by_agent_id,
          participants,
          messageCount: messages?.length || 0,
          // Truncation is visible, never silent: how many older matching
          // messages were cut by the cold-start guard or latestN window.
          ...(skippedOlderCount > 0 ? { skippedOlderCount } : {}),
          ...(guardActive ? { coldStartGuard: true } : {}),
          // Checked write surfaced to the caller (spec §5): messages were
          // returned, but the read-pointer advance did NOT persist — read
          // state is stale and messages may re-deliver.
          ...(advanceFailed
            ? {
                advanceFailed: true,
                warning:
                  'read-pointer advance failed — read state is stale; messages may re-deliver',
              }
            : {}),
          messages: (messages || []).map((m: Record<string, unknown>) => ({
            id: m.id,
            senderSlug: m.sender_agent_id,
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

  const { threadKey, sbSlug, reason, triggerNewParticipant, metadata } = parsed;
  const addedBySlug = getEffectiveSlug(parsed.addedBySlug) ?? parsed.addedBySlug;

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
  if (await isParticipant(supabase, thread.id, sbSlug)) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: `${sbSlug} is already a participant in thread ${threadKey}`,
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
    agent_id: sbSlug,
  });

  if (addError) {
    throw new Error(`Failed to add participant: ${addError.message}`);
  }

  // Add system message for audit trail
  const systemContent = addedBySlug
    ? `${sbSlug} was added to the thread by ${addedBySlug}${reason ? `: ${reason}` : ''}`
    : `${sbSlug} joined the thread${reason ? `: ${reason}` : ''}`;

  await threadTable(supabase, 'inbox_thread_messages').insert({
    thread_id: thread.id,
    sender_agent_id: 'system',
    content: systemContent,
    message_type: 'system',
    metadata: {
      type: 'participant_added',
      sbSlug,
      addedBy: addedBySlug || null,
      reason: reason || null,
      ...(metadata || {}),
    } as Json,
  });

  logger.info('Thread participant added', { threadKey, sbSlug, addedBy: addedBySlug });

  // Trigger the new participant
  if (triggerNewParticipant) {
    dispatchTriggers([sbSlug], {
      fromSlug: addedBySlug || 'system',
      // Without this the option added in round 1 was never passed by ANY
      // caller here, so bridge exclusion stayed dead on this path
      // (Lumen, PR #514 round 2).
      senderIsBridge: await isBridgeIdentity(
        supabase,
        resolved.user.id,
        addedBySlug || null,
        senderSbId()
      ),
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
          message: `${sbSlug} added to thread ${threadKey}`,
          threadKey,
          sbSlug,
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

  const sbSlug = getEffectiveSlug(parsed.sbSlug) ?? parsed.sbSlug;
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
  if (!(await isParticipant(supabase, thread.id, sbSlug))) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: false,
            error: `Agent ${sbSlug} is not a participant in thread ${threadKey}`,
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
      closed_by_agent_id: sbSlug,
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
    content: `Thread closed by ${sbSlug}`,
    message_type: 'system',
    metadata: { type: 'thread_closed', closedBy: sbSlug } as Json,
  });

  // Automatic lease release — the work unit completing is what lets studios
  // go. A holder whose process is still live (close_thread is commonly called
  // from inside the holder's own turn) is DEFERRED via pendingRelease, and
  // the run/stop boundary or sweep completes it — never cleared out from
  // under a running process. Ephemeral teardown is claim-fenced per studio
  // and skips anything still held.
  try {
    const leases = new StudioLeaseService(supabase);
    const { released, deferred, removed, studioIds } = await leases.releaseByThread(
      resolved.user.id,
      threadKey,
      {
        reason: 'thread-closed',
      }
    );
    const overflow = new StudioOverflowService(dataComposer.repositories.studios, leases);
    const cleaned = await overflow.teardownEphemeralStudiosForThread(resolved.user.id, threadKey, {
      reason: `thread ${threadKey} closed`,
      // The studios this thread's lease actually rode — created-for discovery
      // alone misses an ephemeral whose final surviving thread was not the
      // one it was built for (v18 S2).
      candidateStudioIds: studioIds,
    });
    if (released || deferred || removed || cleaned) {
      logger.info('[StudioLease] Thread close released studios', {
        threadKey,
        leasesReleased: released,
        leasesDeferred: deferred,
        threadKeysRemoved: removed,
        ephemeralCleaned: cleaned,
      });
    }
  } catch (leaseErr) {
    logger.warn('[StudioLease] Release on thread close failed (non-fatal)', {
      threadKey,
      error: leaseErr instanceof Error ? leaseErr.message : String(leaseErr),
    });
  }

  logger.info('Thread closed', { threadKey, closedBy: sbSlug });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          message: `Thread ${threadKey} closed`,
          threadKey,
          closedBy: sbSlug,
        }),
      },
    ],
  };
}

/** Who is reopening: a participant SB, or the owner recovering from the dashboard. */
export type ReopenActor = { kind: 'sb'; sbSlug: string } | { kind: 'user' };

/**
 * Flip a closed thread back to open and record it — in ONE transaction, the
 * `reopen_inbox_thread` SQL function (migration 20260913083000). The UPDATE is
 * guarded on the row still being closed, so two reopens racing each other (or
 * a reopen racing a close) cannot both claim to have done it; the audit event
 * is written in the same transaction, so a rejected event means the row did
 * not flip either, and a retry does the whole thing. (Lumen, #615 review:
 * as two PostgREST round trips, a failed audit INSERT left the thread open
 * with no event, and the retry saw "already open" and skipped it for good.)
 *
 * Answers `reopened: false` when the row was not closed at the moment of the
 * write — nothing is written in that case.
 *
 * What a reopen does NOT do (spec inkmail-thread-scope §2, §6):
 * - wake anyone — a reopen says the work is back on; waking someone is an
 *   explicit message, and a reply is how the participants hear;
 * - take back a studio lease — close released them (handleCloseThread), and
 *   the next message on the thread claims what it needs as usual.
 *
 * Shared by the MCP tool (a participant reopens) and the admin route (the
 * owner recovers), so both write the same row and the same event. The actor
 * lands in the audit event's metadata for now; the principal columns of
 * spec §3 give it a real home at the cutover.
 */
export async function reopenThreadRow(
  supabase: SupabaseClient,
  threadId: string,
  actor: ReopenActor
): Promise<{ reopened: boolean }> {
  const { data, error } = await supabase.rpc('reopen_inbox_thread', {
    p_thread_id: threadId,
    p_actor_kind: actor.kind,
    p_actor_agent_id: actor.kind === 'sb' ? actor.sbSlug : null,
  });
  if (error) {
    throw new Error(`Failed to reopen thread: ${error.message}`);
  }
  if (typeof data !== 'boolean') {
    // The function returns exactly a boolean; anything else means the call
    // did not reach it (a missing migration, a mocked client).
    throw new Error(`Failed to reopen thread: unexpected reply ${JSON.stringify(data)}`);
  }
  return { reopened: data };
}

/**
 * reopen_thread — the explicit counterpart of close_thread.
 *
 * A reply to a closed thread never reopens it; this tool is how a participant
 * says the work is back on. Same authority rule as close (any participant),
 * and the same shape of audit trail.
 */
export async function handleReopenThread(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = reopenThreadSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const sbSlug = getEffectiveSlug(parsed.sbSlug) ?? parsed.sbSlug;
  const { threadKey } = parsed;
  const reply = (payload: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  });

  const thread = await findThread(supabase, resolved.user.id, threadKey);
  if (!thread) {
    return reply({ success: false, error: `Thread not found: ${threadKey}` });
  }

  // Who is asking comes before what state the thread is in.
  if (!(await isParticipant(supabase, thread.id, sbSlug))) {
    return reply({
      success: false,
      error: `Agent ${sbSlug} is not a participant in thread ${threadKey}`,
    });
  }

  if (thread.status !== 'closed') {
    return reply({
      success: true,
      message: `Thread ${threadKey} is already open`,
      threadKey,
      alreadyOpen: true,
    });
  }

  const { reopened } = await reopenThreadRow(supabase, thread.id, { kind: 'sb', sbSlug });
  if (!reopened) {
    // Closed when we looked, open by the time we wrote: someone else's
    // reopen landed first. The state the caller asked for holds, and
    // nothing was recorded twice.
    return reply({
      success: true,
      message: `Thread ${threadKey} is already open`,
      threadKey,
      alreadyOpen: true,
    });
  }

  logger.info('Thread reopened', { threadKey, reopenedBy: sbSlug });

  return reply({
    success: true,
    message: `Thread ${threadKey} reopened`,
    threadKey,
    reopenedBy: sbSlug,
  });
}

/** What one update_thread call writes: the fields it touches, and who by. */
export interface ThreadMetadataEdit {
  setTitle: boolean;
  title: string | null;
  setSummary: boolean;
  summary: string | null;
  editorSbId: string | null;
  editorSlug: string;
  attributedBy: 'identity' | 'slug-only';
}

/**
 * Write a title/summary edit AND its timeline event — in ONE transaction, the
 * `update_inbox_thread_metadata` SQL function (migration 20260916020035).
 *
 * The same two-round-trip shape Lumen caught on reopen in #615, and caught
 * again here in #641: as an UPDATE followed by an INSERT these are two
 * transactions, so a rejected audit INSERT left the edit standing with nothing
 * in the timeline recording who made it. The first cut also discarded the
 * INSERT's error, which turned that into `success: true` — and in the
 * `slug-only` attribution case the timeline message is the only durable record
 * of the editor, so the response claimed a trail it had just failed to write.
 *
 * Throwing after the fact would have detected the failure without restoring the
 * trail. One function restores it: either both land or neither does.
 *
 * Returns the timestamp the row was written with, so the response reports the
 * stored instant rather than an app-side guess at it.
 */
export async function updateThreadMetadataRow(
  supabase: SupabaseClient,
  threadId: string,
  edit: ThreadMetadataEdit
): Promise<string> {
  const { data, error } = await supabase.rpc('update_inbox_thread_metadata', {
    p_thread_id: threadId,
    p_set_title: edit.setTitle,
    p_title: edit.title,
    p_set_summary: edit.setSummary,
    p_summary: edit.summary,
    p_editor_sb_id: edit.editorSbId,
    p_editor_slug: edit.editorSlug,
    p_attributed_by: edit.attributedBy,
  });
  if (error) {
    throw new Error(`Failed to update thread: ${error.message}`);
  }
  if (typeof data !== 'string' || !data) {
    // The function returns exactly a timestamptz; anything else means the call
    // did not reach it (a missing migration, a mocked client).
    throw new Error(`Failed to update thread: unexpected reply ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Set or update a thread's title and summary.
 *
 * The threadKey is a stable identifier by design, and that stability is what
 * makes it useless as a description: one thread routinely spans several PRs,
 * specs and incidents. So the descriptive layer is mutable precisely because
 * the key is not.
 *
 * Any participant may edit. A thread is collaborative — restricting edits to
 * the creator would mean a thread Myra opened can never be retitled by the SB
 * actually doing the work, which is the common case.
 *
 * Each field carries its own editor and timestamp. The timestamp is the load
 * bearing part: a summary without one is read as current no matter how old it
 * is, which is the failure this feature exists to fix rather than reproduce.
 */
export async function handleUpdateThread(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = updateThreadSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const sbSlug = getEffectiveSlug(parsed.sbSlug) ?? parsed.sbSlug;
  const { threadKey, title, summary } = parsed;

  const reply = (payload: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  });

  const thread = await findThread(supabase, resolved.user.id, threadKey);
  if (!thread) {
    return reply({ success: false, error: `Thread not found: ${threadKey}` });
  }

  // Closed threads stay editable. Closed is a work-state signal, not a lock
  // (spec inkmail-thread-scope §2), and a finished thread is exactly the one
  // whose summary is most worth correcting for whoever reads it later.
  if (!(await isParticipant(supabase, thread.id, sbSlug))) {
    return reply({
      success: false,
      error: `Agent ${sbSlug} is not a participant in thread ${threadKey}`,
    });
  }

  // Attribution by canonical UUID. Prefer the server-side request context over
  // anything derived from the slug: a slug is unique only per workspace, so
  // re-deriving it can name a different SB of the same name — and that is not
  // hypothetical here, the fixture user carries two `echo` identities, one of
  // them workspace-less, which makes the slug lookup correctly return nothing.
  //
  // A provenance field is not an authorization field, so this does NOT fail
  // closed the way resolveOwnerSbId does: refusing a title edit because of a
  // duplicate identity row elsewhere would cost the description and buy no
  // safety. Instead the edit lands and the response says which it got, so a
  // caller can tell "attributed to an identity" from "attributed to a slug
  // only" rather than reading null as either.
  const editorSbId =
    senderSbId() ?? (await resolveSbId(supabase, resolved.user.id, sbSlug)) ?? null;
  const attributedBy = editorSbId ? 'identity' : 'slug-only';

  // `undefined` means "not provided" and `null` means "explicitly cleared" —
  // never collapse them, or a caller editing only the summary silently wipes
  // the title. The two are carried to SQL as a set-flag and a value for the
  // same reason.
  const changed: string[] = [];
  if (title !== undefined) changed.push('title');
  if (summary !== undefined) changed.push('summary');

  // The edit and its timeline event, in one transaction. See
  // updateThreadMetadataRow: a failed audit must not leave an edit standing.
  const now = await updateThreadMetadataRow(supabase, thread.id, {
    setTitle: title !== undefined,
    title: title ?? null,
    setSummary: summary !== undefined,
    summary: summary ?? null,
    editorSbId,
    editorSlug: sbSlug,
    attributedBy,
  });

  logger.info('[Thread] Title/summary updated', {
    threadKey,
    sbSlug,
    fields: changed,
    attributedBy,
  });

  return reply({
    success: true,
    message: `Thread ${threadKey} ${changed.join(' and ')} updated`,
    threadKey,
    updatedBy: sbSlug,
    // 'identity' = a canonical UUID was recorded. 'slug-only' = the slug could
    // not be resolved to one identity, so the column is null and the timeline
    // message carries the slug. Stated rather than left to be inferred from a
    // null column, which cannot distinguish "unresolvable" from "never tried".
    attributedBy,
    updatedFields: changed,
    ...(title !== undefined ? { title } : {}),
    ...(summary !== undefined ? { summary } : {}),
    updatedAt: now,
  });
}

export async function handleListThreads(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = listThreadsSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const sbSlug = getEffectiveSlug(parsed.sbSlug) ?? parsed.sbSlug;
  const { status, limit } = parsed;

  // Get thread IDs where this agent is a participant
  const { data: participantRows, error: pError } = await threadTable(
    supabase,
    'inbox_thread_participants'
  )
    .select('thread_id')
    .eq('agent_id', sbSlug);

  if (pError) {
    throw new Error(`Failed to list threads: ${pError.message}`);
  }

  const threadIds = (participantRows || []).map((p: { thread_id: string }) => p.thread_id);
  if (threadIds.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ success: true, sbSlug, count: 0, threads: [] }),
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
        .eq('agent_id', sbSlug)
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
        summary: t.summary ?? null,
        // Ages travel with the text. A summary shown without one is read as
        // current however old it is — the exact misread this feature exists to
        // prevent, so omitting these would reproduce it on a new surface.
        titleUpdatedAt: t.title_updated_at ?? null,
        summaryUpdatedAt: t.summary_updated_at ?? null,
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
          sbSlug,
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

  const sbSlug = getEffectiveSlug(parsed.sbSlug) ?? parsed.sbSlug;
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
  if (!(await isParticipant(supabase, thread.id, sbSlug))) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: false,
            error: `Agent ${sbSlug} is not a participant in thread ${threadKey}`,
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
      sbSlug,
      throughMessageId: ackMsg.id,
      source: 'mark_thread_read:ack',
    });
    if (!advanced) {
      throw new Error(`Failed to persist read state for thread ${threadKey}`);
    }
    logger.info('Thread read acknowledged through message', {
      threadKey,
      sbSlug,
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
            sbSlug,
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
      sbSlug,
      throughMessageId: latestMsg.id,
      source: 'mark_thread_read',
    });
    if (!advanced) {
      throw new Error(`Failed to persist read state for thread ${threadKey}`);
    }
  }

  logger.info('Thread marked as read', { threadKey, sbSlug });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          message: `Thread ${threadKey} marked as read`,
          threadKey,
          sbSlug,
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
      'Close a thread to mark its work done. Closed is a work-state signal, not a lock: a closed thread can still be read and still accepts replies (a reply wakes its participants without reopening the thread); it drops off the default list_threads work list. Any participant can close; reopen_thread puts the work back on.',
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
  {
    name: 'reopen_thread',
    description:
      'Reopen a closed thread to say its work is back on. Explicit by design: a reply to a closed thread never reopens it. Atomic — status returns to open and the closure fields clear together — and audited with a system event. Wakes nobody: send a message to wake the participants. Any participant can reopen.',
    schema: reopenThreadSchema,
    handler: handleReopenThread,
  },
  {
    name: 'update_thread',
    description:
      "Set or update a thread's title and brief summary, so it is clear what the thread is actually about now. The threadKey is a stable identifier, not a description — one thread routinely covers several PRs, specs and incidents, and 'pr:632' says none of it. Keep the summary BRIEF AND CONCISE (bounded at 280 chars) and rewrite it as the discussion moves on; a summary that grows without bound is the thing this replaces. Any participant may edit, including on a closed thread. Each field records who changed it and when, and the age is shown wherever the summary is, so a reader can tell a current description from an old one.",
    schema: updateThreadSchema,
    handler: handleUpdateThread,
  },
];

/**
 * Look up a thread tool definition by name.
 *
 * Registration used to index this array positionally (`threadToolDefinitions[3]`),
 * which silently rebinds every later tool to the wrong schema the moment
 * anything is inserted rather than appended — a trap that fired immediately
 * when `update_thread` was first added in the middle. Names do not shift.
 */
export function threadTool(name: string): (typeof threadToolDefinitions)[number] {
  const found = threadToolDefinitions.find((t) => t.name === name);
  if (!found) {
    // Throwing beats returning undefined: a missing tool is a programming error
    // at startup, and a silently unregistered tool is invisible until a caller
    // needs it.
    throw new Error(`Unknown thread tool: ${name}`);
  }
  return found;
}
