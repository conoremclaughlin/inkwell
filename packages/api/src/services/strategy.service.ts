/**
 * Strategy Service
 *
 * Core business logic for work strategies. Manages the lifecycle of
 * strategy execution: start, advance, pause, resume, check-in, approval.
 *
 * The persistence strategy loop:
 *   Agent works task → complete_task → advanceStrategy → next task injected
 *   → agent continues in same session → repeat
 *
 * Session continuation model: the agent stays in the same backend session.
 * New sessions are only created by heartbeat recovery if one dies.
 */

import type { DataComposer } from '../data/composer';
import type {
  TaskGroup,
  StrategyPreset,
  StrategyConfig,
  VerificationMode,
} from '../data/repositories/task-groups.repository';
import type { ProjectTask } from '../data/repositories/project-tasks.repository';
import { handleSendToInbox } from '../mcp/tools/inbox-handlers';
import { logger } from '../utils/logger';

// ============================================================================
// Types
// ============================================================================

export interface StartStrategyInput {
  groupId: string;
  userId: string;
  strategy: StrategyPreset;
  ownerAgentId: string;
  config?: StrategyConfig;
  verificationMode?: VerificationMode;
  planUri?: string;
}

export interface StrategyAdvanceResult {
  /** What happened after completing the task */
  action: 'next_task' | 'check_in' | 'approval_required' | 'group_complete';
  /** The next task to work on (if action is next_task or check_in) */
  nextTask?: ProjectTask;
  /** Strategy prompt injection for the agent */
  prompt?: string;
  /** Progress summary for check-ins */
  progressSummary?: string;
  /** Whether a notification was sent to the dispatcher */
  notified?: boolean;
  /** Completion stats when group is done */
  stats?: { total: number; completed: number };
}

export interface StrategyStatus {
  groupId: string;
  title: string;
  strategy: StrategyPreset;
  status: string;
  ownerAgentId: string | null;
  planUri: string | null;
  verificationMode: VerificationMode;
  currentTaskIndex: number;
  iterationsSinceApproval: number;
  strategyStartedAt: string | null;
  strategyPausedAt: string | null;
  config: StrategyConfig;
  progress: {
    total: number;
    completed: number;
    pending: number;
    inProgress: number;
    blocked: number;
    completionRate: number;
  };
  currentTask: {
    id: string;
    title: string;
    status: string;
    taskOrder: number | null;
  } | null;
  /** Human-friendly summary for dispatcher forwarding (Myra's request) */
  summary: string;
}

// ============================================================================
// Strategy Prompts
// ============================================================================

const STRATEGY_PROMPTS: Record<StrategyPreset, (group: TaskGroup, task: ProjectTask) => string> = {
  persistence: (group, task) => {
    const config = group.strategy_config as StrategyConfig;
    const parts = [
      `You're working through task group "${group.title}" autonomously using the persistence strategy.`,
    ];

    if (group.plan_uri) {
      parts.push(
        `The full plan is at ${group.plan_uri} — refer to it for architectural decisions and context.`
      );
    }

    parts.push(
      `Your current task is #${(task.task_order ?? 0) + 1}: "${task.title}"${task.description ? ` — ${task.description}` : ''}.`
    );

    parts.push('When you finish this task, call complete_task to advance to the next one.');

    if (config.checkInInterval) {
      parts.push(`Post a progress check-in every ${config.checkInInterval} tasks.`);
    }

    if (config.verificationGates?.length) {
      parts.push(`Before advancing, verify: ${config.verificationGates.join(', ')}.`);
    }

    return parts.join(' ');
  },

  // Phase 2+ presets — stubs for now
  review: (_group, task) =>
    `You're reviewing work. Current item: "${task.title}". Read the diff, check against the spec, post feedback.`,

  architect: (_group, task) =>
    `You're the worker in an architect strategy. Implement task: "${task.title}". Request verification from the architect when done.`,

  parallel: (_group, task) =>
    `You're working task "${task.title}" in parallel with other agents. Coordinate via thread messages.`,

  swarm: (_group, task) =>
    `You're part of a swarm strategy working on "${task.title}". Check for updates from other swarm members.`,
};

// ============================================================================
// Service
// ============================================================================

export class StrategyService {
  constructor(private dataComposer: DataComposer) {}

