/**
 * Session Repository
 *
 * Database operations for session management.
 * Maps between database schema and domain types.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '../../data/supabase/types.js';
import type {
  Session,
  SessionLifecycle,
  SessionStatus,
  SessionType,
  ISessionRepository,
  UsageCheckpoint,
  ModelUsageTotals,
} from './types.js';
import { logger } from '../../utils/logger.js';

/**
 * Raised when a bare session alias matches active sessions in more than one
 * studio, so no single session is the address the caller asked for.
 *
 * Carried to the caller rather than swallowed: the fix is for the sender to
 * qualify the address (recipientStudioSlug / recipientStudioId), and only an
 * error that names the candidates makes that possible.
 */
export class AmbiguousAliasError extends Error {
  readonly code = 'AMBIGUOUS_SESSION_ALIAS';

  constructor(
    readonly alias: string,
    readonly agentId: string,
    readonly candidates: Array<{ sessionId: string; studioId: string | null }>
  ) {
    const studios = candidates.map((c) => c.studioId ?? '(no studio)').join(', ');
    super(
      `Session alias "${alias}" for agent "${agentId}" is ambiguous — it matches ` +
        `${candidates.length} active sessions across studios: ${studios}. ` +
        `Qualify the address with recipientStudioSlug or recipientStudioId.`
    );
    this.name = 'AmbiguousAliasError';
  }
}

/**
 * Ceiling on a diffed CUMULATIVE delta (Codex thread totals).
 *
 * Well above any real turn on that path, and far below the scale a
 * mistakenly-accumulated running counter reaches. Exported for tests.
 */
export const MAX_PLAUSIBLE_TURN_TOKENS = 10_000_000;

/**
 * Ceiling on a single PER-TURN report (Claude query totals).
 *
 * Much higher, because one query bills its cached prompt again on every model
 * step: ~20 steps against a ~500k context is ~10M input from one honest turn,
 * and a long agentic run can reach tens of millions. Only a report orders of
 * magnitude past that is evidence of a counter bug rather than a busy turn —
 * the incident that motivated these guards reported 3.4 BILLION.
 *
 * Exported for tests.
 */
export const MAX_PLAUSIBLE_QUERY_TOKENS = 1_000_000_000;

/**
 * Add a turn's per-model figures onto a session's running per-model totals,
 * key by key. Unknown keys start at zero; known ones accumulate.
 */
function mergeModelUsage(
  current: Record<string, ModelUsageTotals> | undefined,
  turn: Record<string, ModelUsageTotals>
): Record<string, ModelUsageTotals> {
  const merged: Record<string, ModelUsageTotals> = { ...(current || {}) };
  for (const [model, entry] of Object.entries(turn)) {
    const prior = merged[model];
    merged[model] = {
      inputTokens: (prior?.inputTokens || 0) + entry.inputTokens,
      outputTokens: (prior?.outputTokens || 0) + entry.outputTokens,
      cacheReadTokens: (prior?.cacheReadTokens || 0) + entry.cacheReadTokens,
      cacheWriteTokens: (prior?.cacheWriteTokens || 0) + entry.cacheWriteTokens,
      // Cost completeness, not just cost: a mixed set of known and unknown
      // contributions must not publish its subtotal as the total. Order does
      // not matter — unknown-then-known and known-then-unknown both mark the
      // running figure partial.
      ...(() => {
        const priorCost = prior?.costUSD;
        const entryCost = entry.costUSD;
        if (priorCost === undefined && entryCost === undefined) return {};
        const partial =
          prior?.costPartial === true ||
          // The incoming turn may ALREADY be a lower bound (the CLI summed a
          // run whose invocations mixed reported and unreported cost). Reading
          // only `prior` made a first such entry land as complete.
          entry.costPartial === true ||
          (prior !== undefined && priorCost === undefined) ||
          entryCost === undefined;
        return {
          costUSD: (priorCost ?? 0) + (entryCost ?? 0),
          ...(partial ? { costPartial: true } : {}),
        };
      })(),
      ...(entry.canonicalModel ? { canonicalModel: entry.canonicalModel } : {}),
    };
  }
  return merged;
}

