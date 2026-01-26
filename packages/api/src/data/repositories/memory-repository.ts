/**
 * Memory Repository - handles memories, sessions, and session logs
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../utils/logger';
import type {
  Memory,
  MemoryCreateInput,
  MemoryRow,
  MemorySearchOptions,
  MemoryHistory,
  MemoryHistoryRow,
  Session,
  SessionCreateInput,
  SessionRow,
  SessionLog,
  SessionLogCreateInput,
  SessionLogRow,
  Salience,
} from '../models/memory';

export class MemoryRepository {
  constructor(private supabase: SupabaseClient) {}

  // ==================== MEMORIES ====================

  /**
   * Create a new memory
   */
  async remember(input: MemoryCreateInput): Promise<Memory> {
    const { data, error } = await this.supabase
      .from('memories')
      .insert({
        user_id: input.userId,
        content: input.content,
        source: input.source || 'observation',
        salience: input.salience || 'medium',
        topics: input.topics || [],
        metadata: input.metadata || {},
        expires_at: input.expiresAt?.toISOString(),
      })
      .select()
      .single();

    if (error) {
      logger.error('Failed to create memory:', error);
      throw new Error(`Failed to create memory: ${error.message}`);
    }

    return this.rowToMemory(data);
  }

  /**
   * Search memories by text (basic search for now, semantic later)
   */
  async recall(
    userId: string,
    query?: string,
    options: MemorySearchOptions = {}
  ): Promise<Memory[]> {
    let queryBuilder = this.supabase
      .from('memories')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    // Filter by source
    if (options.source) {
      queryBuilder = queryBuilder.eq('source', options.source);
    }

    // Filter by salience
    if (options.salience) {
      queryBuilder = queryBuilder.eq('salience', options.salience);
    }

    // Filter by topics (any match)
    if (options.topics && options.topics.length > 0) {
      queryBuilder = queryBuilder.overlaps('topics', options.topics);
    }

    // Exclude expired unless requested
    if (!options.includeExpired) {
      queryBuilder = queryBuilder.or('expires_at.is.null,expires_at.gt.now()');
    }

    // Text search on content (basic ILIKE for now)
    if (query) {
      queryBuilder = queryBuilder.ilike('content', `%${query}%`);
    }

    // Pagination
    const limit = options.limit || 20;
    const offset = options.offset || 0;
    queryBuilder = queryBuilder.range(offset, offset + limit - 1);

    const { data, error } = await queryBuilder;

    if (error) {
      logger.error('Failed to recall memories:', error);
      throw new Error(`Failed to recall memories: ${error.message}`);
    }

    return (data || []).map(this.rowToMemory);
  }

  /**
   * Get a specific memory by ID
   */
  async getMemory(id: string): Promise<Memory | null> {
    const { data, error } = await this.supabase
      .from('memories')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      logger.error('Failed to get memory:', error);
      throw new Error(`Failed to get memory: ${error.message}`);
    }

    return data ? this.rowToMemory(data) : null;
  }

  /**
   * Delete a memory (forget)
   */
  async forget(id: string, userId: string): Promise<boolean> {
    const { error } = await this.supabase
      .from('memories')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      logger.error('Failed to forget memory:', error);
      throw new Error(`Failed to forget memory: ${error.message}`);
    }

    return true;
  }

  /**
   * Update memory salience or topics
   */
  async updateMemory(
    id: string,
    userId: string,
    updates: { salience?: Salience; topics?: string[]; metadata?: Record<string, unknown> }
  ): Promise<Memory | null> {
    const updateData: Record<string, unknown> = {};
    if (updates.salience) updateData.salience = updates.salience;
    if (updates.topics) updateData.topics = updates.topics;
    if (updates.metadata) updateData.metadata = updates.metadata;

    const { data, error } = await this.supabase
      .from('memories')
      .update(updateData)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      logger.error('Failed to update memory:', error);
      throw new Error(`Failed to update memory: ${error.message}`);
    }

    return data ? this.rowToMemory(data) : null;
  }

  // ==================== SESSIONS ====================

  /**
   * Start a new session
   */
  async startSession(input: SessionCreateInput): Promise<Session> {
    const { data, error } = await this.supabase
      .from('sessions')
      .insert({
        user_id: input.userId,
        agent_id: input.agentId,
        metadata: input.metadata || {},
      })
      .select()
      .single();

    if (error) {
      logger.error('Failed to start session:', error);
      throw new Error(`Failed to start session: ${error.message}`);
    }

    return this.rowToSession(data);
  }

  /**
   * End a session with optional summary
   */
  async endSession(sessionId: string, summary?: string): Promise<Session | null> {
    const { data, error } = await this.supabase
      .from('sessions')
      .update({
        ended_at: new Date().toISOString(),
        summary,
      })
      .eq('id', sessionId)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      logger.error('Failed to end session:', error);
      throw new Error(`Failed to end session: ${error.message}`);
    }

    return data ? this.rowToSession(data) : null;
  }

  /**
   * Get a session by ID
   */
  async getSession(id: string): Promise<Session | null> {
    const { data, error } = await this.supabase
      .from('sessions')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      logger.error('Failed to get session:', error);
      throw new Error(`Failed to get session: ${error.message}`);
    }

    return data ? this.rowToSession(data) : null;
  }

  /**
   * Get active session for a user (most recent without ended_at)
   */
  async getActiveSession(userId: string, agentId?: string): Promise<Session | null> {
    let query = this.supabase
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1);

    if (agentId) {
      query = query.eq('agent_id', agentId);
    }

    const { data, error } = await query.single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      logger.error('Failed to get active session:', error);
      throw new Error(`Failed to get active session: ${error.message}`);
    }

    return data ? this.rowToSession(data) : null;
  }

  /**
   * List sessions for a user
   */
  async listSessions(
    userId: string,
    options: { limit?: number; offset?: number; agentId?: string } = {}
  ): Promise<Session[]> {
    let query = this.supabase
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .order('started_at', { ascending: false });

    if (options.agentId) {
      query = query.eq('agent_id', options.agentId);
    }

    const limit = options.limit || 20;
    const offset = options.offset || 0;
    query = query.range(offset, offset + limit - 1);

    const { data, error } = await query;

    if (error) {
      logger.error('Failed to list sessions:', error);
      throw new Error(`Failed to list sessions: ${error.message}`);
    }

    return (data || []).map(this.rowToSession);
  }

  // ==================== SESSION LOGS ====================

  /**
   * Add a log entry to a session
   */
  async addSessionLog(input: SessionLogCreateInput): Promise<SessionLog> {
    const { data, error } = await this.supabase
      .from('session_logs')
      .insert({
        session_id: input.sessionId,
        content: input.content,
        salience: input.salience || 'medium',
      })
      .select()
      .single();

    if (error) {
      logger.error('Failed to add session log:', error);
      throw new Error(`Failed to add session log: ${error.message}`);
    }

    return this.rowToSessionLog(data);
  }

  /**
   * Get all logs for a session
   */
  async getSessionLogs(sessionId: string): Promise<SessionLog[]> {
    const { data, error } = await this.supabase
      .from('session_logs')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (error) {
      logger.error('Failed to get session logs:', error);
      throw new Error(`Failed to get session logs: ${error.message}`);
    }

    return (data || []).map(this.rowToSessionLog);
  }

  // ==================== MEMORY HISTORY ====================

  /**
   * Get version history for a specific memory
   */
  async getMemoryHistory(memoryId: string, userId: string): Promise<MemoryHistory[]> {
    const { data, error } = await this.supabase
      .from('memory_history')
      .select('*')
      .eq('memory_id', memoryId)
      .eq('user_id', userId)
      .order('version', { ascending: false });

    if (error) {
      logger.error('Failed to get memory history:', error);
      throw new Error(`Failed to get memory history: ${error.message}`);
    }

    return (data || []).map(this.rowToMemoryHistory.bind(this));
  }

  /**
   * Get all history for a user (recent changes)
   */
  async getUserMemoryHistory(
    userId: string,
    options: { limit?: number; changeType?: 'update' | 'delete' } = {}
  ): Promise<MemoryHistory[]> {
    let query = this.supabase
      .from('memory_history')
      .select('*')
      .eq('user_id', userId)
      .order('archived_at', { ascending: false });

    if (options.changeType) {
      query = query.eq('change_type', options.changeType);
    }

    const limit = options.limit || 50;
    query = query.limit(limit);

    const { data, error } = await query;

    if (error) {
      logger.error('Failed to get user memory history:', error);
      throw new Error(`Failed to get user memory history: ${error.message}`);
    }

    return (data || []).map(this.rowToMemoryHistory.bind(this));
  }

  /**
   * Restore a memory from history (creates new version with old content)
   */
  async restoreMemory(historyId: string, userId: string): Promise<Memory | null> {
    // Get the history entry
    const { data: historyData, error: historyError } = await this.supabase
      .from('memory_history')
      .select('*')
      .eq('id', historyId)
      .eq('user_id', userId)
      .single();

    if (historyError) {
      if (historyError.code === 'PGRST116') return null;
      logger.error('Failed to get history entry:', historyError);
      throw new Error(`Failed to get history entry: ${historyError.message}`);
    }

    const history = this.rowToMemoryHistory(historyData);

    // Check if the original memory still exists
    const existing = await this.getMemory(history.memoryId);

    if (existing) {
      // Update the existing memory with the historical content
      const { data, error } = await this.supabase
        .from('memories')
        .update({
          content: history.content,
          salience: history.salience,
          topics: history.topics,
          metadata: { ...history.metadata, restored_from_version: history.version },
        })
        .eq('id', history.memoryId)
        .eq('user_id', userId)
        .select()
        .single();

      if (error) {
        logger.error('Failed to restore memory:', error);
        throw new Error(`Failed to restore memory: ${error.message}`);
      }

      return this.rowToMemory(data);
    } else {
      // Memory was deleted, recreate it
      const { data, error } = await this.supabase
        .from('memories')
        .insert({
          user_id: userId,
          content: history.content,
          source: history.source,
          salience: history.salience,
          topics: history.topics,
          metadata: { ...history.metadata, restored_from_deleted: true, original_id: history.memoryId },
        })
        .select()
        .single();

      if (error) {
        logger.error('Failed to recreate memory:', error);
        throw new Error(`Failed to recreate memory: ${error.message}`);
      }

      return this.rowToMemory(data);
    }
  }

  // ==================== HELPERS ====================

  private rowToMemory(row: MemoryRow): Memory {
    return {
      id: row.id,
      userId: row.user_id,
      content: row.content,
      source: row.source,
      salience: row.salience,
      topics: row.topics,
      embedding: row.embedding || undefined,
      metadata: row.metadata,
      version: row.version || 1,
      createdAt: new Date(row.created_at),
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
    };
  }

  private rowToMemoryHistory(row: MemoryHistoryRow): MemoryHistory {
    return {
      id: row.id,
      memoryId: row.memory_id,
      userId: row.user_id,
      content: row.content,
      source: row.source,
      salience: row.salience,
      topics: row.topics,
      metadata: row.metadata,
      version: row.version,
      createdAt: new Date(row.created_at),
      archivedAt: new Date(row.archived_at),
      changeType: row.change_type,
    };
  }

  private rowToSession(row: SessionRow): Session {
    return {
      id: row.id,
      userId: row.user_id,
      agentId: row.agent_id || undefined,
      startedAt: new Date(row.started_at),
      endedAt: row.ended_at ? new Date(row.ended_at) : undefined,
      summary: row.summary || undefined,
      metadata: row.metadata,
    };
  }

  private rowToSessionLog(row: SessionLogRow): SessionLog {
    return {
      id: row.id,
      sessionId: row.session_id,
      content: row.content,
      salience: row.salience,
      createdAt: new Date(row.created_at),
    };
  }
}
