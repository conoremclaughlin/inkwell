/**
 * Task Groups Repository
 *
 * Manages task_groups: collections of ordered tasks that can be executed via
 * work strategies (persistence, review, architect, etc.). Groups bundle tasks
 * under a shared strategy, thread, and output target. See migrations
 * 20260311021747_task_groups_unify_tasks_permissions.sql and the strategy
 * columns added in Phase 1.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';

export type TaskGroupStatus = 'active' | 'paused' | 'completed' | 'cancelled';
export type TaskGroupPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskGroupOutputTarget = 'spec' | 'pr' | 'report' | 'proposal';
export type TaskGroupOutputStatus = 'ready_for_review' | 'needs_more_work' | 'blocked';
export type StrategyPreset = 'persistence' | 'review' | 'architect' | 'parallel' | 'swarm';
export type VerificationMode = 'self' | 'peer' | 'architect';

export interface TaskGroup {
  id: string;
  user_id: string;
  identity_id: string | null;
  project_id: string | null;
  title: string;
  description: string | null;
  instructions: string | null;
  status: TaskGroupStatus;
  priority: TaskGroupPriority;
  tags: string[];
  metadata: Record<string, unknown>;
  autonomous: boolean;
  max_sessions: number | null;
  sessions_used: number;
  context_summary: string | null;
  next_run_after: string | null;
  output_target: TaskGroupOutputTarget | null;
  output_status: TaskGroupOutputStatus | null;
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
  /** Supervisor agent identity ID — gets check-in notifications and a final audit on completion */
  supervisorId?: string;
}

export interface CreateTaskGroupInput {
  user_id: string;
  identity_id?: string | null;
  project_id?: string | null;
  title: string;
  description?: string;
  instructions?: string;
  status?: TaskGroupStatus;
  priority?: TaskGroupPriority;
  tags?: string[];
  metadata?: Record<string, unknown>;
  autonomous?: boolean;
  max_sessions?: number;
  context_summary?: string;
  next_run_after?: string;
  output_target?: TaskGroupOutputTarget;
  output_status?: TaskGroupOutputStatus;
  thread_key?: string;
  strategy?: StrategyPreset;
  strategy_config?: StrategyConfig;
  verification_mode?: VerificationMode;
  plan_uri?: string;
  owner_agent_id?: string;
}

export interface UpdateTaskGroupInput {
  title?: string;
  description?: string | null;
  instructions?: string | null;
  status?: TaskGroupStatus;
  priority?: TaskGroupPriority;
  tags?: string[];
  metadata?: Record<string, unknown>;
  autonomous?: boolean;
  max_sessions?: number | null;
  sessions_used?: number;
  context_summary?: string | null;
  next_run_after?: string | null;
  output_target?: TaskGroupOutputTarget | null;
  output_status?: TaskGroupOutputStatus | null;
  thread_key?: string | null;
  identity_id?: string | null;
  project_id?: string | null;
  strategy?: StrategyPreset | null;
  strategy_config?: StrategyConfig;
  verification_mode?: VerificationMode;
  plan_uri?: string | null;
  current_task_index?: number;
  iterations_since_approval?: number;
  strategy_started_at?: string | null;
  strategy_paused_at?: string | null;
  owner_agent_id?: string | null;
}

export interface ListTaskGroupsOptions {
  status?: TaskGroupStatus | TaskGroupStatus[];
  projectId?: string;
  identityId?: string;
  autonomousOnly?: boolean;
  strategy?: StrategyPreset;
  ownerAgentId?: string;
  limit?: number;
}

export class TaskGroupsRepository {
  constructor(private client: SupabaseClient<Database>) {}