type DbSession = Database['public']['Tables']['sessions']['Row'];
type DbSessionInsert = Database['public']['Tables']['sessions']['Insert'];
type DbSessionUpdate = Database['public']['Tables']['sessions']['Update'];

// Helper type for metadata that's compatible with Json
type SessionMetadata = Record<string, Json | undefined>;

/**
 * Maps database row to domain Session type.
 * Handles missing columns by using defaults (for gradual migration).
 */
function mapDbToSession(row: DbSession): Session {
  // Extract extended fields from metadata if they exist
  const metadata = (row.metadata || {}) as Record<string, unknown>;

  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id || '',
    sbId: row.sb_id || undefined,
    studioId: row.studio_id || undefined,
    contactId: row.contact_id || undefined,
    backendSessionId: row.backend_session_id || row.claude_session_id,

    type: (metadata.type as SessionType) || 'primary',
    lifecycle: (row.lifecycle as SessionLifecycle) || 'idle',
    status: (row.status as SessionStatus) || 'active',

    taskDescription: metadata.taskDescription as string | undefined,
    parentSessionId: metadata.parentSessionId as string | undefined,

    // Token tracking (stored in metadata until migration adds columns)
    contextTokens: (metadata.contextTokens as number) || 0,
    totalInputTokens: (metadata.totalInputTokens as number) || 0,
    totalOutputTokens: (metadata.totalOutputTokens as number) || 0,
    totalCacheReadTokens: (metadata.totalCacheReadTokens as number) || 0,
    totalCacheWriteTokens: (metadata.totalCacheWriteTokens as number) || 0,
    modelUsage: (metadata.modelUsage as Record<string, ModelUsageTotals> | undefined) || undefined,
    usageCheckpoint: (metadata.usageCheckpoint as UsageCheckpoint | undefined) || undefined,

    // Aggregate counters (persisted as columns)
    messageCount: row.message_count || 0,
    tokenCount: row.token_count || 0,

    // Runtime context
    backend: row.backend || 'claude-code',
    model: row.model || null,

    // Compaction tracking
    lastCompactionAt: metadata.lastCompactionAt
      ? new Date(metadata.lastCompactionAt as string)
      : null,
    compactionCount: (metadata.compactionCount as number) || 0,

    // Timestamps
    startedAt: row.started_at ? new Date(row.started_at) : new Date(),
    lastActivityAt: row.started_at ? new Date(row.started_at) : new Date(),
    endedAt: row.ended_at ? new Date(row.ended_at) : null,

    // Thread key
    threadKey: row.thread_key || undefined,

    // Session alias
    alias: (row as Record<string, unknown>).alias as string | undefined,

    metadata: metadata,
  };
}

/**
 * Maps domain Session to database insert/update format.
 */
function mapSessionToDb(
  session: Omit<Session, 'id' | 'startedAt' | 'lastActivityAt'>
): DbSessionInsert {
  return {
    user_id: session.userId,
    agent_id: session.agentId,
    sb_id: session.sbId || null,
    claude_session_id: session.backendSessionId,
    backend_session_id: session.backendSessionId,
    lifecycle: session.lifecycle,
    status: session.status,
    ended_at: session.endedAt?.toISOString() || null,
    message_count: session.messageCount,
    token_count: session.tokenCount,
    backend: session.backend,
    model: session.model,
    studio_id: session.studioId || null,
    contact_id: session.contactId || null,
    thread_key: session.threadKey || null,
    ...(session.alias ? { alias: session.alias } : {}),
    metadata: {
      type: session.type,
      taskDescription: session.taskDescription,
      parentSessionId: session.parentSessionId,
      contextTokens: session.contextTokens,
      totalInputTokens: session.totalInputTokens,
      totalOutputTokens: session.totalOutputTokens,
      totalCacheReadTokens: session.totalCacheReadTokens,
      totalCacheWriteTokens: session.totalCacheWriteTokens,
      lastCompactionAt: session.lastCompactionAt?.toISOString() || null,
      compactionCount: session.compactionCount,
      ...session.metadata,
    },
  };
}

export class SessionRepository implements ISessionRepository {
  constructor(private supabase: SupabaseClient<Database>) {}

