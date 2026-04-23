/**
 * Activity Stream Repository
 *
 * Handles the unified activity log that captures everything an SB (Synthetically-born Being) does:
 * messages, tool calls, agent spawns, state changes, etc.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';
import type { Json } from '../supabase/types';
import { resolveIdentityId } from '../../auth/resolve-identity';
import { logger } from '../../utils/logger';

export type { Json };

// Activity types from the database enum
export type ActivityType =
  | 'message_in'
  | 'message_out'
  | 'tool_call'
  | 'tool_result'
  | 'agent_spawn'
  | 'agent_complete'
  | 'state_change'
  | 'thinking'
  | 'error';

export type ActivityStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface Activity {
  id: string;
  userId: string;
  sessionId: string | null;
  agentId: string;
  type: ActivityType;
  subtype: string | null;
  content: string;
  payload: Json;
  contactId: string | null;
  parentId: string | null;
  correlationId: string | null;
  platform: string | null;
  platformMessageId: string | null;
  platformChatId: string | null;
  isDm: boolean;
  artifactId: string | null;
  childSessionId: string | null;
  createdAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  status: ActivityStatus;
}

export interface LogActivityInput {
  userId: string;
  agentId: string;
  identityId?: string;
  type: ActivityType;
  content: string;
  sessionId?: string;
  subtype?: string;
  payload?: Json;
  contactId?: string;
  parentId?: string;
  correlationId?: string;
  platform?: string;
  platformMessageId?: string;
  platformChatId?: string;
  isDm?: boolean;
  artifactId?: string;
  childSessionId?: string;
  status?: ActivityStatus;
  /** Link to task group for strategy event correlation */
  taskGroupId?: string;
}

export interface LogMessageInput {
  userId: string;
  agentId: string;
  direction: 'in' | 'out';
  content: string;
  sessionId?: string;
  contactId?: string;
  platform?: string;
  platformMessageId?: string;
  platformChatId?: string;
  isDm?: boolean;
  payload?: Json;
}

export interface GetActivityOptions {
  sessionId?: string;
  agentId?: string;
  types?: ActivityType[];
  contactId?: string;
  platform?: string;
  platformChatId?: string;
  correlationId?: string;
  parentId?: string;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
  includeChildren?: boolean;
}

export interface GetConversationHistoryOptions {
  contactId?: string;
  platform?: string;
  platformChatId?: string;
  isDm?: boolean;
  limit?: number;
  offset?: number;
  since?: Date;
  until?: Date;
}

type ActivityRow = Database['public']['Tables']['activity_stream']['Row'];

export class ActivityStreamRepository {
  constructor(private supabase: SupabaseClient<Database>) {}

  /**
   * Log any activity event
   */
  async logActivity(input: LogActivityInput): Promise<Activity> {
    const identityId = input.identityId
      ? input.identityId
      : await resolveIdentityId(this.supabase, input.userId, input.agentId);

    const { data, error } = await this.supabase
      .from('activity_stream')
      .insert({
        user_id: input.userId,
        agent_id: input.agentId,
        identity_id: identityId,
        type: input.type,
        content: input.content,
        session_id: input.sessionId,
        subtype: input.subtype,
        payload: input.payload || {},
        contact_id: input.contactId,
        parent_id: input.parentId,
        correlation_id: input.correlationId,
        platform: input.platform,
        platform_message_id: input.platformMessageId,
        platform_chat_id: input.platformChatId,
        is_dm: input.isDm ?? true,
        artifact_id: input.artifactId,
        child_session_id: input.childSessionId,
        status: input.status || 'completed',
        task_group_id: input.taskGroupId,
      } as never)
      .select()
      .single();

    if (error) {
      logger.error('Failed to log activity:', error);
      throw new Error(`Failed to log activity: ${error.message}`);
    }

    return this.rowToActivity(data);
  }

  /**
   * Convenience method for logging messages
   */
  async logMessage(input: LogMessageInput): Promise<Activity> {
    return this.logActivity({
      userId: input.userId,
      agentId: input.agentId,
      type: input.direction === 'in' ? 'message_in' : 'message_out',
      content: input.content,
      sessionId: input.sessionId,
      contactId: input.contactId,
      platform: input.platform,
      platformMessageId: input.platformMessageId,
      platformChatId: input.platformChatId,
      isDm: input.isDm,
      payload: input.payload || {},
    });
  }