  async create(input: CreateTaskGroupInput): Promise<TaskGroup> {
    const { data, error } = await this.client
      .from('task_groups' as never)
      .insert({
        user_id: input.user_id,
        identity_id: input.identity_id ?? null,
        project_id: input.project_id ?? null,
        title: input.title,
        description: input.description,
        instructions: input.instructions ?? null,
        status: input.status || 'active',
        priority: input.priority || 'normal',
        tags: input.tags || [],
        metadata: input.metadata || {},
        autonomous: input.autonomous ?? false,
        max_sessions: input.max_sessions ?? null,
        context_summary: input.context_summary,
        next_run_after: input.next_run_after,
        output_target: input.output_target ?? null,
        output_status: input.output_status ?? null,
        thread_key: input.thread_key,
        strategy: input.strategy ?? null,
        strategy_config: input.strategy_config ?? {},
        verification_mode: input.verification_mode ?? 'self',
        plan_uri: input.plan_uri ?? null,
        owner_agent_id: input.owner_agent_id ?? null,
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

  async listByUser(userId: string, options?: ListTaskGroupsOptions): Promise<TaskGroup[]> {
    let query = this.client
      .from('task_groups' as never)
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (options?.status) {
      if (Array.isArray(options.status)) {
        query = query.in('status', options.status);
      } else {
        query = query.eq('status', options.status);
      }
    }

    if (options?.projectId) {
      query = query.eq('project_id', options.projectId);
    }

    if (options?.identityId) {
      query = query.eq('identity_id', options.identityId);
    }

    if (options?.autonomousOnly) {
      query = query.eq('autonomous', true);
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
    const updates: Record<string, unknown> = {};
    if (input.title !== undefined) updates.title = input.title;
    if (input.description !== undefined) updates.description = input.description;
    if (input.instructions !== undefined) updates.instructions = input.instructions;
    if (input.status !== undefined) updates.status = input.status;
    if (input.priority !== undefined) updates.priority = input.priority;
    if (input.tags !== undefined) updates.tags = input.tags;
    if (input.metadata !== undefined) updates.metadata = input.metadata;
    if (input.autonomous !== undefined) updates.autonomous = input.autonomous;
    if (input.max_sessions !== undefined) updates.max_sessions = input.max_sessions;
    if (input.sessions_used !== undefined) updates.sessions_used = input.sessions_used;
    if (input.context_summary !== undefined) updates.context_summary = input.context_summary;
    if (input.next_run_after !== undefined) updates.next_run_after = input.next_run_after;
    if (input.output_target !== undefined) updates.output_target = input.output_target;
    if (input.output_status !== undefined) updates.output_status = input.output_status;
    if (input.thread_key !== undefined) updates.thread_key = input.thread_key;
    if (input.identity_id !== undefined) updates.identity_id = input.identity_id;
    if (input.project_id !== undefined) updates.project_id = input.project_id;
    if (input.strategy !== undefined) updates.strategy = input.strategy;
    if (input.strategy_config !== undefined) updates.strategy_config = input.strategy_config;
    if (input.verification_mode !== undefined) updates.verification_mode = input.verification_mode;
    if (input.plan_uri !== undefined) updates.plan_uri = input.plan_uri;
    if (input.current_task_index !== undefined)
      updates.current_task_index = input.current_task_index;
    if (input.iterations_since_approval !== undefined)
      updates.iterations_since_approval = input.iterations_since_approval;
    if (input.strategy_started_at !== undefined)
      updates.strategy_started_at = input.strategy_started_at;
    if (input.strategy_paused_at !== undefined)
      updates.strategy_paused_at = input.strategy_paused_at;
    if (input.owner_agent_id !== undefined) updates.owner_agent_id = input.owner_agent_id;

    const { data, error } = await this.client
      .from('task_groups' as never)
      .update(updates as never)
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

  /**
   * Count tasks per group id. Returns a map keyed by group id.
   * Counts cover all tasks regardless of status — callers can filter if needed.
   */
  async taskCountsByGroup(
    userId: string,
    groupIds: string[]
  ): Promise<
    Record<
      string,
      { total: number; pending: number; in_progress: number; completed: number; blocked: number }
    >
  > {
    if (groupIds.length === 0) return {};

    const { data, error } = await this.client
      .from('tasks')
      .select('task_group_id, status')
      .eq('user_id', userId)
      .in('task_group_id', groupIds);

    if (error) {
      throw new Error(`Failed to aggregate task counts: ${error.message}`);
    }

    const counts: Record<
      string,
      { total: number; pending: number; in_progress: number; completed: number; blocked: number }
    > = {};
    for (const row of (data || []) as Array<{ task_group_id: string | null; status: string }>) {
      if (!row.task_group_id) continue;
      const bucket =
        counts[row.task_group_id] ||
        (counts[row.task_group_id] = {
          total: 0,
          pending: 0,
          in_progress: 0,
          completed: 0,
          blocked: 0,
        });
      bucket.total += 1;
      if (row.status === 'pending') bucket.pending += 1;
      else if (row.status === 'in_progress') bucket.in_progress += 1;
      else if (row.status === 'completed') bucket.completed += 1;
      else if (row.status === 'blocked') bucket.blocked += 1;
    }
    return counts;
  }
}