  /**
   * Activate a strategy on a task group.
   * Sets the group to active, records the strategy preset, and returns the first task.
   */
  async startStrategy(input: StartStrategyInput): Promise<StrategyAdvanceResult> {
    const group = await this.dataComposer.repositories.taskGroups.findById(input.groupId);
    if (!group) throw new Error('Task group not found');
    if (group.user_id !== input.userId) throw new Error('Task group does not belong to this user');

    if (group.strategy && group.status === 'active') {
      throw new Error(
        `Strategy "${group.strategy}" is already active on this group. Pause it first.`
      );
    }

    // Update the group with strategy config
    const updated = await this.dataComposer.repositories.taskGroups.update(input.groupId, {
      strategy: input.strategy,
      strategy_config: input.config || (group.strategy_config as StrategyConfig),
      verification_mode: input.verificationMode || group.verification_mode,
      plan_uri: input.planUri || group.plan_uri || undefined,
      owner_agent_id: input.ownerAgentId,
      status: 'active',
      autonomous: true,
      current_task_index: 0,
      iterations_since_approval: 0,
      strategy_started_at: new Date().toISOString(),
      strategy_paused_at: null,
    });

    // Get the first task
    const nextTask = await this.getTaskByOrder(input.groupId, 0);

    if (!nextTask) {
      // Empty group with planUri — agent should decompose from the plan
      if (updated.plan_uri) {
        return {
          action: 'next_task',
          prompt: `Task group "${updated.title}" has no tasks yet. Read the plan at ${updated.plan_uri}, decompose it into tasks using create_task, then start working.`,
        };
      }
      return {
        action: 'group_complete',
        stats: { total: 0, completed: 0 },
      };
    }

    // Mark the first task as in_progress
    await this.dataComposer.repositories.tasks.startTask(nextTask.id);

    const prompt = STRATEGY_PROMPTS[input.strategy](updated, nextTask);

    return {
      action: 'next_task',
      nextTask,
      prompt,
    };
  }

  /**
   * Called after complete_task. Determines what happens next:
   * advance to next task, check in, request approval, or finish.
   */
  async advanceStrategy(
    groupId: string,
    _completedTaskId: string,
    userId: string
  ): Promise<StrategyAdvanceResult> {
    const group = await this.dataComposer.repositories.taskGroups.findById(groupId);
    if (!group || !group.strategy || group.status !== 'active') {
      // No active strategy — nothing to advance
      return { action: 'group_complete' };
    }

    const config = group.strategy_config as StrategyConfig;
    const newIndex = group.current_task_index + 1;
    const newIterations = group.iterations_since_approval + 1;

    // Update counters
    await this.dataComposer.repositories.taskGroups.update(groupId, {
      current_task_index: newIndex,
      iterations_since_approval: newIterations,
    });

    // Check approval gate
    const maxIterations = config.maxIterationsWithoutApproval;
    if (maxIterations && newIterations >= maxIterations) {
      const summary = await this.buildProgressSummary(group, newIndex);

      // Pause for approval
      await this.dataComposer.repositories.taskGroups.update(groupId, {
        strategy_paused_at: new Date().toISOString(),
        status: 'paused',
        context_summary: summary,
      });

      // Notify dispatcher
      const notified = await this.notifyDispatcher(
        group,
        config.approvalNotify,
        `Approval needed: completed ${newIterations} tasks in "${group.title}". ${summary}`,
        userId
      );

      return {
        action: 'approval_required',
        progressSummary: summary,
        notified,
      };
    }

    // Get next task
    const nextTask = await this.getTaskByOrder(groupId, newIndex);

    if (!nextTask) {
      // All tasks done
      const tasks = await this.getGroupTasks(groupId);
      const completed = tasks.filter((t) => t.status === 'completed').length;

      await this.dataComposer.repositories.taskGroups.update(groupId, {
        status: 'completed',
        context_summary: `Strategy complete. ${completed}/${tasks.length} tasks done.`,
      });

      // Notify dispatcher of completion
      await this.notifyDispatcher(
        group,
        config.checkInNotify || config.approvalNotify,
        `Strategy "${group.strategy}" complete on "${group.title}": ${completed}/${tasks.length} tasks finished.`,
        userId
      );

      return {
        action: 'group_complete',
        stats: { total: tasks.length, completed },
      };
    }

    // Mark next task as in_progress
    await this.dataComposer.repositories.tasks.startTask(nextTask.id);

    // Check if it's time for a check-in
    if (config.checkInInterval && newIndex > 0 && newIndex % config.checkInInterval === 0) {
      const summary = await this.buildProgressSummary(group, newIndex);

      // Save summary for context recovery
      await this.dataComposer.repositories.taskGroups.update(groupId, {
        context_summary: summary,
      });

      // Notify dispatcher
      const notified = await this.notifyDispatcher(
        group,
        config.checkInNotify,
        `Check-in on "${group.title}": ${summary}`,
        userId
      );

      const prompt = STRATEGY_PROMPTS[group.strategy as StrategyPreset](
        { ...group, current_task_index: newIndex } as TaskGroup,
        nextTask
      );

      return {
        action: 'check_in',
        nextTask,
        prompt,
        progressSummary: summary,
        notified,
      };
    }

    // Normal advance
    const updatedGroup = { ...group, current_task_index: newIndex } as TaskGroup;
    const prompt = STRATEGY_PROMPTS[group.strategy as StrategyPreset](updatedGroup, nextTask);

    return {
      action: 'next_task',
      nextTask,
      prompt,
    };
  }