  async findById(id: string): Promise<Session | null> {
    const { data, error } = await this.supabase.from('sessions').select('*').eq('id', id).single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null; // Not found
      }
      logger.error('Error finding session by id', { id, error });
      throw error;
    }

    return data ? mapDbToSession(data) : null;
  }

  async findByUserAndAgent(
    userId: string,
    agentId: string,
    options?: {
      status?: SessionStatus;
      type?: SessionType;
      studioId?: string;
      contactId?: string;
      /** Canonical identity UUID — preferred over the ambiguous slug. */
      sbId?: string | null;
    }
  ): Promise<Session | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (this.supabase as any)
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .is('ended_at', null)
      .neq('lifecycle', 'failed')
      .order('started_at', { ascending: false })
      .limit(1);
    // Same-slug siblings must not satisfy general reuse (Lumen, #514 r7).
    query = options?.sbId ? query.eq('sb_id', options.sbId) : query.eq('agent_id', agentId);

    if (options?.studioId) {
      query = query.eq('studio_id', options.studioId);
    }

    // Contact-scoped session isolation: match by contact_id when provided,
    // or filter to NULL contact_id for owner/system sessions
    if (options?.contactId) {
      query = query.eq('contact_id', options.contactId);
    } else if (options && 'contactId' in options) {
      // Explicitly passed contactId: undefined → match NULL (owner session)
      query = query.is('contact_id', null);
    }

    if (options?.status) {
      query = query.eq('status', options.status);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('Error finding session by user and agent', {
        userId,
        agentId,
        error,
      });
      throw error;
    }

    if (!data || data.length === 0) {
      return null;
    }

    const session = mapDbToSession(data[0]);

    // Filter by type if specified (stored in metadata)
    if (options?.type && session.type !== options.type) {
      return null;
    }

    return session;
  }

  /**
   * Resolve a session by its human-readable alias.
   *
   * Aliases are scoped to (user, agent, studio) — see the
   * 20260814080050_session_alias_studio_scope migration. Two studios may each
   * hold a session named "review", so a bare alias is not always a unique
   * address.
   *
   * @param studioId When the caller named a studio explicitly, the lookup is
   *   pinned to it and a match elsewhere is not a match. When omitted, the
   *   alias must identify exactly one active session.
   * @throws {AmbiguousAliasError} when a bare alias matches sessions in more
   *   than one studio. Refusing is deliberate: the previous implementation
   *   ordered by started_at and took the newest, which routes work into
   *   whichever worktree happened to start last. A caller that gets an error
   *   can qualify the address; a caller that gets the wrong studio cannot
   *   tell that anything went wrong.
   */
  async findByAlias(
    userId: string,
    agentId: string,
    alias: string,
    studioId?: string,
    sbId?: string | null
  ): Promise<Session | null> {
    // alias column not yet in generated Supabase types — cast
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // Canonical identity when the caller resolved one — a slug can name
    // different identities in different workspaces, so slug-scoped reuse can
    // hand back another agent's session (Lumen, PR #514 round 6).
    let query = (this.supabase as any)
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('alias', alias)
      .is('ended_at', null)
      .neq('lifecycle', 'failed');
    query = sbId ? query.eq('sb_id', sbId) : query.eq('agent_id', agentId);

    if (studioId !== undefined) {
      query = query.eq('studio_id', studioId);
    }

    const { data, error } = (await query.order('started_at', { ascending: false })) as {
      data: DbSession[] | null;
      error: { message: string; code?: string } | null;
    };

    if (error) {
      logger.error('Error finding session by alias', { userId, agentId, alias, studioId, error });
      throw error;
    }

    const rows = data ?? [];
    if (rows.length === 0) return null;

    // A studio-pinned lookup is unique by index, so anything past the first
    // row would mean the index is gone. Take it and move on.
    if (studioId !== undefined) return mapDbToSession(rows[0]);

    const distinctStudios = new Set(rows.map((r) => r.studio_id ?? null));
    if (distinctStudios.size > 1) {
      throw new AmbiguousAliasError(
        alias,
        agentId,
        rows.map((r) => ({ sessionId: r.id, studioId: r.studio_id ?? null }))
      );
    }

    return mapDbToSession(rows[0]);
  }

  async findByThreadKey(
    userId: string,
    agentId: string,
    threadKey: string,
    studioId?: string,
    contactId?: string,
    sbId?: string | null
  ): Promise<Session | null> {
    // See findByAlias: identity by UUID when known, slug only as a fallback.
    let query = (this.supabase as any)
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('thread_key', threadKey)
      .is('ended_at', null)
      // `ended_at IS NULL` was doing none of the work it looks like it is
      // doing: nothing set `ended_at` on completion, so finished sessions
      // stayed NULL and kept matching here. A thread whose conversation was
      // over would route the next trigger back into the completed session
      // instead of starting a fresh one. Filter on lifecycle directly, and
      // see handleUpdateSessionPhase — which now stamps `ended_at` too, so
      // the clause above finally means something (PR #349, revived).
      .not('lifecycle', 'in', '(completed,failed)')
      .order('started_at', { ascending: false })
      .limit(1);
    query = sbId ? query.eq('sb_id', sbId) : query.eq('agent_id', agentId);

    if (studioId) {
      query = query.eq('studio_id', studioId);
    }

    if (contactId) {
      query = query.eq('contact_id', contactId);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('Error finding session by thread key', { userId, agentId, threadKey, error });
      throw error;
    }

    return data && data.length > 0 ? mapDbToSession(data[0]) : null;
  }

  async findByUser(
    userId: string,
    options?: {
      agentId?: string;
      status?: SessionStatus;
      type?: SessionType;
      limit?: number;
    }
  ): Promise<Session[]> {
    let query = this.supabase
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .order('started_at', { ascending: false });

    if (options?.agentId) {
      query = query.eq('agent_id', options.agentId);
    }

    if (options?.status) {
      query = query.eq('status', options.status);
    }

    if (options?.limit) {
      query = query.limit(options.limit);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('Error finding sessions by user', { userId, error });
      throw error;
    }

    let sessions = (data || []).map(mapDbToSession);

    // Filter by type if specified (stored in metadata)
    if (options?.type) {
      sessions = sessions.filter((s) => s.type === options.type);
    }

    return sessions;
  }

  async create(session: Omit<Session, 'id' | 'startedAt' | 'lastActivityAt'>): Promise<Session> {
    const dbSession = mapSessionToDb(session);

    const { data, error } = await this.supabase
      .from('sessions')
      .insert(dbSession)
      .select()
      .single();

    if (error) {
      logger.error('Error creating session', { session, error });
      throw error;
    }

    logger.info('Created session', {
      id: data.id,
      userId: session.userId,
      agentId: session.agentId,
      type: session.type,
    });

    return mapDbToSession(data);
  }

  async update(
    id: string,
    updates: Omit<Partial<Session>, 'studioId'> & { studioId?: string | null }
  ): Promise<Session> {
    // First fetch current session to merge metadata
    const current = await this.findById(id);
    if (!current) {
      throw new Error(`Session not found: ${id}`);
    }

    const dbUpdates: DbSessionUpdate = {};

    if (updates.backendSessionId !== undefined) {
      dbUpdates.backend_session_id = updates.backendSessionId;
      // Keep legacy column in sync during migration
      dbUpdates.claude_session_id = updates.backendSessionId;
    }

    if (updates.lifecycle !== undefined) {
      dbUpdates.lifecycle = updates.lifecycle;
    }

    if (updates.status !== undefined) {
      dbUpdates.status = updates.status;
    }

    if (updates.endedAt !== undefined) {
      dbUpdates.ended_at = updates.endedAt?.toISOString() || null;
    }

    if (updates.messageCount !== undefined) {
      dbUpdates.message_count = updates.messageCount;
    }

    if (updates.tokenCount !== undefined) {
      dbUpdates.token_count = updates.tokenCount;
    }

    if (updates.backend !== undefined) {
      dbUpdates.backend = updates.backend;
    }

    if (updates.model !== undefined) {
      dbUpdates.model = updates.model;
    }

    if (updates.studioId !== undefined) {
      dbUpdates.studio_id = updates.studioId || null;
    }

    if (updates.cliAttached !== undefined) {
      dbUpdates.cli_attached = updates.cliAttached;
    }

    if (updates.alias !== undefined) {
      (dbUpdates as Record<string, unknown>).alias = updates.alias || null;
    }

    // Merge metadata updates
    const newMetadata: SessionMetadata = { ...(current.metadata as SessionMetadata) };

    if (updates.type !== undefined) {
      newMetadata.type = updates.type;
    }
    if (updates.taskDescription !== undefined) {
      newMetadata.taskDescription = updates.taskDescription;
    }
    if (updates.parentSessionId !== undefined) {
      newMetadata.parentSessionId = updates.parentSessionId;
    }
    if (updates.contextTokens !== undefined) {
      newMetadata.contextTokens = updates.contextTokens;
    }
    if (updates.totalInputTokens !== undefined) {
      newMetadata.totalInputTokens = updates.totalInputTokens;
    }
    if (updates.totalOutputTokens !== undefined) {
      newMetadata.totalOutputTokens = updates.totalOutputTokens;
    }
    if (updates.totalCacheReadTokens !== undefined) {
      newMetadata.totalCacheReadTokens = updates.totalCacheReadTokens;
    }
    if (updates.totalCacheWriteTokens !== undefined) {
      newMetadata.totalCacheWriteTokens = updates.totalCacheWriteTokens;
    }
    if (updates.modelUsage !== undefined) {
      newMetadata.modelUsage = updates.modelUsage as unknown as Json;
    }
    if (updates.usageCheckpoint !== undefined) {
      newMetadata.usageCheckpoint = updates.usageCheckpoint as unknown as Json;
    }
    if (updates.lastCompactionAt !== undefined) {
      newMetadata.lastCompactionAt = updates.lastCompactionAt?.toISOString() || null;
    }
    if (updates.compactionCount !== undefined) {
      newMetadata.compactionCount = updates.compactionCount;
    }
    if (updates.metadata !== undefined) {
      Object.assign(newMetadata, updates.metadata);
    }

    dbUpdates.metadata = newMetadata;

    const { data, error } = await this.supabase
      .from('sessions')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      logger.error('Error updating session', { id, updates, error });
      throw error;
    }

    return mapDbToSession(data);
  }

  async updateTokenUsage(
    id: string,
    usage: {
      /** Omitted when the backend reports no per-turn context measure. */
      contextTokens?: number;
      inputTokens: number;
      outputTokens: number;
      /** Cache breakdown of `inputTokens`, not additions to it. */
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      /** This turn's per-model figures, keyed as the backend reported them. */
      modelUsage?: Record<string, ModelUsageTotals>;
      cumulative?: boolean;
    },
    options?: { backendSessionId?: string | null }
  ): Promise<void> {
    const current = await this.findById(id);
    if (!current) {
      throw new Error(`Session not found: ${id}`);
    }

    // Resolve this turn's delta. Backends differ: Claude/Gemini report a
    // per-turn figure, Codex `turn.completed.usage` carries
    // `ThreadTokenUsage.total` — a running total for the backend thread.
    // Adding a running total re-adds the whole history every turn, which is
    // what grew one session to 3,441,018,986 tokens.
    let deltaInput = usage.inputTokens;
    let deltaOutput = usage.outputTokens;
    let nextCheckpoint: UsageCheckpoint | undefined;

    if (usage.cumulative) {
      const backendSessionId = options?.backendSessionId ?? null;
      const checkpoint = current.usageCheckpoint;

      nextCheckpoint = {
        backendSessionId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      };

      // "No checkpoint" covers two genuinely different situations, and they
      // need opposite handling.
      const hasPriorUsage =
        current.totalInputTokens > 0 || current.totalOutputTokens > 0 || current.tokenCount > 0;

      if (!checkpoint && hasPriorUsage) {
        // Rollout: this session predates checkpointing but already has
        // accumulated token history. The report covers the whole thread —
        // including everything already counted — so adding it would duplicate
        // the entire history. Establish the baseline and count nothing this
        // turn; subsequent turns diff correctly.
        //
        // This must happen BEFORE the plausibility guard below, or a session
        // whose running total already exceeds the ceiling (the motivating
        // 3.4B one) could never lay down a baseline and its accounting would
        // stay disabled permanently.
        deltaInput = 0;
        deltaOutput = 0;
        logger.info('Establishing cumulative usage baseline for existing session', {
          id,
          backendSessionId,
          baseline: { input: usage.inputTokens, output: usage.outputTokens },
        });
      } else if (!checkpoint) {
        // Brand-new session: nothing has been counted yet, so the first
        // report IS this thread's usage so far. Baselining it here would
        // discard the entire first turn permanently.
        deltaInput = usage.inputTokens;
        deltaOutput = usage.outputTokens;
      } else if (checkpoint.backendSessionId !== backendSessionId) {
        // Known thread change (fresh run, resume onto a new thread,
        // compaction). Totals restart with the thread, so the whole report is
        // genuinely this thread's usage so far.
        deltaInput = usage.inputTokens;
        deltaOutput = usage.outputTokens;
      } else if (
        usage.inputTokens < checkpoint.inputTokens ||
        usage.outputTokens < checkpoint.outputTokens
      ) {
        // Counter moved backwards under the same thread id — restarted in
        // place. Same reasoning as a thread change.
        deltaInput = usage.inputTokens;
        deltaOutput = usage.outputTokens;
        logger.info('Backend usage counter reset — rebasing checkpoint', {
          id,
          backendSessionId,
          previous: checkpoint,
          reported: { input: usage.inputTokens, output: usage.outputTokens },
        });
      } else {
        deltaInput = usage.inputTokens - checkpoint.inputTokens;
        deltaOutput = usage.outputTokens - checkpoint.outputTokens;
      }
    }

    // Last-ditch heuristic, not a semantic proof: one agent turn can contain
    // many sampling calls, so a large delta is not inherently wrong. This only
    // catches the pathological case where a running total is still reaching us
    // undiffed, so we keep the last good value instead of persisting garbage.
    // Two ceilings, because the two paths fail differently. A diffed
    // cumulative delta above 10M means a running total reached us undiffed —
    // the original 3.4B incident. A per-turn report has no such failure mode
    // and legitimately runs far larger, since one query re-bills its cached
    // prompt on every model step (~20 steps against a ~500k context is ~10M
    // input from one honest turn). Holding per-turn reports to the cumulative
    // ceiling discarded real usage, which is the accounting bug this all
    // started from; leaving them unguarded would drop the backstop entirely
    // (Lumen, PR #493 round 2).
    const turnTotal = deltaInput + deltaOutput;
    const ceiling = usage.cumulative ? MAX_PLAUSIBLE_TURN_TOKENS : MAX_PLAUSIBLE_QUERY_TOKENS;
    if (turnTotal > ceiling) {
      logger.error('Implausible single-turn token delta — refusing to accumulate', {
        id,
        usage,
        deltaInput,
        deltaOutput,
        turnTotal,
        ceiling,
        cumulative: !!usage.cumulative,
        hint: 'A cumulative total is likely reaching the repository undiffed',
      });

      // Still advance the checkpoint. Skipping it would leave the next report
      // diffing against a stale baseline, producing an even larger delta that
      // trips the guard again — wedging accounting off permanently. Dropping
      // one turn's tokens is recoverable; a stuck baseline is not.
      if (nextCheckpoint) {
        await this.update(id, { usageCheckpoint: nextCheckpoint });
      }
      return;
    }

    const newInputTokens = current.totalInputTokens + deltaInput;
    const newOutputTokens = current.totalOutputTokens + deltaOutput;

    // Cache totals are a breakdown of input, so they follow the same
    // accumulation rule. Only per-turn backends report them (Claude); Codex
    // sends cumulative thread totals with no cache fields at all, so there is
    // nothing to diff and nothing to add on that path.
    const cacheReadDelta = !usage.cumulative ? usage.cacheReadTokens || 0 : 0;
    const cacheWriteDelta = !usage.cumulative ? usage.cacheWriteTokens || 0 : 0;

    // Per-model accumulation. Keys stay exactly as the backend reported them
    // and are never merged across keys — a query can list both a dated model
    // id and its alias, and only the reporting layer has the context to decide
    // whether those are one model or two. Accumulating each key against itself
    // is safe either way, and preserves costUSD, which is the figure that
    // actually answers "what did this session spend".
    const mergedModelUsage = usage.modelUsage
      ? mergeModelUsage(current.modelUsage, usage.modelUsage)
      : undefined;

    await this.update(id, {
      // Only persist a context figure the backend actually reported. Codex
      // JSONL carries no per-turn context measure, and aliasing it to the
      // cumulative input total stored a false 1.3B "context" reading.
      ...(usage.contextTokens !== undefined ? { contextTokens: usage.contextTokens } : {}),
      totalInputTokens: newInputTokens,
      totalOutputTokens: newOutputTokens,
      ...(cacheReadDelta
        ? { totalCacheReadTokens: current.totalCacheReadTokens + cacheReadDelta }
        : {}),
      ...(cacheWriteDelta
        ? { totalCacheWriteTokens: current.totalCacheWriteTokens + cacheWriteDelta }
        : {}),
      ...(mergedModelUsage ? { modelUsage: mergedModelUsage } : {}),
      tokenCount: newInputTokens + newOutputTokens,
      ...(nextCheckpoint ? { usageCheckpoint: nextCheckpoint } : {}),
    });

    logger.debug('Updated token usage', { id, usage });
  }

  async markCompacted(id: string, newBackendSessionId: string | null): Promise<void> {
    const current = await this.findById(id);
    if (!current) {
      throw new Error(`Session not found: ${id}`);
    }

    const updates: Partial<Session> = {
      lastCompactionAt: new Date(),
      compactionCount: current.compactionCount + 1,
      contextTokens: 0, // Reset after compaction
    };

    // Only rotate the backend session ID if a new one was provided.
    // null means "keep the existing ID" (e.g., Codex reuses the same thread UUID).
    if (newBackendSessionId) {
      updates.backendSessionId = newBackendSessionId;
    }

    await this.update(id, updates);

    logger.info('Marked session as compacted', {
      id,
      newBackendSessionId: newBackendSessionId || '(preserved)',
      compactionCount: current.compactionCount + 1,
    });
  }

  async tryAcquireCompactionLock(id: string, staleLockMinutes = 15): Promise<boolean> {
    const now = new Date();

    // First attempt: acquire lock where compacting_since IS NULL
    const { data, error } = await this.supabase
      .from('sessions')
      .update({ compacting_since: now.toISOString() })
      .eq('id', id)
      .is('compacting_since', null)
      .select('id');

    if (error) {
      logger.error('Error acquiring compaction lock', { id, error });
      throw error;
    }

    if (data && data.length > 0) {
      logger.info('Acquired compaction lock', { id });
      return true;
    }

    // Lock is held — check if it's stale
    const { data: session } = await this.supabase
      .from('sessions')
      .select('compacting_since')
      .eq('id', id)
      .single();

    if (session?.compacting_since) {
      const lockAge = now.getTime() - new Date(session.compacting_since).getTime();
      const staleThresholdMs = staleLockMinutes * 60 * 1000;

      if (lockAge > staleThresholdMs) {
        // Stale lock — reclaim it atomically by matching the old timestamp
        const { data: reclaimed } = await this.supabase
          .from('sessions')
          .update({ compacting_since: now.toISOString() })
          .eq('id', id)
          .eq('compacting_since', session.compacting_since)
          .select('id');

        if (reclaimed && reclaimed.length > 0) {
          logger.warn('Reclaimed stale compaction lock', {
            id,
            staleSinceMinutes: Math.round(lockAge / 60_000),
          });
          return true;
        }
      }
    }

    logger.info('Compaction lock already held', { id });
    return false;
  }

  async releaseCompactionLock(id: string): Promise<void> {
    const { error } = await this.supabase
      .from('sessions')
      .update({ compacting_since: null })
      .eq('id', id);

    if (error) {
      logger.error('Error releasing compaction lock', { id, error });
      throw error;
    }

    logger.info('Released compaction lock', { id });
  }
}