  /**
   * Mark an activity as completed (for long-running activities like tool_call)
   */
  async completeActivity(
    activityId: string,
    result?: { content?: string; payload?: Json; status?: ActivityStatus }
  ): Promise<Activity> {
    const completedAt = new Date();

    // Get the original activity to calculate duration
    const { data: original, error: fetchError } = await this.supabase
      .from('activity_stream')
      .select('created_at')
      .eq('id', activityId)
      .single();

    if (fetchError) {
      throw new Error(`Failed to fetch activity: ${fetchError.message}`);
    }

    const createdAt = new Date(original.created_at);
    const durationMs = completedAt.getTime() - createdAt.getTime();

    const updateData: Json = {
      completed_at: completedAt.toISOString(),
      duration_ms: durationMs,
      status: result?.status || 'completed',
    };

    if (result?.content) {
      updateData.content = result.content;
    }
    if (result?.payload) {
      updateData.payload = result.payload;
    }

    const { data, error } = await this.supabase
      .from('activity_stream')
      .update(updateData)
      .eq('id', activityId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to complete activity: ${error.message}`);
    }

    return this.rowToActivity(data);
  }

  /**
   * Get activity by ID
   */
  async getActivityById(activityId: string): Promise<Activity | null> {
    const { data, error } = await this.supabase
      .from('activity_stream')
      .select('*')
      .eq('id', activityId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new Error(`Failed to get activity: ${error.message}`);
    }

    return this.rowToActivity(data);
  }

  /**
   * Query activity stream with filters
   */
  async getActivity(userId: string, options: GetActivityOptions = {}): Promise<Activity[]> {
    let query = this.supabase
      .from('activity_stream')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (options.sessionId) {
      query = query.eq('session_id', options.sessionId);
    }
    if (options.agentId) {
      query = query.eq('agent_id', options.agentId);
    }
    if (options.types && options.types.length > 0) {
      query = query.in('type', options.types);
    }
    if (options.contactId) {
      query = query.eq('contact_id', options.contactId);
    }
    if (options.platform) {
      query = query.eq('platform', options.platform);
    }
    if (options.platformChatId) {
      query = query.eq('platform_chat_id', options.platformChatId);
    }
    if (options.correlationId) {
      query = query.eq('correlation_id', options.correlationId);
    }
    if (options.parentId) {
      query = query.eq('parent_id', options.parentId);
    }
    if (options.since) {
      query = query.gte('created_at', options.since.toISOString());
    }
    if (options.until) {
      query = query.lte('created_at', options.until.toISOString());
    }

    // Apply pagination
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    query = query.range(offset, offset + limit - 1);

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to get activity: ${error.message}`);
    }

    return (data || []).map((row) => this.rowToActivity(row));
  }

  /**
   * Get conversation history with a contact or in a chat
   * Returns messages only (message_in and message_out)
   */
  async getConversationHistory(
    userId: string,
    options: GetConversationHistoryOptions = {}
  ): Promise<Activity[]> {
    let query = this.supabase
      .from('activity_stream')
      .select('*')
      .eq('user_id', userId)
      .in('type', ['message_in', 'message_out'])
      .order('created_at', { ascending: true }); // Chronological for conversations

    if (options.contactId) {
      query = query.eq('contact_id', options.contactId);
    }
    if (options.platform) {
      query = query.eq('platform', options.platform);
    }
    if (options.platformChatId) {
      query = query.eq('platform_chat_id', options.platformChatId);
    }
    if (options.isDm !== undefined) {
      query = query.eq('is_dm', options.isDm);
    }
    if (options.since) {
      query = query.gte('created_at', options.since.toISOString());
    }
    if (options.until) {
      query = query.lte('created_at', options.until.toISOString());
    }

    // Apply pagination
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    query = query.range(offset, offset + limit - 1);

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to get conversation history: ${error.message}`);
    }

    return (data || []).map((row) => this.rowToActivity(row));
  }

  /**
   * Get recent activity for session resumption context
   * Returns a mix of messages and significant events
   */
  async getSessionResumptionContext(
    userId: string,
    options: {
      sessionId?: string;
      contactId?: string;
      platform?: string;
      platformChatId?: string;
      limit?: number;
    } = {}
  ): Promise<Activity[]> {
    const limit = options.limit || 20;

    let query = this.supabase
      .from('activity_stream')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    // If we have a session, prioritize that
    if (options.sessionId) {
      query = query.eq('session_id', options.sessionId);
    }

    // If resuming a conversation with a contact or chat
    if (options.contactId) {
      query = query.eq('contact_id', options.contactId);
    }
    if (options.platform) {
      query = query.eq('platform', options.platform);
    }
    if (options.platformChatId) {
      query = query.eq('platform_chat_id', options.platformChatId);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to get session context: ${error.message}`);
    }

    // Return in chronological order for context
    return (data || []).map((row) => this.rowToActivity(row)).reverse();
  }

  /**
   * Count activities matching criteria
   */
  async countActivity(userId: string, options: GetActivityOptions = {}): Promise<number> {
    let query = this.supabase
      .from('activity_stream')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (options.sessionId) {
      query = query.eq('session_id', options.sessionId);
    }
    if (options.agentId) {
      query = query.eq('agent_id', options.agentId);
    }
    if (options.types && options.types.length > 0) {
      query = query.in('type', options.types);
    }
    if (options.contactId) {
      query = query.eq('contact_id', options.contactId);
    }

    const { count, error } = await query;

    if (error) {
      throw new Error(`Failed to count activity: ${error.message}`);
    }

    return count || 0;
  }

  private rowToActivity(row: ActivityRow): Activity {
    return {
      id: row.id,
      userId: row.user_id,
      sessionId: row.session_id,
      agentId: row.agent_id,
      type: row.type as ActivityType,
      subtype: row.subtype,
      content: row.content,
      payload: (row.payload as Json) || {},
      contactId: row.contact_id,
      parentId: row.parent_id,
      correlationId: row.correlation_id,
      platform: row.platform,
      platformMessageId: row.platform_message_id,
      platformChatId: row.platform_chat_id,
      isDm: row.is_dm ?? true,
      artifactId: row.artifact_id,
      childSessionId: row.child_session_id,
      createdAt: new Date(row.created_at),
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
      durationMs: row.duration_ms,
      status: (row.status as ActivityStatus) || 'completed',
    };
  }
}