  /**
   * Pause an active strategy.
   */
  async pauseStrategy(groupId: string, userId: string): Promise<TaskGroup> {
    const group = await this.dataComposer.repositories.taskGroups.findById(groupId);
    if (!group) throw new Error('Task group not found');
    if (group.user_id !== userId) throw new Error('Task group does not belong to this user');
    if (group.status !== 'active') throw new Error('Strategy is not active');

    return this.dataComposer.repositories.taskGroups.update(groupId, {
      status: 'paused',
      strategy_paused_at: new Date().toISOString(),
    });
  }

  /**
   * Resume a paused strategy. Resets the approval counter and returns the next task.
   */
  async resumeStrategy(groupId: string, userId: string): Promise<StrategyAdvanceResult> {
    const group = await this.dataComposer.repositories.taskGroups.findById(groupId);
    if (!group) throw new Error('Task group not found');
    if (group.user_id !== userId) throw new Error('Task group does not belong to this user');
    if (group.status !== 'paused') throw new Error('Strategy is not paused');
    if (!group.strategy) throw new Error('No strategy set on this group');

    await this.dataComposer.repositories.taskGroups.update(groupId, {
      status: 'active',
      strategy_paused_at: null,
      iterations_since_approval: 0,
    });

    const nextTask = await this.getTaskByOrder(groupId, group.current_task_index);

    if (!nextTask) {
      return { action: 'group_complete', stats: { total: 0, completed: 0 } };
    }

    // Mark as in_progress if not already
    if (nextTask.status !== 'in_progress') {
      await this.dataComposer.repositories.tasks.startTask(nextTask.id);
    }

    const updatedGroup = { ...group, status: 'active' as const } as TaskGroup;
    const prompt = STRATEGY_PROMPTS[group.strategy as StrategyPreset](updatedGroup, nextTask);

    return {
      action: 'next_task',
      nextTask,
      prompt,
    };
  }

