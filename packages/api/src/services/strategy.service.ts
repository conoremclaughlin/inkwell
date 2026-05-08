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
import { getRequestContext } from '../utils/request-context';
import type {
  TaskGroup,
  StrategyPreset,
  StrategyConfig,
  VerificationMode,
} from '../data/repositories/task-groups.repository';
import type { ProjectTask } from '../data/repositories/project-tasks.repository';
import { handleSendToInbox } from '../mcp/tools/inbox-handlers';
import { logger } from '../utils/logger';
import type { SandboxOrchestrator, SandboxSpinUpResult } from './sandbox/orchestrator';

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
  /** Sandbox container info (when sandbox mode is active) */
  sandbox?: SandboxSpinUpResult;
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
      `Task group ID: ${group.id}.`,
    ];

    // Process conventions — critical for autonomous work
    parts.push(
      "IMPORTANT: You MUST follow the project's CONTRIBUTING.md and AGENTS.md conventions. This includes: feature branches (never push to main), PR process (separate PRs per feature), commit conventions, and review requirements. Read these files if you haven't already."
    );

    if (group.instructions) {
      parts.push(`\n\n## Instructions\n${group.instructions}\n\n`);
    }

    if (group.plan_uri) {
      parts.push(
        `The full plan is at ${group.plan_uri} — refer to it for architectural decisions and context.`
      );
    }

    parts.push(
      `Your current task is #${(task.task_order ?? 0) + 1}: "${task.title}"${task.description ? ` — ${task.description}` : ''}.`
    );

    parts.push(
      `When you finish this task, call complete_task(taskId: "${task.id}") to advance to the next one. The system will return your next task automatically.`
    );

    // Task completion rules
    parts.push(
      'You must complete every task in order. Do NOT skip tasks or defer them without explicit approval from the human or architect. If a task is blocked, mark it as blocked and explain why — do not self-justify skipping it.'
    );

    if (config.checkInInterval) {
      parts.push(`Post a progress check-in every ${config.checkInInterval} tasks.`);
    }

    if (config.verificationGates?.length) {
      parts.push(`Before advancing, verify: ${config.verificationGates.join(', ')}.`);
    }

    parts.push(
      'When a task requires notifying or requesting action from another agent, use send_to_inbox with messageType: "task_request" (not "message") so they get triggered immediately. Use triggerAgents to target specific agents if needed.'
    );

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
  private sandboxOrchestrator?: SandboxOrchestrator;

  constructor(dataComposer: DataComposer, sandboxOrchestrator?: SandboxOrchestrator);
  constructor(
    private dataComposer: DataComposer,
    orchestrator?: SandboxOrchestrator
  ) {
    this.sandboxOrchestrator = orchestrator;
  }

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

    // Create a watchdog reminder so the heartbeat checks progress periodically
    await this.createWatchdogReminder(updated, input.userId);

    // Spin up sandbox BEFORE triggering the agent — if sandboxPolicy is
    // 'required' (default), a failed sandbox aborts the strategy instead
    // of silently degrading to host execution.
    const config = updated.strategy_config as StrategyConfig;
    const sandboxResult = await this.maybeSpinUpSandbox(updated);
    const sandboxPolicy = config.sandboxPolicy || 'required';

    if (config.sandbox && sandboxResult && !sandboxResult.success && sandboxPolicy === 'required') {
      // Fail-closed: revert the strategy to paused and report the failure
      await this.dataComposer.repositories.taskGroups.update(input.groupId, {
        status: 'paused',
        strategy_paused_at: new Date().toISOString(),
      });
      await this.logStrategyEvent(
        updated,
        'sandbox_failed',
        `Strategy aborted: sandbox required but spin-up failed — ${sandboxResult.error}`,
        {
          containerName: sandboxResult.containerName,
          error: sandboxResult.error,
          policy: 'required',
        }
      );
      return {
        action: 'group_complete',
        stats: { total: 0, completed: 0 },
        prompt: `Sandbox spin-up failed (policy: required). Error: ${sandboxResult.error}. Strategy has been paused — fix the sandbox configuration and retry.`,
        sandbox: sandboxResult,
      };
    }

    // Trigger the owner agent in the assigned studio. The trigger spawns
    // (or resumes) a session in the target studio so work actually begins.
    // Pass the sandbox container name so the triggered session routes
    // CLI execution into the container.
    const sandboxContainer = sandboxResult?.success ? sandboxResult.containerName : undefined;
    const triggered = await this.triggerOwnerAgent(
      updated,
      nextTask,
      'strategy_kickoff',
      sandboxContainer
    );

    // Log strategy start
    await this.logStrategyEvent(
      updated,
      'strategy_started',
      `Strategy "${input.strategy}" started on "${updated.title}"`,
      {
        firstTaskId: nextTask.id,
        firstTaskTitle: nextTask.title,
        ownerTriggered: triggered,
        sandbox: sandboxResult
          ? { containerName: sandboxResult.containerName, success: sandboxResult.success }
          : undefined,
      }
    );

    const prompt = STRATEGY_PROMPTS[input.strategy](updated, nextTask);

    return {
      action: 'next_task',
      nextTask,
      prompt,
      notified: triggered,
      sandbox: sandboxResult || undefined,
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

      // Pause for approval — set pauseReason so resumeStrategy can distinguish
      // approval-gate pauses from manual pauses (Lumen review, PR #338)
      await this.dataComposer.repositories.taskGroups.update(groupId, {
        strategy_paused_at: new Date().toISOString(),
        status: 'paused',
        context_summary: summary,
        metadata: { ...group.metadata, pauseReason: 'approval_gate' },
      });

      // Notify dispatcher
      const notified = await this.notifyDispatcher(
        group,
        config.approvalNotify,
        `Approval needed: completed ${newIterations} tasks in "${group.title}". ${summary}`,
        userId
      );

      await this.logStrategyEvent(
        group,
        'approval_required',
        `Approval gate: ${newIterations} tasks completed without approval`,
        {
          iterationsSinceApproval: newIterations,
          progressSummary: summary,
          routedTo: config.approvalNotify || null,
          notified,
        }
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
      // No more pending/in_progress tasks — strategy is done
      const tasks = await this.getGroupTasks(groupId);
      const completed = tasks.filter((t) => t.status === 'completed').length;
      const pending = tasks.filter((t) => t.status === 'pending').length;
      const blocked = tasks.filter((t) => t.status === 'blocked').length;

      // Integrity check: flag if tasks are still pending/blocked
      const hasIncomplete = pending > 0 || blocked > 0;
      if (hasIncomplete) {
        await this.logStrategyEvent(
          group,
          'process_violation',
          `Strategy completing with ${pending} pending and ${blocked} blocked tasks out of ${tasks.length} total`,
          {
            totalTasks: tasks.length,
            completedTasks: completed,
            pendingTasks: pending,
            blockedTasks: blocked,
            skippedTasks: tasks
              .filter((t) => t.status === 'pending' || t.status === 'blocked')
              .map((t) => ({ id: t.id, title: t.title, status: t.status })),
          }
        );
      }

      await this.dataComposer.repositories.taskGroups.update(groupId, {
        status: 'completed',
        context_summary: hasIncomplete
          ? `Strategy complete with issues: ${completed}/${tasks.length} done, ${pending} pending, ${blocked} blocked.`
          : `Strategy complete. ${completed}/${tasks.length} tasks done.`,
      });

      // Cancel watchdog — strategy is done
      await this.cancelWatchdogReminder(group.id);

      await this.logStrategyEvent(
        group,
        'strategy_completed',
        `Strategy complete: ${completed}/${tasks.length} tasks done`,
        {
          totalTasks: tasks.length,
          completedTasks: completed,
          pendingTasks: pending,
          blockedTasks: blocked,
          hasIncomplete,
        }
      );

      // Notify dispatcher of completion
      await this.notifyDispatcher(
        group,
        config.checkInNotify || config.approvalNotify,
        `Strategy "${group.strategy}" complete on "${group.title}": ${completed}/${tasks.length} tasks finished.${hasIncomplete ? ` WARNING: ${pending} pending, ${blocked} blocked tasks remain.` : ''}`,
        userId
      );

      // Notify supervisor for final audit (if configured)
      if (config.supervisorId) {
        const supervisorSlug = await this.resolveAgentSlug(config.supervisorId);
        if (supervisorSlug) {
          await this.notifyDispatcher(
            group,
            supervisorSlug,
            `[Supervisor audit] Strategy "${group.strategy}" on "${group.title}" is complete. ${completed}/${tasks.length} tasks done.${hasIncomplete ? ` PROCESS VIOLATION: ${pending} pending, ${blocked} blocked tasks were not completed.` : ''} Review the activity stream for task_group_id ${group.id}.`,
            userId
          );
        }
      }

      return {
        action: 'group_complete',
        stats: { total: tasks.length, completed },
      };
    }

    // Mark next task as in_progress
    await this.dataComposer.repositories.tasks.startTask(nextTask.id);

    // Log task advancement
    await this.logStrategyEvent(
      group,
      'task_advanced',
      `Advanced to task #${newIndex + 1}: "${nextTask.title}"`,
      {
        taskId: nextTask.id,
        taskTitle: nextTask.title,
        taskIndex: newIndex,
      }
    );

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

      // Notify supervisor at check-in points too
      if (config.supervisorId) {
        const supervisorSlug = await this.resolveAgentSlug(config.supervisorId);
        if (supervisorSlug) {
          await this.notifyDispatcher(
            group,
            supervisorSlug,
            `[Supervisor check-in] "${group.title}": ${summary} Review activity stream for task_group_id ${group.id}.`,
            userId
          );
        }
      }

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

    // Cancel watchdog while paused
    await this.cancelWatchdogReminder(groupId);

    await this.logStrategyEvent(group, 'strategy_paused', `Strategy paused on "${group.title}"`);

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

    const wasAwaitingApproval = group.metadata?.pauseReason === 'approval_gate';

    // Clear pauseReason on resume so it doesn't persist into the next pause cycle
    const cleanedMetadata = { ...group.metadata };
    delete cleanedMetadata.pauseReason;

    await this.dataComposer.repositories.taskGroups.update(groupId, {
      status: 'active',
      strategy_paused_at: null,
      iterations_since_approval: 0,
      metadata: cleanedMetadata,
    });

    // Re-create watchdog reminder
    await this.createWatchdogReminder(group, userId);

    await this.logStrategyEvent(
      group,
      wasAwaitingApproval ? 'approval_granted' : 'strategy_resumed',
      wasAwaitingApproval
        ? `Approval granted after ${group.iterations_since_approval} iterations on "${group.title}"`
        : `Strategy resumed on "${group.title}"`,
      wasAwaitingApproval ? { iterationsSinceApproval: group.iterations_since_approval } : undefined
    );

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
   * Cancel a strategy. Transitions a non-terminal group to the `cancelled`
   * terminal state, cancels the watchdog, and logs a reason. Idempotent-adjacent:
   * already-cancelled groups throw; completed groups throw (they're terminal).
   */
  async cancelStrategy(groupId: string, userId: string, reason?: string): Promise<TaskGroup> {
    const group = await this.dataComposer.repositories.taskGroups.findById(groupId);
    if (!group) throw new Error('Task group not found');
    if (group.user_id !== userId) throw new Error('Task group does not belong to this user');
    if (group.status === 'completed') throw new Error('Strategy is already completed');
    if (group.status === 'cancelled') throw new Error('Strategy is already cancelled');

    await this.cancelWatchdogReminder(groupId);

    const summary = reason
      ? `Strategy cancelled on "${group.title}": ${reason}`
      : `Strategy cancelled on "${group.title}"`;

    await this.logStrategyEvent(group, 'strategy_cancelled', summary, {
      reason: reason || null,
      previousStatus: group.status,
    });

    return this.dataComposer.repositories.taskGroups.update(groupId, {
      status: 'cancelled',
      strategy_paused_at: null,
    });
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

  /**
   * Trigger the strategy's owner agent with a task-aware prompt, routed to the
   * studio the group is assigned to. Used for:
   *   - startStrategy kickoff (spawn a session in the target studio so the agent
   *     starts working without the user having to manually attach)
   *   - watchdog re-triggers (wake a stuck session on the heartbeat)
   *
   * No-ops with a warn log if the group has no owner_agent_id. Non-fatal on
   * send failure — returns false so callers can decide whether to escalate.
   */
  private async triggerOwnerAgent(
    group: TaskGroup,
    task: ProjectTask,
    reason: 'strategy_kickoff' | 'watchdog' | 'manual_resume',
    sandboxContainerName?: string
  ): Promise<boolean> {
    if (!group.owner_agent_id) {
      logger.warn(
        `Strategy triggerOwnerAgent: group ${group.id} has no owner_agent_id — cannot route trigger`
      );
      return false;
    }
    if (!group.strategy) {
      logger.warn(
        `Strategy triggerOwnerAgent: group ${group.id} has no strategy set — cannot build prompt`
      );
      return false;
    }

    try {
      const threadKey = group.thread_key || `strategy:${group.id}`;
      const metadata = (group.metadata || {}) as Record<string, unknown>;
      const rawStudioId = metadata.studioId;
      const rawStudioSlug = metadata.studioSlug;
      const studioId = typeof rawStudioId === 'string' ? rawStudioId : undefined;
      const studioSlug = typeof rawStudioSlug === 'string' ? rawStudioSlug : undefined;
      const content = STRATEGY_PROMPTS[group.strategy as StrategyPreset](group, task);

      await handleSendToInbox(
        {
          userId: group.user_id,
          recipientAgentId: group.owner_agent_id,
          senderAgentId: 'system',
          // Prefer studioId (UUID); fall back to slug only when UUID is absent.
          recipientStudioId: studioId,
          recipientStudioSlug: studioId ? undefined : studioSlug,
          content,
          messageType: 'session_resume',
          priority: 'high',
          threadKey,
          trigger: true,
          triggerType: 'message',
          triggerSummary: `Strategy "${group.strategy}" — ${reason === 'strategy_kickoff' ? 'start' : 'continue'}: ${task.title}`,
          metadata: {
            source: 'strategy_service',
            strategyTrigger: true,
            reason,
            groupId: group.id,
            taskId: task.id,
            strategy: group.strategy,
            ...(sandboxContainerName ? { sandboxContainerName } : {}),
          },
        },
        this.dataComposer
      );

      logger.info(
        `Strategy trigger sent to ${group.owner_agent_id} for group ${group.id} (task ${task.id}, reason: ${reason}${studioId ? `, studio: ${studioId}` : studioSlug ? `, studioSlug: ${studioSlug}` : ''})`
      );

      await this.logStrategyEvent(
        group,
        'strategy_trigger',
        `Triggered ${group.owner_agent_id} for task: ${task.title}`,
        {
          reason,
          taskId: task.id,
          taskTitle: task.title,
          studioId: studioId || studioSlug || null,
          ownerAgentId: group.owner_agent_id,
        }
      );

      return true;
    } catch (err) {
      logger.warn(
        `Strategy triggerOwnerAgent failed for group ${group.id} (reason: ${reason}):`,
        err
      );

      // Log trigger failure to activity stream too
      this.logStrategyEvent(
        group,
        'strategy_trigger_failed',
        `Failed to trigger ${group.owner_agent_id} for task: ${task.title}`,
        {
          reason,
          taskId: task.id,
          error: err instanceof Error ? err.message : String(err),
        }
      ).catch(() => {});

      return false;
    }
  }

  /**
   * Spin up a sandbox Docker container for the strategy's owner agent.
   * Resolves the studio from DB metadata, builds a SandboxSpinUpRequest,
   * and delegates to the orchestrator. Returns null if sandbox mode is
   * not enabled or no orchestrator is configured.
   */
  private async maybeSpinUpSandbox(group: TaskGroup): Promise<SandboxSpinUpResult | null> {
    const config = group.strategy_config as StrategyConfig;
    if (!config.sandbox) return null;

    if (!this.sandboxOrchestrator) {
      const msg = `Sandbox enabled but no SandboxOrchestrator configured`;
      logger.warn(`Strategy group ${group.id}: ${msg}`);
      return { containerName: '', success: false, error: msg };
    }

    const metadata = (group.metadata || {}) as Record<string, unknown>;
    const studioId = typeof metadata.studioId === 'string' ? metadata.studioId : undefined;
    if (!studioId) {
      const msg = `Sandbox requested but no studioId in metadata`;
      logger.warn(`Strategy group ${group.id}: ${msg}`);
      return { containerName: '', success: false, error: msg };
    }

    const studio = await this.dataComposer.repositories.studios.findById(studioId);
    if (!studio) {
      const msg = `Studio ${studioId} not found`;
      logger.warn(`Strategy group ${group.id}: ${msg}`);
      return { containerName: '', success: false, error: msg };
    }

    const result = await this.sandboxOrchestrator.spinUp({
      userId: group.user_id,
      agentId: group.owner_agent_id || studio.agentId || 'unknown',
      studioId: studio.id,
      studioSlug: studio.slug || undefined,
      worktreePath: studio.worktreePath,
      repoRoot: studio.repoRoot,
      branch: studio.branch,
      taskGroupId: group.id,
      taskGroupTitle: group.title,
      taskGroupContext: group.context_summary || undefined,
      taskGroupThreadKey: group.thread_key || `strategy:${group.id}`,
      backendAuth: (config.sandboxBackendAuth as any) || ['claude'],
    });

    if (result.success) {
      await this.logStrategyEvent(
        group,
        'sandbox_started',
        `Sandbox container started: ${result.containerName}`,
        {
          containerName: result.containerName,
          studioId: studio.id,
          alreadyRunning: result.alreadyRunning,
        }
      );
    } else {
      await this.logStrategyEvent(
        group,
        'sandbox_failed',
        `Sandbox spin-up failed: ${result.error}`,
        { containerName: result.containerName, error: result.error }
      );
    }

    return result;
  }

  /**
   * Public entry point for watchdog-driven triggers. Called from the heartbeat
   * reminder-delivery path when a scheduled_reminder has
   * metadata.strategyWatchdog === true.
   *
   * Loads the referenced group + its current in-progress task, skips if the
   * strategy is no longer active or there is no pending work, then routes a
   * task-aware prompt to the owner agent in the assigned studio.
   *
   * Returns true on successful trigger (reminder should be marked delivered).
   * Returns false when the watchdog decides no action is needed — the heartbeat
   * treats this as a failed delivery today, which re-runs the cron next tick.
   * That's acceptable for now; the strategy will either become active again
   * (next tick triggers) or be cancelled (watchdog reminder is cancelled).
   */
  async triggerWatchdog(groupId: string): Promise<boolean> {
    const group = await this.dataComposer.repositories.taskGroups.findById(groupId);
    if (!group) {
      logger.warn(`Strategy watchdog: group ${groupId} not found, skipping`);
      return false;
    }

    // Log every cron wakeup so we can trace heartbeat frequency in the activity stream.
    // Awaited on skip paths (cheap, early return); fire-and-forget on the trigger path.
    await this.logStrategyEvent(
      group,
      'watchdog_wakeup',
      `Watchdog cron fired for "${group.title}"`,
      { groupStatus: group.status, strategy: group.strategy }
    );

    if (group.status !== 'active' || !group.strategy) {
      logger.info(
        `Strategy watchdog: group ${groupId} is ${group.status} (strategy=${group.strategy ?? 'null'}), skipping`
      );
      await this.logStrategyEvent(
        group,
        'watchdog_skip',
        `Watchdog skipped: group is ${group.status}`,
        { reason: 'inactive_group' }
      );
      return false;
    }

    // Find the current in-progress task. If none, fall back to the next
    // pending task at current_task_index.
    const tasks = await this.getGroupTasks(groupId);
    let currentTask = tasks.find((t) => t.status === 'in_progress') || null;
    if (!currentTask) {
      currentTask = await this.getTaskByOrder(groupId, group.current_task_index);
    }
    if (!currentTask) {
      logger.info(
        `Strategy watchdog: group ${groupId} has no in_progress or pending task, skipping`
      );
      await this.logStrategyEvent(
        group,
        'watchdog_skip',
        `Watchdog skipped: no pending/in-progress task`,
        {
          reason: 'no_current_task',
          currentTaskIndex: group.current_task_index,
        }
      );
      return false;
    }

    return this.triggerOwnerAgent(group, currentTask, 'watchdog');
  }

  /**
   * Create a recurring watchdog reminder linked to the strategy.
   * The heartbeat picks this up periodically and checks if the strategy is stuck.
   */
  private async createWatchdogReminder(group: TaskGroup, userId: string): Promise<void> {
    const config = group.strategy_config as StrategyConfig;
    const intervalMinutes = config.watchdogIntervalMinutes || 10;

    try {
      const nextRunAt = new Date();
      nextRunAt.setMinutes(nextRunAt.getMinutes() + intervalMinutes);

      // Capture the Ink session ID from request context — the watchdog can check
      // if this session is still active before re-triggering (avoids interrupting
      // an agent that's already working the strategy).
      const reqCtx = getRequestContext();
      const inkSessionId = reqCtx?.sessionId || null;

      // Look up the backend session ID too (for future "is generation active" checks)
      let backendSessionId: string | null = null;
      if (inkSessionId) {
        const { data: session } = await this.dataComposer
          .getClient()
          .from('sessions')
          .select('backend_session_id')
          .eq('id', inkSessionId)
          .single();
        if (session)
          backendSessionId = (session as { backend_session_id: string | null }).backend_session_id;
      }

      // Resolve the owner agent's identity for reminder routing
      let identityId: string | null = null;
      if (group.owner_agent_id) {
        const { data: identity } = await this.dataComposer
          .getClient()
          .from('agent_identities')
          .select('id')
          .eq('agent_id', group.owner_agent_id)
          .eq('user_id', userId)
          .limit(1)
          .single();
        if (identity) identityId = identity.id;
      }

      await this.dataComposer
        .getClient()
        .from('scheduled_reminders')
        .insert({
          user_id: userId,
          title: `Strategy watchdog: "${group.title}"`,
          description: [
            `Check progress on task group ${group.id} (strategy: ${group.strategy}).`,
            `Use get_strategy_status(groupId: "${group.id}") to check progress.`,
            inkSessionId
              ? `The strategy was started in session ${inkSessionId}. If that session is still active, the agent is likely still working — no action needed.`
              : null,
            'If the strategy is stuck (no progress since last check and no active session), re-trigger the owner agent on the thread.',
            group.thread_key ? `Thread: ${group.thread_key}` : null,
          ]
            .filter(Boolean)
            .join(' '),
          identity_id: identityId,
          cron_expression: `*/${intervalMinutes} * * * *`,
          next_run_at: nextRunAt.toISOString(),
          status: 'active',
          metadata: {
            strategyWatchdog: true,
            groupId: group.id,
            strategy: group.strategy,
            ownerAgentId: group.owner_agent_id,
            threadKey: group.thread_key,
            inkSessionId,
            backendSessionId,
          },
        } as never);

      logger.info(`Strategy watchdog created for group ${group.id} (every ${intervalMinutes}min)`);
    } catch (err) {
      // Non-fatal — the strategy still works without the watchdog
      logger.warn('Failed to create strategy watchdog reminder:', err);
    }
  }

  /**
   * Cancel the watchdog reminder for a strategy (on pause/complete).
   */
  private async cancelWatchdogReminder(groupId: string): Promise<void> {
    try {
      await this.dataComposer
        .getClient()
        .from('scheduled_reminders')
        .update({ status: 'cancelled' } as never)
        .contains('metadata' as never, { strategyWatchdog: true, groupId } as never);

      logger.info(`Strategy watchdog cancelled for group ${groupId}`);
    } catch (err) {
      logger.warn('Failed to cancel strategy watchdog reminder:', err);
    }
  }

  /**
   * Resolve an identity UUID to an agent_id slug for notification routing.
   * notifyDispatcher/handleSendToInbox accept slugs, but we store identity UUIDs.
   */
  private async resolveAgentSlug(identityId: string): Promise<string | null> {
    try {
      const { data } = await this.dataComposer
        .getClient()
        .from('agent_identities')
        .select('agent_id')
        .eq('id', identityId)
        .single();
      return data ? (data as { agent_id: string }).agent_id : null;
    } catch {
      return null;
    }
  }

  /**
   * Log a strategy event to the activity stream.
   * Links to the task group via task_group_id for dashboard correlation.
   */
  private async logStrategyEvent(
    group: TaskGroup,
    subtype: string,
    content: string,
    payload?: Record<string, unknown>
  ): Promise<void> {
    try {
      const reqCtx = getRequestContext();
      await this.dataComposer.repositories.activityStream.logActivity({
        userId: group.user_id,
        agentId: group.owner_agent_id || 'system',
        type: 'state_change',
        subtype,
        content,
        sessionId: reqCtx?.sessionId,
        taskGroupId: group.id,
        payload: {
          groupId: group.id,
          groupTitle: group.title,
          strategy: group.strategy,
          ...payload,
        } as unknown as import('../data/repositories/activity-stream.repository').Json,
        status: 'completed',
      });
    } catch (err) {
      // Non-fatal — don't block strategy operations for logging failures
      logger.warn('Failed to log strategy event:', err);
    }
  }
}
