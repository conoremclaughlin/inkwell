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
} from './types.js';
import { logger } from '../../utils/logger.js';

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
    identityId: row.identity_id || undefined,
    studioId: row.studio_id || row.workspace_id || undefined,
    claudeSessionId: row.claude_session_id,

    type: (metadata.type as SessionType) || 'primary',
    lifecycle: (row.lifecycle as SessionLifecycle) || 'idle',
    status: (row.status as SessionStatus) || 'active',

    taskDescription: metadata.taskDescription as string | undefined,
    parentSessionId: metadata.parentSessionId as string | undefined,

    // Token tracking (stored in metadata until migration adds columns)
    contextTokens: (metadata.contextTokens as number) || 0,
    totalInputTokens: (metadata.totalInputTokens as number) || 0,
    totalOutputTokens: (metadata.totalOutputTokens as number) || 0,

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
    identity_id: session.identityId || null,
    claude_session_id: session.claudeSessionId,
    lifecycle: session.lifecycle,
    status: session.status,
    ended_at: session.endedAt?.toISOString() || null,
    message_count: session.messageCount,
    token_count: session.tokenCount,
    backend: session.backend,
    model: session.model,
    studio_id: session.studioId || null,
    // Keep mirrored for compatibility with older server versions.
    workspace_id: session.studioId || null,
    thread_key: session.threadKey || null,
    metadata: {
      type: session.type,
      taskDescription: session.taskDescription,
      parentSessionId: session.parentSessionId,
      contextTokens: session.contextTokens,
      totalInputTokens: session.totalInputTokens,
      totalOutputTokens: session.totalOutputTokens,
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
    options?: { status?: SessionStatus; type?: SessionType; studioId?: string }
  ): Promise<Session | null> {
    let query = this.supabase
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('agent_id', agentId)
      .is('ended_at', null)
      .neq('lifecycle', 'failed')
      .order('started_at', { ascending: false })
      .limit(1);

    if (options?.studioId) {
      query = query.or(`studio_id.eq.${options.studioId},workspace_id.eq.${options.studioId}`);
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

  async findByThreadKey(
    userId: string,
    agentId: string,
    threadKey: string,
    studioId?: string
  ): Promise<Session | null> {
    let query = this.supabase
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('agent_id', agentId)
      .eq('thread_key', threadKey)
      .is('ended_at', null)
      .neq('lifecycle', 'failed')
      .order('started_at', { ascending: false })
      .limit(1);

    if (studioId) {
      query = query.or(`studio_id.eq.${studioId},workspace_id.eq.${studioId}`);
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

  async update(id: string, updates: Partial<Session>): Promise<Session> {
    // First fetch current session to merge metadata
    const current = await this.findById(id);
    if (!current) {
      throw new Error(`Session not found: ${id}`);
    }

    const dbUpdates: DbSessionUpdate = {};

    if (updates.claudeSessionId !== undefined) {
      dbUpdates.claude_session_id = updates.claudeSessionId;
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
      // Keep mirrored for compatibility with older server versions.
      dbUpdates.workspace_id = updates.studioId || null;
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
    usage: { contextTokens: number; inputTokens: number; outputTokens: number }
  ): Promise<void> {
    const current = await this.findById(id);
    if (!current) {
      throw new Error(`Session not found: ${id}`);
    }

    const newInputTokens = current.totalInputTokens + usage.inputTokens;
    const newOutputTokens = current.totalOutputTokens + usage.outputTokens;

    await this.update(id, {
      contextTokens: usage.contextTokens,
      totalInputTokens: newInputTokens,
      totalOutputTokens: newOutputTokens,
      tokenCount: newInputTokens + newOutputTokens,
    });

    logger.debug('Updated token usage', { id, usage });
  }

  async markCompacted(id: string, newClaudeSessionId: string): Promise<void> {
    const current = await this.findById(id);
    if (!current) {
      throw new Error(`Session not found: ${id}`);
    }

    await this.update(id, {
      claudeSessionId: newClaudeSessionId,
      lastCompactionAt: new Date(),
      compactionCount: current.compactionCount + 1,
      contextTokens: 0, // Reset after compaction
    });

    logger.info('Marked session as compacted', {
      id,
      newClaudeSessionId,
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