  /**
   * Get comprehensive strategy status with human-friendly summary.
   */
  async getStrategyStatus(groupId: string, userId: string): Promise<StrategyStatus> {
    const group = await this.dataComposer.repositories.taskGroups.findById(groupId);
    if (!group) throw new Error('Task group not found');
    if (group.user_id !== userId) throw new Error('Task group does not belong to this user');

    const tasks = await this.getGroupTasks(groupId);
    const completed = tasks.filter((t) => t.status === 'completed').length;
    const pending = tasks.filter((t) => t.status === 'pending').length;
    const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
    const blocked = tasks.filter((t) => t.status === 'blocked').length;
    const total = tasks.length;
    const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

    // Find current task
    const currentTask = tasks.find(
      (t) =>
        t.status === 'in_progress' ||
        (t.task_order === group.current_task_index && t.status === 'pending')
    );

    // Build human-friendly summary
    const summaryParts = [
      `"${group.title}"`,
      `${completed}/${total} tasks done (${completionRate}%)`,
    ];
    if (group.status === 'paused') {
      summaryParts.push(group.iterations_since_approval > 0 ? 'paused for approval' : 'paused');
    } else if (currentTask) {
      summaryParts.push(`working on: "${currentTask.title}"`);
    }

    return {
      groupId: group.id,
      title: group.title,
      strategy: group.strategy as StrategyPreset,
      status: group.status,
      ownerAgentId: group.owner_agent_id,
      planUri: group.plan_uri,
      verificationMode: group.verification_mode,
      currentTaskIndex: group.current_task_index,
      iterationsSinceApproval: group.iterations_since_approval,
      strategyStartedAt: group.strategy_started_at,
      strategyPausedAt: group.strategy_paused_at,
      config: group.strategy_config as StrategyConfig,
      progress: { total, completed, pending, inProgress, blocked, completionRate },
      currentTask: currentTask
        ? {
            id: currentTask.id,
            title: currentTask.title,
            status: currentTask.status,
            taskOrder: currentTask.task_order ?? null,
          }
        : null,
      summary: summaryParts.join(' — '),
    };
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  /**
   * Get the task at a specific order index within a group.
   */
  private async getTaskByOrder(groupId: string, orderIndex: number): Promise<ProjectTask | null> {
    // First try exact task_order match
    const { data: ordered, error: orderedErr } = await this.dataComposer
      .getClient()
      .from('tasks')
      .select('*')
      .eq('task_group_id', groupId)
      .eq('task_order', orderIndex)
      .in('status', ['pending', 'in_progress'])
      .limit(1)
      .single();

    if (ordered && !orderedErr) {
      return ordered as unknown as ProjectTask;
    }

    // Fall back to Nth pending task by created_at (for groups without explicit ordering)
    const { data: fallback } = await this.dataComposer
      .getClient()
      .from('tasks')
      .select('*')
      .eq('task_group_id', groupId)
      .in('status', ['pending', 'in_progress'])
      .order('task_order', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .limit(1);

    return fallback?.[0] ? (fallback[0] as unknown as ProjectTask) : null;
  }

  /**
   * Get all tasks in a group, ordered.
   */
  private async getGroupTasks(groupId: string): Promise<ProjectTask[]> {
    const { data, error } = await this.dataComposer
      .getClient()
      .from('tasks')
      .select('*')
      .eq('task_group_id', groupId)
      .order('task_order', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to get group tasks: ${error.message}`);
    }

    return (data || []) as unknown as ProjectTask[];
  }

  /**
   * Build a human-readable progress summary for check-ins and approval gates.
   */
  private async buildProgressSummary(group: TaskGroup, _currentIndex: number): Promise<string> {
    const tasks = await this.getGroupTasks(group.id);
    const completed = tasks.filter((t) => t.status === 'completed');
    const remaining = tasks.filter((t) => t.status !== 'completed');

    const parts = [
      `Progress on "${group.title}": ${completed.length}/${tasks.length} tasks completed.`,
    ];

    if (completed.length > 0) {
      const recentDone = completed.slice(-3).map((t) => t.title);
      parts.push(`Recently completed: ${recentDone.join(', ')}.`);
    }

    if (remaining.length > 0) {
      const nextUp = remaining.slice(0, 3).map((t) => t.title);
      parts.push(`Next up: ${nextUp.join(', ')}.`);
    }

    return parts.join(' ');
  }

  /**
   * Send a notification to a dispatcher agent via the inbox/thread machinery.
   * Routes through handleSendToInbox for proper thread continuity and trigger behavior.
   * Returns true if notification was sent, false if no dispatcher configured.
   */
  private async notifyDispatcher(
    group: TaskGroup,
    notifyAgentId: string | undefined,
    message: string,
    userId: string
  ): Promise<boolean> {
    if (!notifyAgentId) return false;

    try {
      const threadKey = group.thread_key || `strategy:${group.id}`;

      await handleSendToInbox(
        {
          userId,
          recipientAgentId: notifyAgentId,
          senderAgentId: group.owner_agent_id || 'system',
          content: message,
          messageType: 'notification',
          priority: 'high',
          threadKey,
          triggerSummary: `Strategy ${group.strategy}: ${group.title}`,
          triggerType: 'message',
          metadata: {
            groupId: group.id,
            strategy: group.strategy,
            groupTitle: group.title,
            source: 'strategy_service',
          },
        },
        this.dataComposer
      );

      logger.info(`Strategy notification sent to ${notifyAgentId} for group ${group.id}`);
      return true;
    } catch (err) {
      logger.warn('Strategy notification failed:', err);
      return false;
    }
  }
}
