/**
 * Task Groups Repository
 *
 * Manages task groups — collections of ordered tasks that can be
 * executed via work strategies (persistence, review, architect, etc.).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';

export type TaskGroupStatus = 'active' | 'paused' | 'completed' | 'cancelled';
export type StrategyPreset = 'persistence' | 'review' | 'architect' | 'parallel' | 'swarm';
export type VerificationMode = 'self' | 'peer' | 'architect';

export interface TaskGroup {
  id: string;
  user_id: string;
  identity_id: string | null;
  project_id: string | null;
  title: string;
  description: string | null;
  status: TaskGroupStatus;
  priority: string;
  tags: string[];
  metadata: Record<string, unknown>;
  autonomous: boolean;
  max_sessions: number | null;
  sessions_used: number;
  context_summary: string | null;
  next_run_after: string | null;
  output_target: string | null;
  output_status: string | null;
  thread_key: string | null;
  // Strategy columns (Phase 1)
  strategy: StrategyPreset | null;
  strategy_config: StrategyConfig;
  verification_mode: VerificationMode;
  plan_uri: string | null;
  current_task_index: number;
  iterations_since_approval: number;
  strategy_started_at: string | null;
  strategy_paused_at: string | null;
  owner_agent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface StrategyConfig {
  planUri?: string;
  checkInInterval?: number;
  checkInNotify?: string;
  approvalNotify?: string;
  maxIterationsWithoutApproval?: number;
  contextSummaryInterval?: number;
  verificationGates?: string[];
  /** How often (in minutes) the heartbeat should check if the strategy is stuck. Default: 10 */
  watchdogIntervalMinutes?: number;
}

export interface CreateTaskGroupInput {
  user_id: string;
  identity_id?: string;
  project_id?: string;
  title: string;
  description?: string;
  priority?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  strategy?: StrategyPreset;
  strategy_config?: StrategyConfig;
  verification_mode?: VerificationMode;
  plan_uri?: string;
  owner_agent_id?: string;
  thread_key?: string;
}

export interface UpdateTaskGroupInput {
  title?: string;
  description?: string;
  status?: TaskGroupStatus;
  priority?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  strategy?: StrategyPreset | null;
  strategy_config?: StrategyConfig;
  verification_mode?: VerificationMode;
  plan_uri?: string;
  current_task_index?: number;
  iterations_since_approval?: number;
  strategy_started_at?: string | null;
  strategy_paused_at?: string | null;
  owner_agent_id?: string | null;
  context_summary?: string;
  autonomous?: boolean;
}

export class TaskGroupsRepository {
  constructor(private client: SupabaseClient<Database>) {}

  async create(input: CreateTaskGroupInput): Promise<TaskGroup> {
    const { data, error } = await this.client
      .from('task_groups' as never)
      .insert({
        user_id: input.user_id,
        identity_id: input.identity_id || null,
        project_id: input.project_id || null,
        title: input.title,
        description: input.description || null,
        priority: input.priority || 'normal',
        tags: input.tags || [],
        metadata: input.metadata || {},
        strategy: input.strategy || null,
        strategy_config: input.strategy_config || {},
        verification_mode: input.verification_mode || 'self',
        plan_uri: input.plan_uri || null,
        owner_agent_id: input.owner_agent_id || null,
        thread_key: input.thread_key || null,
      } as never)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create task group: ${error.message}`);
    }

    return data as unknown as TaskGroup;
  }

  async findById(id: string): Promise<TaskGroup | null> {
    const { data, error } = await this.client
      .from('task_groups' as never)
      .select('*')
      .eq('id', id)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw new Error(`Failed to find task group: ${error.message}`);
    }

    return (data as unknown as TaskGroup) || null;
  }

  async listByUser(
    userId: string,
    options?: {
      status?: TaskGroupStatus | TaskGroupStatus[];
      strategy?: StrategyPreset;
      ownerAgentId?: string;
      limit?: number;
    }
  ): Promise<TaskGroup[]> {
    let query = this.client
      .from('task_groups' as never)
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (options?.status) {
      if (Array.isArray(options.status)) {
        query = query.in('status', options.status);
      } else {
        query = query.eq('status', options.status);
      }
    }

    if (options?.strategy) {
      query = query.eq('strategy', options.strategy);
    }

    if (options?.ownerAgentId) {
      query = query.eq('owner_agent_id', options.ownerAgentId);
    }

    if (options?.limit) {
      query = query.limit(options.limit);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to list task groups: ${error.message}`);
    }

    return (data || []) as unknown as TaskGroup[];
  }

  async update(id: string, input: UpdateTaskGroupInput): Promise<TaskGroup> {
    const { data, error } = await this.client
      .from('task_groups' as never)
      .update(input as never)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update task group: ${error.message}`);
    }

    return data as unknown as TaskGroup;
  }

  /**
   * Archive a task group (soft delete). Groups are never hard-deleted —
   * the execution log must be reproducible.
   */
  async archive(id: string): Promise<TaskGroup> {
    return this.update(id, { status: 'cancelled' });
  }

  /**
   * @deprecated Use archive() instead. Task groups should never be hard-deleted.
   */
  async delete(id: string): Promise<void> {
    await this.archive(id);
  }

  /**
   * Find active strategies for an agent — used by heartbeat recovery
   */
  async findActiveStrategies(userId: string, ownerAgentId?: string): Promise<TaskGroup[]> {
    let query = this.client
      .from('task_groups' as never)
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active')
      .not('strategy', 'is', null);

    if (ownerAgentId) {
      query = query.eq('owner_agent_id', ownerAgentId);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to find active strategies: ${error.message}`);
    }

    return (data || []) as unknown as TaskGroup[];
  }
}
