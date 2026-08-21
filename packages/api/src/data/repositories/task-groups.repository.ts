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
import type { Database, Json } from '../supabase/types';

export type TaskGroupStatus = 'active' | 'paused' | 'completed' | 'cancelled';
export type TaskGroupPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskGroupOutputTarget = 'spec' | 'pr' | 'report' | 'proposal';
export type TaskGroupOutputStatus = 'ready_for_review' | 'needs_more_work' | 'blocked';
export type StrategyPreset = 'persistence' | 'review' | 'architect' | 'parallel' | 'swarm';
export type VerificationMode = 'self' | 'peer' | 'architect';
export type ExecutionPhase = 'idle' | 'pending_trigger' | 'worker_active' | 'paused' | 'completed';

export interface TaskGroup {
  id: string;
  user_id: string;
  sb_id: string | null;
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
  execution_phase: ExecutionPhase;
  // Workflow graph (spec v10): which executor owns this group's dependencies
  execution_model: 'linear' | 'graph';
  graph_version: number;
  group_number: number;
  slug: string | null;
  outcome: string | null;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
}

export interface StrategyConfig {
  planUri?: string;
  checkInInterval?: number;
  checkInNotify?: string;
  approvalNotify?: string;
  /** Agent to notify for user-facing completion alerts (e.g., "myra" for Telegram relay) */
  userNotify?: string;
  maxIterationsWithoutApproval?: number;
  contextSummaryInterval?: number;
  verificationGates?: string[];
  /** How often (in minutes) the heartbeat should check if the strategy is stuck. Default: 10 */
  watchdogIntervalMinutes?: number;
  /** Supervisor agent identity ID — gets check-in notifications and a final audit on completion */
  supervisorId?: string;
  /** Run the strategy in a sandboxed Docker container */
  sandbox?: boolean;
  /** Sandbox failure policy: 'required' fails the strategy if sandbox can't start, 'preferred' falls back to host (default: 'required') */
  sandboxPolicy?: 'required' | 'preferred';
  /** Backend auth dirs to mount in the sandbox (default: ['claude']) */
  sandboxBackendAuth?: Array<'claude' | 'codex' | 'gemini'>;
  /** Automatically create an ephemeral git worktree + studio for sandbox work (default: false).
   *  When true + sandbox: true, strategy creates a fresh studio at startup and cleans it up on completion. */
  ephemeralStudio?: boolean;
  /** Create a persistent git worktree + studio for the strategy. Unlike ephemeralStudio, the studio
   *  survives strategy completion. Sessions dispatch to it automatically. Mutually exclusive with ephemeralStudio. */
  studioSlug?: string;
  /** Require human approval before finalizing a completed strategy. Pauses with the criteria checklist instead of auto-completing. */
  requireFinalApproval?: boolean;
  /** Human-readable acceptance criteria the approver should verify before approving. Sent in the approval message. */
  approvalCriteria?: string[];
}

export interface CreateTaskGroupInput {
  user_id: string;
  sb_id?: string | null;
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
  sb_id?: string | null;
  project_id?: string | null;
  strategy?: StrategyPreset | null;
  strategy_config?: StrategyConfig;
  verification_mode?: VerificationMode;
  plan_uri?: string | null;
  current_task_index?: number;
  iterations_since_approval?: number;
  strategy_started_at?: string | null;
  strategy_paused_at?: string | null;
  outcome?: string | null;
  conclusion?: string | null;
  execution_phase?: ExecutionPhase;
}

export interface ListTaskGroupsOptions {
  status?: TaskGroupStatus | TaskGroupStatus[];
  projectId?: string;
  sbId?: string;
  autonomousOnly?: boolean;
  strategy?: StrategyPreset;
  limit?: number;
}

export class TaskGroupsRepository {
  constructor(private client: SupabaseClient<Database>) {}

