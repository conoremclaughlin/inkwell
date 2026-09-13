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
import { getEffectiveAgentId } from '../../auth/enforce-identity';
import { senderRoutingContext, isBridgeIdentity, senderSbId } from './sender-context.js';
import { logger } from '../../utils/logger';
import type { Json } from '../../data/supabase/types';
import { getAgentGateway, type AgentTriggerPayload } from '../../channels/agent-gateway.js';
import { advanceThreadReadPointer } from './read-state.js';
import {
  SYSTEM_PRINCIPAL,
  principalColumns,
  resolveSbInWorkspace,
  resolveSbsByIds,
  senderColumns,
  type Principal,
  type SbPrincipal,
  type UserPrincipal,
} from '../../services/principals';
import { resolveCallerSb, resolveCallerWorkspace } from './caller-principal';
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

const agentIdSchema = z.string().min(1).max(64);

const getThreadMessagesSchema = userIdentifierBaseSchema.extend({
  threadKey: threadKeySchema,
  agentId: z.string().describe('Agent ID requesting access (must be a participant)'),
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
  agentId: agentIdSchema.describe('Agent ID to add to the thread'),
  addedByAgentId: agentIdSchema.optional(),
  reason: z.string().max(500).optional(),
  triggerNewParticipant: z.boolean().optional().default(true),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const closeThreadSchema = userIdentifierBaseSchema.extend({
  threadKey: threadKeySchema,
  agentId: agentIdSchema.describe('Agent ID closing the thread (must be a participant)'),
});

const reopenThreadSchema = userIdentifierBaseSchema.extend({
  threadKey: threadKeySchema,
  agentId: agentIdSchema.describe('Agent ID reopening the thread (must be a participant)'),
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
    .guid()
    .optional()
    .describe(
      'Exact-id acknowledgement (spec inkmail-read-state §1): advance the read pointer through THIS message only — the last one actually delivered — instead of the whole thread. Used by delivery consumers (channel plugin) to ack after successful injection.'
    ),
});

// ============== Helpers (exported for use by inbox-handlers) ==============

export interface ThreadRow {
  id: string;
  thread_key: string;
  workspace_id: string;
  created_by_kind: 'sb' | 'user' | 'system';
  created_by_sb_id: string | null;
  created_by_user_id: string | null;
  title: string | null;
  status: string;
  metadata: Json;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_by_kind: 'sb' | 'user' | 'system' | null;
  closed_by_sb_id: string | null;
  closed_by_user_id: string | null;
}

/** A participant row with its principal resolved for display. */
export interface ThreadParticipant {
  sbId: string | null;
  userId: string | null;
  /** The SB's slug (null for a person). */
  agentId: string | null;
  sessionId: string | null;
  joinedAt: string | null;
}

/** The SB participants only — the set dispatch operates on (§7). */
export function sbParticipants(ps: ThreadParticipant[]): SbRef[] {
  return ps
    .filter((p): p is ThreadParticipant & { sbId: string; agentId: string } => !!p.sbId)
    .map((p) => ({ sbId: p.sbId, agentId: p.agentId ?? p.sbId }));
}

/** Slugs of the SB participants, for tool output and legacy callers. */
export function participantSlugs(ps: ThreadParticipant[]): string[] {
  return sbParticipants(ps).map((p) => p.agentId);
}

/** An SB named for dispatch: canonical id plus its slug for display. */
export interface SbRef {
  sbId: string;
  agentId: string;
}

/** The creator or closer of a thread as a principal, from the row. */
export function threadCreator(t: ThreadRow): Principal {
  if (t.created_by_kind === 'sb' && t.created_by_sb_id) {
    return {
      kind: 'sb',
      sbId: t.created_by_sb_id,
      agentId: '',
      userId: '',
      workspaceId: t.workspace_id,
    };
  }
  if (t.created_by_kind === 'user' && t.created_by_user_id) {
    return { kind: 'user', userId: t.created_by_user_id };
  }
  return SYSTEM_PRINCIPAL;
}

/**
 * Look up a thread by (user_id, thread_key). Returns null if not found.
 */
/**
 * A thread is one row per (workspace, key) (spec inkmail-thread-scope §1).
 * The workspace is the caller's: an SB's identity lives in exactly one, a
 * person acts in their selected one.
 */
export async function findThread(
  supabase: ReturnType<DataComposer['getClient']>,
  workspaceId: string,
  threadKey: string
): Promise<ThreadRow | null> {
  const { data, error } = await threadTable(supabase, 'inbox_threads')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('thread_key', threadKey)
    .maybeSingle();

  if (error) {
    logger.error('Failed to find thread', { error, threadKey });
    throw new Error(`Failed to find thread: ${error.message}`);
  }
  return data;
}

/**
 * Every participant of a thread — SBs and people — with SB slugs resolved
 * for display. Two queries rather than an embedded select so the fake client
 * used by the unit tests sees the same shape production does.
 */
export async function getParticipants(
  supabase: ReturnType<DataComposer['getClient']>,
  threadId: string
): Promise<ThreadParticipant[]> {
  const { data, error } = await threadTable(supabase, 'inbox_thread_participants')
    .select('sb_id, user_id, session_id, joined_at')
    .eq('thread_id', threadId);

  if (error) {
    logger.error('Failed to get participants', { error, threadId });
    throw new Error(`Failed to get participants: ${error.message}`);
  }
  const rows = (data || []) as Array<{
    sb_id: string | null;
    user_id: string | null;
    session_id: string | null;
    joined_at: string | null;
  }>;
  const sbIds = rows.map((r) => r.sb_id).filter((id): id is string => !!id);
  const slugById = new Map(
    (await resolveSbsByIds(supabase, sbIds)).map((sb) => [sb.sbId, sb.agentId])
  );
  return rows.map((r) => ({
    sbId: r.sb_id,
    userId: r.user_id,
    agentId: r.sb_id ? (slugById.get(r.sb_id) ?? null) : null,
    sessionId: r.session_id,
    joinedAt: r.joined_at,
  }));
}

/**
 * Is this principal a participant in the thread?
 */
export async function isParticipant(
  supabase: ReturnType<DataComposer['getClient']>,
  threadId: string,
  principal: SbPrincipal | UserPrincipal
): Promise<boolean> {
  let q = threadTable(supabase, 'inbox_thread_participants')
    .select('thread_id')
    .eq('thread_id', threadId);
  q = principal.kind === 'sb' ? q.eq('sb_id', principal.sbId) : q.eq('user_id', principal.userId);
  const { data } = await q.maybeSingle();
  return !!data;
}

/** A principal as dispatch sees it: an SB with its slug, or not an SB at all. */
export type TriggerPrincipal = ({ kind: 'sb' } & SbRef) | { kind: 'user' } | { kind: 'system' };

/**
 * Determine which SBs to wake for a message (spec inkmail-thread-scope §7).
 *
 * Dispatch operates on the ordered set of SB participants only. A person
 * holding a participant row never changes the routing and is never woken
 * here ("wake" means spawning a session); "1:1" means one other SB, however
 * many people are reading. Rows, in order:
 *
 *   SB sender, explicit triggerAgents → those ∩ SB participants (self excluded unless selfStudioTarget)
 *   SB sender, triggerAll            → all SB participants (self excluded unless selfStudioTarget)
 *   SB sender, no other SB           → self iff actionable type or selfStudioTarget, else nobody
 *   SB sender, one other SB          → that SB
 *   SB sender, ≥2 others, actionable → explicit recipients if given, else all others
 *   SB sender, ≥2 others, recipients → those ∩ SB participants — even when empty
 *   SB sender, ≥2 others, non-creator reply, SB creator    → the creator
 *   SB sender, ≥2 others, non-creator reply, human creator → all other SBs (a decision, not a fallthrough)
 *   SB sender, ≥2 others, creator reply                    → all other SBs
 *   person / system sender, thread start → the addressed SBs; reply → all SB participants
 *
 * Cross-studio self-messaging: when selfStudioTarget is true, the sender is
 * NOT excluded, so an agent can message itself in another studio.
 */
export function resolveTriggeredAgents(opts: {
  sender: TriggerPrincipal;
  sbParticipants: SbRef[];
  creator: TriggerPrincipal;
  /** Canonical ids of the SBs to wake (highest precedence). */
  triggerAgents?: string[];
  triggerAll?: boolean;
  messageType?: string;
  /** Canonical ids of the addressed SBs. */
  recipients?: string[];
  selfStudioTarget?: boolean;
}): SbRef[] {
  const {
    sender,
    sbParticipants: participants,
    creator,
    triggerAgents,
    triggerAll,
    messageType,
  } = opts;
  const selfStudioTarget = !!opts.selfStudioTarget;
  const actionable = new Set(['task_request', 'session_resume']);
  const byId = new Map(participants.map((p) => [p.sbId, p]));
  const pick = (ids: string[]): SbRef[] => {
    const seen = new Set<string>();
    const out: SbRef[] = [];
    for (const id of ids) {
      const p = byId.get(id);
      if (p && !seen.has(id)) {
        seen.add(id);
        out.push(p);
      }
    }
    return out;
  };

  // A person or the system: never "self"; explicit targets win, otherwise
  // every SB in the thread hears (§7: a human's reply wakes every SB).
  if (sender.kind !== 'sb') {
    if (triggerAgents && triggerAgents.length > 0) return pick(triggerAgents);
    if (opts.recipients && opts.recipients.length > 0) return pick(opts.recipients);
    return [...participants];
  }

  const senderSbId = sender.sbId;
  const excludeSelf = (id: string) => (selfStudioTarget ? true : id !== senderSbId);

  // Precedence 1: explicit triggerAgents (filter to actual SB participants)
  if (triggerAgents && triggerAgents.length > 0) {
    return pick(triggerAgents.filter(excludeSelf));
  }

  // Precedence 2: triggerAll — every SB (except sender unless selfStudioTarget)
  if (triggerAll) {
    return participants.filter((p) => excludeSelf(p.sbId));
  }

  // Precedence 3: default rules by SB cardinality
  const others = participants.filter((p) => p.sbId !== senderSbId);
  const self: SbRef = byId.get(senderSbId) ?? { sbId: senderSbId, agentId: sender.agentId };

  // Self-thread (no other SB): wake self only on cross-studio or actionable
  // types — session_resume / task_request to self are "wake me up" signals.
  if (others.length === 0) {
    if (selfStudioTarget) return [self];
    if (messageType && actionable.has(messageType)) return [self];
    return [];
  }

  // One other SB: wake it, however many people are reading.
  if (others.length === 1) {
    return others;
  }

  // Group: actionable types always wake — explicit recipients if given,
  // otherwise all the others. Silently waking nobody would violate "every
  // message type triggers by default".
  if (messageType && actionable.has(messageType)) {
    return opts.recipients && opts.recipients.length > 0
      ? pick(opts.recipients.filter(excludeSelf))
      : others;
  }

  // Group: explicit recipients are the answer — even when the filtered
  // result is empty (self-target without selfStudioTarget).
  if (opts.recipients && opts.recipients.length > 0) {
    return pick(opts.recipients.filter(excludeSelf));
  }

  // No explicit recipients: a non-creator wakes the SB creator; the creator
  // (or anyone, when the creator is a person or the system) wakes the others.
  if (creator.kind === 'sb' && creator.sbId !== senderSbId) {
    return [byId.get(creator.sbId) ?? { sbId: creator.sbId, agentId: creator.agentId }];
  }
  return others;
}

/**
 * Dispatch triggers to SBs. The payload carries the canonical identity
 * (`toSbId`) beside the slug: the trigger handler resolves the runtime owner
 * and workspace from the identity, not from the thread (§1a).
 */
export function dispatchTriggers(
  targets: SbRef[],
  opts: {
    fromAgentId: string;
    threadKey: string;
    summary: string;
    priority: string;
    threadMessageId?: string;
    threadId?: string;
    /** Sender is a relay — excluded from caller-repo inference. */
    senderIsBridge?: boolean;
  }
): void {
  if (targets.length === 0) return;

  const gateway = getAgentGateway();
  for (const target of targets) {
    const payload: AgentTriggerPayload = {
      fromAgentId: opts.fromAgentId,
      toAgentId: target.agentId,
      toSbId: target.sbId,
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

/** The display label of a thread's creator: the SB's slug, 'user', or 'system'. */
export async function creatorLabel(
  supabase: ReturnType<DataComposer['getClient']>,
  thread: ThreadRow,
  participants: ThreadParticipant[]
): Promise<string> {
  if (thread.created_by_kind === 'sb' && thread.created_by_sb_id) {
    const known = participants.find((p) => p.sbId === thread.created_by_sb_id)?.agentId;
    if (known) return known;
    const [sb] = await resolveSbsByIds(supabase, [thread.created_by_sb_id]);
    return sb?.agentId ?? thread.created_by_sb_id;
  }
  return thread.created_by_kind;
}

/** The creator as dispatch sees it, with the slug filled in from the participants. */
export function creatorForDispatch(
  thread: ThreadRow,
  participants: ThreadParticipant[]
): TriggerPrincipal {
  if (thread.created_by_kind === 'sb' && thread.created_by_sb_id) {
    const known = participants.find((p) => p.sbId === thread.created_by_sb_id)?.agentId;
    return { kind: 'sb', sbId: thread.created_by_sb_id, agentId: known ?? thread.created_by_sb_id };
  }
  return thread.created_by_kind === 'user' ? { kind: 'user' } : { kind: 'system' };
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

  // The caller's identity fixes the workspace the thread is looked up in.
  const caller = await resolveCallerSb(supabase, resolved.user.id, agentId);
  const thread = await findThread(supabase, caller.workspaceId, threadKey);
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
  if (!(await isParticipant(supabase, thread.id, caller))) {
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
      .eq('sb_id', caller.sbId)
      .maybeSingle();
    readStateFloor = (readStatus as { last_read_at?: string } | null)?.last_read_at || null;

    if (!readStateFloor) {
      const { data: participant } = await threadTable(supabase, 'inbox_thread_participants')
        .select('joined_at')
        .eq('thread_id', thread.id)
        .eq('sb_id', caller.sbId)
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
              sbId: caller.sbId,
              throughMessageId: newestSkipped.id,
              source: 'get_thread_messages:deliberate_skip',
            });
            if (!advanced) {
              // Checked write (spec §5): a failed skip-consume must be
              // visible — the range will re-offer next cold fetch.
              advanceFailed = true;
              logger.error('[GetThreadMessages] deliberate_skip advance failed', {
                threadKey,
                agentId,
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
          sbId: caller.sbId,
          throughMessageId: maxMessageId,
          source: 'get_thread_messages:markRead',
        });
        if (!advanced) {
          advanceFailed = true;
          logger.error('[GetThreadMessages] markRead advance failed', {
            threadKey,
            agentId,
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
          status: thread.status,
          createdBy: await creatorLabel(supabase, thread, participants),
          participants: participantSlugs(participants),
          people: participants.map((p) => p.userId).filter((id): id is string => !!id),
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
            senderKind: m.sender_kind,
            senderAgentId: m.sender_agent_id ?? m.sender_kind,
            senderUserId: m.sender_user_id,
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

  // The thread lives in the caller's workspace; the newcomer must resolve
  // there too — a foreign SB cannot be placed in this thread (§6).
  const { workspaceId } = await resolveCallerWorkspace(supabase, resolved.user.id, addedByAgentId);
  const thread = await findThread(supabase, workspaceId, threadKey);
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
  const newcomer = await resolveSbInWorkspace(supabase, thread.workspace_id, agentId);

  // Idempotent: check if already participant
  if (await isParticipant(supabase, thread.id, newcomer)) {
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
    workspace_id: thread.workspace_id,
    ...principalColumns(newcomer),
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
    ...senderColumns(SYSTEM_PRINCIPAL),
    content: systemContent,
    message_type: 'system',
    metadata: {
      type: 'participant_added',
      agentId,
      sbId: newcomer.sbId,
      addedBy: addedByAgentId || null,
      reason: reason || null,
      ...(metadata || {}),
    } as Json,
  });

  logger.info('Thread participant added', { threadKey, agentId, addedBy: addedByAgentId });

  // Trigger the new participant
  if (triggerNewParticipant) {
    dispatchTriggers([{ sbId: newcomer.sbId, agentId: newcomer.agentId }], {
      fromAgentId: addedByAgentId || 'system',
      // Without this the option added in round 1 was never passed by ANY
      // caller here, so bridge exclusion stayed dead on this path
      // (Lumen, PR #514 round 2).
      senderIsBridge: await isBridgeIdentity(
        supabase,
        resolved.user.id,
        addedByAgentId || null,
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

  const caller = await resolveCallerSb(supabase, resolved.user.id, agentId);
  const thread = await findThread(supabase, caller.workspaceId, threadKey);
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
  if (!(await isParticipant(supabase, thread.id, caller))) {
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

  // Close the thread: the closer is a principal (§3), never a slug.
  const now = new Date().toISOString();
  const { error } = await threadTable(supabase, 'inbox_threads')
    .update({
      status: 'closed',
      closed_by_kind: 'sb',
      closed_by_sb_id: caller.sbId,
      closed_by_user_id: null,
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
    ...senderColumns(SYSTEM_PRINCIPAL),
    content: `Thread closed by ${agentId}`,
    message_type: 'system',
    metadata: { type: 'thread_closed', closedBy: agentId, closedBySbId: caller.sbId } as Json,
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

/** Who is reopening: a participant SB, or a person recovering from the dashboard (§2). */
export type ReopenActor = { kind: 'sb'; sbId: string } | { kind: 'user'; userId: string };

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
  // The generated Args type marks both actor ids required (no SQL default);
  // the function takes NULL for the absent one, which is the contract.
  const args = {
    p_thread_id: threadId,
    p_actor_sb_id: actor.kind === 'sb' ? actor.sbId : null,
    p_actor_user_id: actor.kind === 'user' ? actor.userId : null,
  };
  const { data, error } = await supabase.rpc('reopen_inbox_thread', args as never);
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

  const agentId = getEffectiveAgentId(parsed.agentId) ?? parsed.agentId;
  const { threadKey } = parsed;
  const reply = (payload: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  });

  const caller = await resolveCallerSb(supabase, resolved.user.id, agentId);
  const thread = await findThread(supabase, caller.workspaceId, threadKey);
  if (!thread) {
    return reply({ success: false, error: `Thread not found: ${threadKey}` });
  }

  // Who is asking comes before what state the thread is in.
  if (!(await isParticipant(supabase, thread.id, caller))) {
    return reply({
      success: false,
      error: `Agent ${agentId} is not a participant in thread ${threadKey}`,
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

  const { reopened } = await reopenThreadRow(supabase, thread.id, {
    kind: 'sb',
    sbId: caller.sbId,
  });
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

  logger.info('Thread reopened', { threadKey, reopenedBy: agentId });

  return reply({
    success: true,
    message: `Thread ${threadKey} reopened`,
    threadKey,
    reopenedBy: agentId,
  });
}

export async function handleListThreads(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = listThreadsSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const agentId = getEffectiveAgentId(parsed.agentId) ?? parsed.agentId;
  const { status, limit } = parsed;
  const caller = await resolveCallerSb(supabase, resolved.user.id, agentId);

  // Get thread IDs where this SB is a participant
  const { data: participantRows, error: pError } = await threadTable(
    supabase,
    'inbox_thread_participants'
  )
    .select('thread_id')
    .eq('sb_id', caller.sbId);

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
    .eq('workspace_id', caller.workspaceId)
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

      // Get last read timestamp for this SB
      const { data: readStatus } = await threadTable(supabase, 'inbox_thread_read_status')
        .select('last_read_at')
        .eq('thread_id', t.id)
        .eq('sb_id', caller.sbId)
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
        .select('sender_kind, sender_agent_id, content, created_at')
        .eq('thread_id', t.id)
        .neq('message_type', 'system')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      return {
        threadKey: t.thread_key,
        title: t.title,
        status: t.status,
        createdBy: await creatorLabel(supabase, t, participants),
        participants: participantSlugs(participants),
        people: participants.map((p) => p.userId).filter((id): id is string => !!id),
        unreadCount: unreadCount || 0,
        lastMessage: latestMsg
          ? {
              from: latestMsg.sender_agent_id ?? latestMsg.sender_kind,
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

  const caller = await resolveCallerSb(supabase, resolved.user.id, agentId);
  const thread = await findThread(supabase, caller.workspaceId, threadKey);
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
  if (!(await isParticipant(supabase, thread.id, caller))) {
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
      sbId: caller.sbId,
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
      sbId: caller.sbId,
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
];