  async create(input: CreateTaskGroupInput): Promise<TaskGroup> {
    const { data, error } = await this.client
      .from('task_groups' as never)
      .insert({
        user_id: input.user_id,
        sb_id: input.sb_id ?? null,
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

    if (options?.sbId) {
      query = query.eq('sb_id', options.sbId);
    }

    if (options?.autonomousOnly) {
      query = query.eq('autonomous', true);
    }

    if (options?.strategy) {
      query = query.eq('strategy', options.strategy);
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
    if (input.sb_id !== undefined) updates.sb_id = input.sb_id;
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
    if (input.outcome !== undefined) updates.outcome = input.outcome;
    if (input.conclusion !== undefined) updates.conclusion = input.conclusion;
    if (input.execution_phase !== undefined) updates.execution_phase = input.execution_phase;

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
  async findActiveStrategies(userId: string, sbId?: string): Promise<TaskGroup[]> {
    let query = this.client
      .from('task_groups' as never)
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active')
      .not('strategy', 'is', null);

    if (sbId) {
      query = query.eq('sb_id', sbId);
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

  // ── Workflow graph (spec: ink://specs/workflow-graph v10, step 1) ──────
  //
  // Both mutations run through SECURITY DEFINER RPCs that lock the group row
  // before reading, CAS graph_version, validate the complete desired graph,
  // and append a task_graph_revisions record — one transaction each. The
  // RPCs return structured refusals ({success:false, reason}) rather than
  // throwing for expected conflicts; transport errors still throw.

  /**
   * Replace the group's edge set with the complete desired graph.
   * Exactly one of actorIdentityId / actorUserId / systemActor must be set.
   */
  async applyTaskGraph(params: {
    userId: string;
    taskGroupId: string;
    expectedVersion: number;
    edges: Array<{ from: string; to: string }>;
    actorIdentityId?: string;
    actorUserId?: string;
    systemActor?: boolean;
    /** Emitting preset/template id ("constructor" in the schema — renamed
     *  here because a `constructor` object key trips TS structural checks). */
    constructorId?: string;
    constructorVersion?: string;
    configHash?: string;
  }): Promise<Record<string, unknown>> {
    const { data, error } = await this.client.rpc('apply_task_graph', {
      p_user_id: params.userId,
      p_task_group_id: params.taskGroupId,
      p_expected_version: params.expectedVersion,
      p_edges: params.edges,
      p_actor_identity_id: params.actorIdentityId ?? null,
      p_actor_user_id: params.actorUserId ?? null,
      p_system_actor: params.systemActor ?? false,
      p_constructor: params.constructorId ?? null,
      p_constructor_version: params.constructorVersion ?? null,
      p_config_hash: params.configHash ?? null,
    });
    if (error) throw new Error(`apply_task_graph failed: ${error.message}`);
    return data as Record<string, unknown>;
  }

  /**
   * Validated linear → graph conversion. Preflight failures come back as
   * {success:false, reason:'preflight-failed', invalid:[...]} and leave the
   * group linear with its blocked_by arrays intact.
   */
  async convertToGraph(params: {
    userId: string;
    taskGroupId: string;
    expectedVersion: number;
    actorIdentityId?: string;
    actorUserId?: string;
    systemActor?: boolean;
  }): Promise<Record<string, unknown>> {
    const { data, error } = await this.client.rpc('convert_task_group_to_graph', {
      p_user_id: params.userId,
      p_task_group_id: params.taskGroupId,
      p_expected_version: params.expectedVersion,
      p_actor_identity_id: params.actorIdentityId ?? null,
      p_actor_user_id: params.actorUserId ?? null,
      p_system_actor: params.systemActor ?? false,
    });
    if (error) throw new Error(`convert_task_group_to_graph failed: ${error.message}`);
    return data as Record<string, unknown>;
  }

  // ── Workflow graph executor (spec v10, steps 2-3) ──────────────────────
  //
  // Same posture as the mutation RPCs: SECURITY DEFINER, task row locked
  // FOR UPDATE + group FOR SHARE, structured refusals for expected
  // conflicts, downstream transitions inside the source transaction.
  // Every mutating RPC returns an `evaluation` (the readiness report) so
  // the caller can dispatch newly-ready nodes post-commit.

  /**
   * Claim a ready node for a session. Returns {success, claimToken} or a
   * structured refusal (not-ready / already-claimed / gate-not-open /
   * approval-gate / group-not-active / not-graph-mode).
   */
  async claimGraphTask(params: {
    userId: string;
    taskId: string;
    sessionId: string;
  }): Promise<Record<string, unknown>> {
    const { data, error } = await this.client.rpc('claim_graph_task', {
      p_user_id: params.userId,
      p_task_id: params.taskId,
      p_session_id: params.sessionId,
    });
    if (error) throw new Error(`claim_graph_task failed: ${error.message}`);
    return data as Record<string, unknown>;
  }

  /**
   * Release (holder, voluntary) or reclaim (sweep, after the app's
   * fail-closed liveness check) a claim. Both CAS on the token.
   */
  async releaseGraphClaim(params: {
    userId: string;
    taskId: string;
    claimToken: string;
    sessionId?: string;
    reclaim?: boolean;
    reason?: string;
  }): Promise<Record<string, unknown>> {
    const { data, error } = await this.client.rpc('release_graph_claim', {
      p_user_id: params.userId,
      p_task_id: params.taskId,
      p_claim_token: params.claimToken,
      p_session_id: params.sessionId ?? null,
      p_reclaim: params.reclaim ?? false,
      p_reason: params.reason ?? null,
    });
    if (error) throw new Error(`release_graph_claim failed: ${error.message}`);
    return data as Record<string, unknown>;
  }

  /**
   * Complete a graph-mode WORK node — claim-token-gated, the only terminal
   * path. Verification nodes refuse ('verification-node'); verdicts go
   * through recordGateVerdict.
   */
  async completeGraphTask(params: {
    userId: string;
    taskId: string;
    sessionId: string;
    claimToken: string;
    outcome: 'completed' | 'failed' | 'skipped';
    reason?: string;
  }): Promise<Record<string, unknown>> {
    const { data, error } = await this.client.rpc('complete_graph_task', {
      p_user_id: params.userId,
      p_task_id: params.taskId,
      p_session_id: params.sessionId,
      p_claim_token: params.claimToken,
      p_outcome: params.outcome,
      p_reason: params.reason ?? null,
    });
    if (error) throw new Error(`complete_graph_task failed: ${error.message}`);
    return data as Record<string, unknown>;
  }

  /**
   * Record a gate verdict. Attempt + gate_version CAS; authority is the
   * claim holder (session + token) for claimed gates, the assignee
   * otherwise. Evidence required to pass, reason required to fail.
   */
  async recordGateVerdict(params: {
    userId: string;
    taskId: string;
    verdict: 'passed' | 'failed';
    expectedAttempt: number;
    expectedGateVersion: number;
    actorIdentityId?: string;
    actorUserId?: string;
    sessionId?: string;
    claimToken?: string;
    evidence?: Record<string, unknown>;
    reason?: string;
  }): Promise<Record<string, unknown>> {
    const { data, error } = await this.client.rpc('record_gate_verdict', {
      p_user_id: params.userId,
      p_task_id: params.taskId,
      p_verdict: params.verdict,
      p_expected_attempt: params.expectedAttempt,
      p_expected_gate_version: params.expectedGateVersion,
      p_actor_identity_id: params.actorIdentityId ?? null,
      p_actor_user_id: params.actorUserId ?? null,
      p_session_id: params.sessionId ?? null,
      p_claim_token: params.claimToken ?? null,
      p_evidence: (params.evidence ?? null) as Json,
      p_reason: params.reason ?? null,
    });
    if (error) throw new Error(`record_gate_verdict failed: ${error.message}`);
    return data as Record<string, unknown>;
  }

  /** Retry a failed gate: new attempt, fresh dwell window, same node. */
  async retryGate(params: {
    userId: string;
    taskId: string;
    expectedAttempt: number;
    actorIdentityId?: string;
    actorUserId?: string;
    reason?: string;
  }): Promise<Record<string, unknown>> {
    const { data, error } = await this.client.rpc('retry_gate', {
      p_user_id: params.userId,
      p_task_id: params.taskId,
      p_expected_attempt: params.expectedAttempt,
      p_actor_identity_id: params.actorIdentityId ?? null,
      p_actor_user_id: params.actorUserId ?? null,
      p_reason: params.reason ?? null,
    });
    if (error) throw new Error(`retry_gate failed: ${error.message}`);
    return data as Record<string, unknown>;
  }

  /**
   * Reconciliation sweep for one active graph group: re-runs the same
   * readiness evaluator (recovering lost dispatches, opening dwelling
   * gates) and reports live claims for the app's liveness check.
   */
  async sweepTaskGraph(params: {
    userId: string;
    taskGroupId: string;
  }): Promise<Record<string, unknown>> {
    const { data, error } = await this.client.rpc('sweep_task_graph', {
      p_user_id: params.userId,
      p_task_group_id: params.taskGroupId,
    });
    if (error) throw new Error(`sweep_task_graph failed: ${error.message}`);
    return data as Record<string, unknown>;
  }

  /** Active graph-mode groups — the sweep's work list. */
  async listActiveGraphGroups(): Promise<Array<{ id: string; user_id: string; title: string }>> {
    const { data, error } = await this.client
      .from('task_groups')
      .select('id, user_id, title')
      .eq('execution_model', 'graph')
      .eq('status', 'active');
    if (error) throw new Error(`Failed to list active graph groups: ${error.message}`);
    return (data ?? []) as Array<{ id: string; user_id: string; title: string }>;
  }

  /** The group's stored edge set (graph-mode groups only have one). */
  async getEdges(taskGroupId: string): Promise<Array<{ from_task: string; to_task: string }>> {
    const { data: tasks, error: tasksError } = await this.client
      .from('tasks')
      .select('id')
      .eq('task_group_id', taskGroupId);
    if (tasksError) throw new Error(`Failed to list group tasks: ${tasksError.message}`);
    const ids = (tasks ?? []).map((t) => t.id);
    if (ids.length === 0) return [];
    const { data, error } = await this.client
      .from('task_edges')
      .select('from_task, to_task')
      .in('to_task', ids);
    if (error) throw new Error(`Failed to read task edges: ${error.message}`);
    return data ?? [];
  }
}
