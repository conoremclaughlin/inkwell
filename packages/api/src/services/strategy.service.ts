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

import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import type { DataComposer } from '../data/composer';
import { getRequestContext } from '../utils/request-context';
import type {
  TaskGroup,
  StrategyPreset,
  StrategyConfig,
  VerificationMode,
} from '../data/repositories/task-groups.repository';
import type { ProjectTask, TaskAssignment } from '../data/repositories/project-tasks.repository';
import { handleSendToInbox } from '../mcp/tools/inbox-handlers';
import { resolveAgentSlug } from '../auth/resolve-identity';
import { logger } from '../utils/logger';
import { ensureStudioSettings } from './studio-settings';
import type { SandboxOrchestrator, SandboxSpinUpResult } from './sandbox/orchestrator';

const execFileAsync = promisify(execFile);

// ============================================================================
// Types
// ============================================================================

export type ExecutionMode = 'spawn' | 'inline';

export interface StartStrategyInput {
  groupId: string;
  userId: string;
  strategy: StrategyPreset;
  sbId: string;
  config?: StrategyConfig;
  verificationMode?: VerificationMode;
  planUri?: string;
  executionMode?: ExecutionMode;
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
  /** How execution was requested: 'spawn' (new session) or 'inline' (current session loops) */
  executionMode?: ExecutionMode;
}

export interface StrategyStatus {
  groupId: string;
  title: string;
  strategy: StrategyPreset;
  status: string;
  executionPhase: string;
  sbId: string | null;
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

  private getAssignment(group: TaskGroup): TaskAssignment {
    const meta = group.metadata as Record<string, unknown> | null;
    return {
      studioId: (meta?.studioId as string) || undefined,
    };
  }

  private async resolveOwnerSlug(group: TaskGroup): Promise<string | null> {
    if (!group.sb_id) return null;
    return resolveAgentSlug(this.dataComposer.getClient(), group.sb_id);
  }

  /**
   * Activate a strategy on a task group.
   * Sets the group to active, records the strategy preset, and returns the first task.
   */
  async startStrategy(input: StartStrategyInput): Promise<StrategyAdvanceResult> {
    let group = await this.dataComposer.repositories.taskGroups.findById(input.groupId);
    if (!group) throw new Error('Task group not found');
    if (group.user_id !== input.userId) throw new Error('Task group does not belong to this user');

    if (group.strategy && group.status === 'active') {
      throw new Error(
        `Strategy "${group.strategy}" is already active on this group. Pause it first.`
      );
    }

    // Validate mutual exclusivity before any side effects
    const inputConfig = input.config || (group.strategy_config as StrategyConfig);
    if (inputConfig?.studioSlug && inputConfig?.ephemeralStudio) {
      throw new Error('studioSlug and ephemeralStudio are mutually exclusive');
    }

    // ── Resolve repoRoot ──
    // Required for spawn mode so the spawner knows where to start the session.
    // Resolution chain: group metadata → project repo_root → caller's session context.
    const groupMeta = (group.metadata || {}) as Record<string, unknown>;
    let resolvedRepoRoot = typeof groupMeta.repoRoot === 'string' ? groupMeta.repoRoot : undefined;

    if (!resolvedRepoRoot && group.project_id) {
      const project = await this.dataComposer.repositories.projects.findById(group.project_id);
      if (project?.repo_root) {
        resolvedRepoRoot = project.repo_root;
      }
    }

    if (!resolvedRepoRoot) {
      const reqCtx = getRequestContext();
      if (reqCtx?.repoRoot) {
        resolvedRepoRoot = reqCtx.repoRoot;
      }
    }

    const executionMode = input.executionMode || 'spawn';
    if (!resolvedRepoRoot && executionMode === 'spawn') {
      throw new Error(
        'Cannot start strategy in spawn mode: no repoRoot found. ' +
          'Set repo_root on the project, repoRoot in group metadata, or call from a session with a known repo context.'
      );
    }

    // Persist resolved repoRoot to group metadata so downstream studio creation
    // and trigger routing have it available without re-resolving.
    if (resolvedRepoRoot && groupMeta.repoRoot !== resolvedRepoRoot) {
      await this.dataComposer.repositories.taskGroups.update(input.groupId, {
        metadata: { ...groupMeta, repoRoot: resolvedRepoRoot },
      });
      // Refresh local reference so studio creation sees the updated metadata
      group = (await this.dataComposer.repositories.taskGroups.findById(input.groupId)) || group;
    }

    // Persistent studio: create BEFORE activating the strategy so (a) failure
    // doesn't leave an active group in a broken state, and (b) the group update
    // below returns metadata that includes the new studioId for sandbox routing.
    if (inputConfig?.studioSlug) {
      const metadata = (group.metadata || {}) as Record<string, unknown>;
      if (!metadata.studioId) {
        const ownerSlug = input.sbId
          ? await resolveAgentSlug(this.dataComposer.getClient(), input.sbId)
          : null;
        if (!ownerSlug) {
          throw new Error('Could not resolve agent slug for persistent studio branch naming');
        }
        const created = await this.createPersistentStudio(group, inputConfig.studioSlug, ownerSlug);
        if (!created) {
          throw new Error(
            `Failed to create persistent studio "${inputConfig.studioSlug}" — check repoRoot in group metadata`
          );
        }
      }
    }

    // Update the group with strategy config
    const updated = await this.dataComposer.repositories.taskGroups.update(input.groupId, {
      strategy: input.strategy,
      strategy_config: input.config || (group.strategy_config as StrategyConfig),
      verification_mode: input.verificationMode || group.verification_mode,
      plan_uri: input.planUri || group.plan_uri || undefined,
      sb_id: input.sbId,
      status: 'active',
      autonomous: true,
      current_task_index: 0,
      iterations_since_approval: 0,
      strategy_started_at: new Date().toISOString(),
      strategy_paused_at: null,
      execution_phase: executionMode === 'inline' ? 'worker_active' : 'pending_trigger',
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

    // Create a watchdog reminder so the heartbeat checks progress periodically
    await this.createWatchdogReminder(updated, input.userId);

    // Spin up sandbox BEFORE triggering the agent — if sandboxPolicy is
    // 'required' (default), a failed sandbox aborts the strategy instead
    // of silently degrading to host execution.
    // Note: maybeSpinUpSandbox may create an ephemeral studio and update
    // group metadata in the DB, so we re-read the group afterward.
    const config = updated.strategy_config as StrategyConfig;
    const sandboxResult = await this.maybeSpinUpSandbox(updated);
    const sandboxPolicy = config.sandboxPolicy || 'required';

    if (config.sandbox && sandboxResult && !sandboxResult.success && sandboxPolicy === 'required') {
      // Fail-closed: revert the strategy to paused and report the failure
      await this.dataComposer.repositories.taskGroups.update(input.groupId, {
        status: 'paused',
        strategy_paused_at: new Date().toISOString(),
        execution_phase: 'paused',
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

    // Re-read group after sandbox setup — createEphemeralStudio may have
    // written studioId/studioSlug to metadata that triggerOwnerAgent needs
    // for correct studio routing.
    const currentGroup =
      (await this.dataComposer.repositories.taskGroups.findById(input.groupId)) || updated;

    // Mark the first task as in_progress with assignment metadata.
    // Done after sandbox setup so the assignment reflects the ephemeral studioId.
    await this.dataComposer.repositories.tasks.startTask(
      nextTask.id,
      this.getAssignment(currentGroup)
    );

    // In 'inline' mode the calling agent will loop in the current session —
    // skip the trigger entirely (no spawn needed).
    let triggered = false;
    const sandboxContainer = sandboxResult?.success ? sandboxResult.containerName : undefined;

    if (executionMode === 'spawn') {
      triggered = await this.triggerOwnerAgent(
        currentGroup,
        nextTask,
        'strategy_kickoff',
        sandboxContainer
      );
    }

    // Log strategy start
    await this.logStrategyEvent(
      currentGroup,
      'strategy_started',
      `Strategy "${input.strategy}" started on "${currentGroup.title}" (executionMode: ${executionMode})`,
      {
        executionMode,
        firstTaskId: nextTask.id,
        firstTaskTitle: nextTask.title,
        ownerTriggered: triggered,
        sandbox: sandboxResult
          ? { containerName: sandboxResult.containerName, success: sandboxResult.success }
          : undefined,
      }
    );

    const prompt = STRATEGY_PROMPTS[input.strategy](currentGroup, nextTask);

    return {
      action: 'next_task',
      nextTask,
      prompt,
      notified: triggered,
      executionMode,
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

    // Check for completion BEFORE the periodic approval gate — final-task
    // handling must win over maxIterationsWithoutApproval (Lumen review, PR #362)
    const nextTask = await this.getTaskByOrder(groupId, newIndex);

    if (!nextTask) {
      // No more pending/in_progress tasks — strategy is done (or needs final approval)
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

      // Final approval gate — pause for human review instead of auto-completing
      if (config.requireFinalApproval) {
        const summary = await this.buildProgressSummary(group, newIndex);
        const criteria = config.approvalCriteria || [];
        const criteriaList =
          criteria.length > 0
            ? `\n\nAcceptance criteria:\n${criteria.map((c) => `• ${c}`).join('\n')}`
            : '';

        await this.cancelWatchdogReminder(groupId);
        await this.dataComposer.repositories.taskGroups.update(groupId, {
          strategy_paused_at: new Date().toISOString(),
          status: 'paused',
          execution_phase: 'paused',
          context_summary: summary,
          metadata: { ...group.metadata, pauseReason: 'final_review' },
        });

        const approvalMessage =
          `All tasks complete on "${group.title}" (${completed}/${tasks.length}).` +
          `${hasIncomplete ? ` WARNING: ${pending} pending, ${blocked} blocked tasks remain.` : ''}` +
          ` Awaiting final approval before closing.${criteriaList}\n\n${summary}`;

        const notified = await this.notifyDispatcher(
          group,
          config.approvalNotify || config.checkInNotify,
          approvalMessage,
          userId
        );

        // Notify supervisor too if configured
        if (config.supervisorId) {
          const supervisorSlug = await resolveAgentSlug(
            this.dataComposer.getClient(),
            config.supervisorId
          );
          if (supervisorSlug) {
            await this.notifyDispatcher(
              group,
              supervisorSlug,
              `[Supervisor] Final review requested on "${group.title}". ${completed}/${tasks.length} tasks done.${criteriaList}`,
              userId
            );
          }
        }

        if (config.userNotify) {
          await this.notifyDispatcher(
            group,
            config.userNotify,
            `All tasks complete on "${group.title}" (${completed}/${tasks.length}). Awaiting final review.`,
            userId
          );
        }

        await this.logStrategyEvent(
          group,
          'final_review_requested',
          `All tasks done — paused for final approval`,
          {
            totalTasks: tasks.length,
            completedTasks: completed,
            approvalCriteria: criteria,
            notified,
            routedTo: config.approvalNotify || config.checkInNotify || null,
            userNotified: config.userNotify || null,
          }
        );

        return {
          action: 'approval_required',
          progressSummary: approvalMessage,
          notified,
        };
      }

      // No final approval needed — complete immediately
      await this.finalizeStrategy(
        group,
        { total: tasks.length, completed, pending, blocked, hasIncomplete },
        config,
        userId
      );

      return {
        action: 'group_complete',
        stats: { total: tasks.length, completed },
      };
    }

    // Check periodic approval gate (only when there ARE more tasks to do)
    const maxIterations = config.maxIterationsWithoutApproval;
    if (maxIterations && newIterations >= maxIterations) {
      const summary = await this.buildProgressSummary(group, newIndex);

      // Pause for approval — set pauseReason so resumeStrategy can distinguish
      // approval-gate pauses from manual pauses (Lumen review, PR #338)
      await this.cancelWatchdogReminder(groupId);
      await this.dataComposer.repositories.taskGroups.update(groupId, {
        strategy_paused_at: new Date().toISOString(),
        status: 'paused',
        execution_phase: 'paused',
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

    // Mark next task as in_progress with assignment metadata
    await this.dataComposer.repositories.tasks.startTask(nextTask.id, this.getAssignment(group));

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
        const supervisorSlug = await resolveAgentSlug(
          this.dataComposer.getClient(),
          config.supervisorId
        );
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
      execution_phase: 'paused',
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

    const pauseReason = (group.metadata as Record<string, unknown>)?.pauseReason;
    const wasAwaitingApproval = pauseReason === 'approval_gate';
    const wasFinalReview = pauseReason === 'final_review';

    // Clear pauseReason on resume so it doesn't persist into the next pause cycle
    const cleanedMetadata = { ...group.metadata } as Record<string, unknown>;
    delete cleanedMetadata.pauseReason;

    // Final review approval — all tasks done, finalize the strategy
    if (wasFinalReview) {
      const config = group.strategy_config as StrategyConfig;
      const tasks = await this.getGroupTasks(groupId);
      const completed = tasks.filter((t) => t.status === 'completed').length;
      const pending = tasks.filter((t) => t.status === 'pending').length;
      const blocked = tasks.filter((t) => t.status === 'blocked').length;
      const hasIncomplete = pending > 0 || blocked > 0;

      await this.logStrategyEvent(
        group,
        'final_review_approved',
        `Final review approved on "${group.title}" — finalizing strategy`,
        { completedTasks: completed, totalTasks: tasks.length }
      );

      // Set back to active briefly so finalizeStrategy can complete it cleanly
      await this.dataComposer.repositories.taskGroups.update(groupId, {
        status: 'active',
        strategy_paused_at: null,
        metadata: cleanedMetadata,
      });

      await this.finalizeStrategy(
        { ...group, metadata: cleanedMetadata },
        { total: tasks.length, completed, pending, blocked, hasIncomplete },
        config,
        userId
      );

      return { action: 'group_complete', stats: { total: tasks.length, completed } };
    }

    await this.dataComposer.repositories.taskGroups.update(groupId, {
      status: 'active',
      strategy_paused_at: null,
      iterations_since_approval: 0,
      metadata: cleanedMetadata,
      execution_phase: 'pending_trigger',
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
      // No more tasks — finalize the strategy (handles the case where the
      // periodic approval gate fired on the final task, Lumen review PR #362)
      const config = group.strategy_config as StrategyConfig;
      const tasks = await this.getGroupTasks(groupId);
      const completed = tasks.filter((t) => t.status === 'completed').length;
      const pending = tasks.filter((t) => t.status === 'pending').length;
      const blocked = tasks.filter((t) => t.status === 'blocked').length;
      const hasIncomplete = pending > 0 || blocked > 0;

      if (config.requireFinalApproval) {
        // Still need final review — re-pause with final_review reason
        const summary = await this.buildProgressSummary(group, group.current_task_index);
        const criteria = config.approvalCriteria || [];
        const criteriaList =
          criteria.length > 0
            ? `\n\nAcceptance criteria:\n${criteria.map((c) => `• ${c}`).join('\n')}`
            : '';

        await this.dataComposer.repositories.taskGroups.update(groupId, {
          strategy_paused_at: new Date().toISOString(),
          status: 'paused',
          context_summary: summary,
          metadata: { ...cleanedMetadata, pauseReason: 'final_review' },
          execution_phase: 'paused',
        });

        const approvalMessage =
          `All tasks complete on "${group.title}" (${completed}/${tasks.length}).` +
          `${hasIncomplete ? ` WARNING: ${pending} pending, ${blocked} blocked tasks remain.` : ''}` +
          ` Awaiting final approval before closing.${criteriaList}\n\n${summary}`;

        const notified = await this.notifyDispatcher(
          group,
          config.approvalNotify || config.checkInNotify,
          approvalMessage,
          group.user_id
        );

        return { action: 'approval_required', progressSummary: approvalMessage, notified };
      }

      await this.finalizeStrategy(
        { ...group, metadata: cleanedMetadata },
        { total: tasks.length, completed, pending, blocked, hasIncomplete },
        config,
        group.user_id
      );

      return { action: 'group_complete', stats: { total: tasks.length, completed } };
    }

    // Mark as in_progress if not already
    if (nextTask.status !== 'in_progress') {
      await this.dataComposer.repositories.tasks.startTask(nextTask.id, this.getAssignment(group));
    }

    const updatedGroup = { ...group, status: 'active' as const } as TaskGroup;
    const prompt = STRATEGY_PROMPTS[group.strategy as StrategyPreset](updatedGroup, nextTask);

    // Auto-trigger the owner agent so resume doesn't require a separate trigger call
    const triggered = await this.triggerOwnerAgent(updatedGroup, nextTask, 'manual_resume');

    return {
      action: 'next_task',
      nextTask,
      prompt,
      notified: triggered,
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

    await this.cleanupStrategyResources(groupId);

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
      execution_phase: 'idle',
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
    } else if (group.execution_phase === 'pending_trigger') {
      summaryParts.push('awaiting session spawn');
    } else if (currentTask) {
      summaryParts.push(`working on: "${currentTask.title}"`);
    }

    return {
      groupId: group.id,
      title: group.title,
      strategy: group.strategy as StrategyPreset,
      status: group.status,
      executionPhase: group.execution_phase,
      sbId: group.sb_id,
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
      const senderSlug = (await this.resolveOwnerSlug(group)) || 'system';

      await handleSendToInbox(
        {
          userId,
          recipientAgentId: notifyAgentId,
          senderAgentId: senderSlug,
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
   * No-ops with a warn log if the group has no sb_id. Non-fatal on
   * send failure — returns false so callers can decide whether to escalate.
   */
  private async triggerOwnerAgent(
    group: TaskGroup,
    task: ProjectTask,
    reason: 'strategy_kickoff' | 'watchdog' | 'manual_resume',
    sandboxContainerName?: string
  ): Promise<boolean> {
    if (!group.sb_id) {
      logger.warn(
        `Strategy triggerOwnerAgent: group ${group.id} has no sb_id — cannot route trigger`
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
      const ownerSlug = await this.resolveOwnerSlug(group);
      if (!ownerSlug) {
        logger.warn(`Strategy triggerOwnerAgent: could not resolve slug for sb_id ${group.sb_id}`);
        return false;
      }

      const threadKey = group.thread_key || `strategy:${group.id}`;
      const metadata = (group.metadata || {}) as Record<string, unknown>;
      const rawStudioId = metadata.studioId;
      const rawStudioSlug = metadata.studioSlug;
      const rawRepoRoot = metadata.repoRoot;
      const studioId = typeof rawStudioId === 'string' ? rawStudioId : undefined;
      const studioSlug = typeof rawStudioSlug === 'string' ? rawStudioSlug : undefined;
      const repoRoot = typeof rawRepoRoot === 'string' ? rawRepoRoot : undefined;
      const content = STRATEGY_PROMPTS[group.strategy as StrategyPreset](group, task);

      await handleSendToInbox(
        {
          userId: group.user_id,
          recipientAgentId: ownerSlug,
          senderAgentId: ownerSlug,
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
            ...(repoRoot ? { repoRoot } : {}),
            ...(sandboxContainerName ? { sandboxContainerName } : {}),
          },
        },
        this.dataComposer
      );

      logger.info(
        `Strategy trigger sent to ${ownerSlug} for group ${group.id} (task ${task.id}, reason: ${reason}${studioId ? `, studio: ${studioId}` : studioSlug ? `, studioSlug: ${studioSlug}` : ''})`
      );

      await this.logStrategyEvent(
        group,
        'strategy_trigger',
        `Triggered ${ownerSlug} for task: ${task.title}`,
        {
          reason,
          taskId: task.id,
          taskTitle: task.title,
          studioId: studioId || studioSlug || null,
          sbId: group.sb_id,
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
        `Failed to trigger ${group.sb_id} for task: ${task.title}`,
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
   * Create an ephemeral git worktree + studio for sandbox work.
   * Returns the studio record or null on failure.
   */
  private async createEphemeralStudio(
    group: TaskGroup,
    repoRoot: string
  ): Promise<{ studioId: string; worktreePath: string; branch: string } | null> {
    const ownerSlug = (await this.resolveOwnerSlug(group)) || 'agent';
    const slugBase = (group.title || 'task')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30);
    const uniqueSuffix = Date.now().toString(36).slice(-6);
    const slug = `ephemeral-${slugBase}-${uniqueSuffix}`;
    const branch = `${ownerSlug}/sandbox/${slug}`;

    // Resolve to the main worktree root
    let mainRoot = repoRoot;
    try {
      const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repoRoot,
      });
      const match = stdout.match(/^worktree\s+(.+)$/m);
      if (match) mainRoot = match[1];
    } catch {
      // Fall through with original repoRoot
    }

    const worktreePath = path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}--${slug}`);

    // Create git worktree
    try {
      await execFileAsync('git', ['worktree', 'add', '-b', branch, worktreePath, 'main'], {
        cwd: mainRoot,
      });
      logger.info('Ephemeral studio worktree created', { branch, worktreePath, groupId: group.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Ephemeral studio worktree creation failed', {
        error: msg,
        branch,
        worktreePath,
      });
      return null;
    }

    // Install dependencies (non-blocking on failure)
    if (existsSync(path.join(worktreePath, 'package.json'))) {
      try {
        await execFileAsync('yarn', ['install'], { cwd: worktreePath, timeout: 120_000 });
      } catch (err) {
        logger.warn('Ephemeral studio yarn install failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Generate studio settings
    try {
      await ensureStudioSettings(worktreePath);
    } catch {
      // Non-fatal
    }

    // Insert studio record
    try {
      const studio = await this.dataComposer.repositories.studios.create({
        userId: group.user_id,
        agentId: ownerSlug,
        repoRoot: mainRoot,
        worktreePath,
        branch,
        baseBranch: 'main',
        purpose: `Ephemeral sandbox for: ${group.title}`,
        workType: 'feature',
        metadata: { ephemeral: true, taskGroupId: group.id },
      });

      // Update the task group metadata with the new studioId
      const existingMeta = (group.metadata || {}) as Record<string, unknown>;
      await this.dataComposer.repositories.taskGroups.update(group.id, {
        metadata: {
          ...existingMeta,
          studioId: studio.id,
          studioSlug: slug,
          ephemeralStudioId: studio.id,
        },
      });

      await this.logStrategyEvent(
        group,
        'ephemeral_studio_created',
        `Ephemeral studio created: ${worktreePath}`,
        { studioId: studio.id, branch, worktreePath }
      );

      return { studioId: studio.id, worktreePath, branch };
    } catch (err) {
      // DB failed — clean up the worktree
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Ephemeral studio DB insert failed, cleaning up worktree', { error: msg });
      try {
        await execFileAsync('git', ['worktree', 'remove', worktreePath], { cwd: mainRoot });
      } catch {
        // Best-effort
      }
      return null;
    }
  }

  /**
   * Create a persistent git worktree + studio for a strategy.
   * Unlike ephemeral studios, these survive strategy completion.
   */
  private async createPersistentStudio(
    group: TaskGroup,
    slug: string,
    ownerAgentId: string
  ): Promise<{ studioId: string; worktreePath: string; branch: string } | null> {
    const metadata = (group.metadata || {}) as Record<string, unknown>;
    const repoRoot = typeof metadata.repoRoot === 'string' ? metadata.repoRoot : undefined;
    if (!repoRoot) {
      logger.warn(
        `Strategy group ${group.id}: persistent studio requested but no repoRoot in metadata`
      );
      return null;
    }

    const agentId = ownerAgentId;
    const branch = `${agentId}/${slug}`;

    let mainRoot = repoRoot;
    try {
      const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repoRoot,
      });
      const match = stdout.match(/^worktree\s+(.+)$/m);
      if (match) mainRoot = match[1];
    } catch {
      // Fall through with original repoRoot
    }

    const worktreePath = path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}--${slug}`);

    try {
      await execFileAsync('git', ['worktree', 'add', '-b', branch, worktreePath, 'main'], {
        cwd: mainRoot,
      });
      logger.info('Persistent studio worktree created', {
        branch,
        worktreePath,
        groupId: group.id,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Persistent studio worktree creation failed', {
        error: msg,
        branch,
        worktreePath,
      });
      return null;
    }

    if (existsSync(path.join(worktreePath, 'package.json'))) {
      try {
        await execFileAsync('yarn', ['install'], { cwd: worktreePath, timeout: 120_000 });
      } catch (err) {
        logger.warn('Persistent studio yarn install failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    try {
      await ensureStudioSettings(worktreePath);
    } catch {
      // Non-fatal
    }

    try {
      const studio = await this.dataComposer.repositories.studios.create({
        userId: group.user_id,
        agentId,
        repoRoot: mainRoot,
        worktreePath,
        branch,
        baseBranch: 'main',
        purpose: `Strategy studio for: ${group.title}`,
        workType: 'feature',
        metadata: { ephemeral: false, taskGroupId: group.id },
      });

      const existingMeta = (group.metadata || {}) as Record<string, unknown>;
      await this.dataComposer.repositories.taskGroups.update(group.id, {
        metadata: {
          ...existingMeta,
          studioId: studio.id,
          studioSlug: slug,
        },
      });

      await this.logStrategyEvent(
        group,
        'persistent_studio_created',
        `Persistent studio created: ${worktreePath}`,
        { studioId: studio.id, branch, worktreePath, slug }
      );

      return { studioId: studio.id, worktreePath, branch };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Persistent studio DB insert failed, cleaning up worktree', { error: msg });
      try {
        await execFileAsync('git', ['worktree', 'remove', worktreePath], { cwd: mainRoot });
      } catch {
        // Best-effort
      }
      return null;
    }
  }

  /**
   * Tear down an ephemeral studio: stop sandbox container, remove worktree, mark cleaned.
   */
  private async teardownEphemeralStudio(group: TaskGroup): Promise<void> {
    const metadata = (group.metadata || {}) as Record<string, unknown>;
    const ephemeralStudioId =
      typeof metadata.ephemeralStudioId === 'string' ? metadata.ephemeralStudioId : undefined;
    if (!ephemeralStudioId) return;

    const studio = await this.dataComposer.repositories.studios.findById(ephemeralStudioId);
    if (!studio) return;

    // Stop sandbox container if running
    if (this.sandboxOrchestrator) {
      const sandboxes = await this.sandboxOrchestrator.listSandboxes();
      const match = sandboxes.find(
        (s) => s.running && s.labels?.['ink.studio-id'] === ephemeralStudioId
      );
      if (match) {
        await this.sandboxOrchestrator.stop(match.containerName).catch((err) => {
          logger.warn('Failed to stop ephemeral sandbox container', {
            containerName: match.containerName,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    // Remove git worktree
    try {
      await execFileAsync('git', ['worktree', 'remove', studio.worktreePath], {
        cwd: studio.repoRoot,
      });
    } catch (err) {
      logger.warn('Failed to remove ephemeral worktree (may already be gone)', {
        worktreePath: studio.worktreePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Delete the ephemeral branch (prevents collisions on retry)
    if (studio.branch) {
      try {
        await execFileAsync('git', ['branch', '-d', studio.branch], {
          cwd: studio.repoRoot,
        });
      } catch (err) {
        logger.warn('Failed to delete ephemeral branch (may have unmerged changes)', {
          branch: studio.branch,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Mark studio as cleaned in DB
    try {
      await this.dataComposer.repositories.studios.markCleaned(ephemeralStudioId);
    } catch {
      // Best-effort
    }

    await this.logStrategyEvent(
      group,
      'ephemeral_studio_cleaned',
      `Ephemeral studio cleaned: ${studio.worktreePath}`,
      { studioId: ephemeralStudioId, worktreePath: studio.worktreePath }
    );
  }

  /**
   * Spin up a sandbox Docker container for the strategy's owner agent.
   * Resolves the studio from DB metadata, builds a SandboxSpinUpRequest,
   * and delegates to the orchestrator. Returns null if sandbox mode is
   * not enabled or no orchestrator is configured.
   *
   * When ephemeralStudio is true and no studioId exists in metadata,
   * automatically creates a fresh git worktree + studio for the work.
   */
  private async maybeSpinUpSandbox(group: TaskGroup): Promise<SandboxSpinUpResult | null> {
    const config = group.strategy_config as StrategyConfig;
    if (!config.sandbox) return null;

    if (!this.sandboxOrchestrator) {
      const msg = `Sandbox enabled but no SandboxOrchestrator configured`;
      logger.warn(`Strategy group ${group.id}: ${msg}`);
      return { containerName: '', success: false, error: msg };
    }

    let metadata = (group.metadata || {}) as Record<string, unknown>;
    let studioId = typeof metadata.studioId === 'string' ? metadata.studioId : undefined;

    // Ephemeral studio: auto-create if none assigned
    if (!studioId && config.ephemeralStudio) {
      const repoRoot = typeof metadata.repoRoot === 'string' ? metadata.repoRoot : undefined;
      if (!repoRoot) {
        const msg = `Ephemeral studio requested but no repoRoot in metadata`;
        logger.warn(`Strategy group ${group.id}: ${msg}`);
        return { containerName: '', success: false, error: msg };
      }

      const ephemeral = await this.createEphemeralStudio(group, repoRoot);
      if (!ephemeral) {
        const msg = `Failed to create ephemeral studio`;
        return { containerName: '', success: false, error: msg };
      }

      studioId = ephemeral.studioId;
      // Re-read metadata since createEphemeralStudio updated it
      const refreshed = await this.dataComposer.repositories.taskGroups.findById(group.id);
      if (refreshed) {
        metadata = (refreshed.metadata || {}) as Record<string, unknown>;
      }
    }

    if (!studioId) {
      const msg = `Sandbox requested but no studioId in metadata (set ephemeralStudio: true in strategy config to auto-create)`;
      logger.warn(`Strategy group ${group.id}: ${msg}`);
      return { containerName: '', success: false, error: msg };
    }

    const studio = await this.dataComposer.repositories.studios.findById(studioId);
    if (!studio) {
      const msg = `Studio ${studioId} not found`;
      logger.warn(`Strategy group ${group.id}: ${msg}`);
      return { containerName: '', success: false, error: msg };
    }

    const ownerSlug = (await this.resolveOwnerSlug(group)) || studio.agentId || 'unknown';
    const result = await this.sandboxOrchestrator.spinUp({
      userId: group.user_id,
      agentId: ownerSlug,
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
      logger.warn(`Strategy watchdog: group ${groupId} not found, cancelling orphaned watchdog`);
      await this.cancelWatchdogReminder(groupId);
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
        `Strategy watchdog: group ${groupId} is ${group.status} (strategy=${group.strategy ?? 'null'}), cancelling stale watchdog`
      );
      await this.cancelWatchdogReminder(groupId);
      await this.logStrategyEvent(
        group,
        'watchdog_skip',
        `Watchdog skipped and self-cancelled: group is ${group.status}`,
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
        `Strategy watchdog: group ${groupId} has no in_progress or pending task, cancelling stale watchdog`
      );
      await this.cancelWatchdogReminder(groupId);
      await this.logStrategyEvent(
        group,
        'watchdog_skip',
        `Watchdog skipped and self-cancelled: no pending/in-progress task`,
        {
          reason: 'no_current_task',
          currentTaskIndex: group.current_task_index,
        }
      );
      return false;
    }

    // If the strategy uses a sandbox, spin up (or reuse) the container before
    // triggering. The orchestrator short-circuits if the container is already
    // running, so this is safe to call on every watchdog tick.
    const config = group.strategy_config as StrategyConfig;
    let sandboxContainerName: string | undefined;
    if (config.sandbox) {
      const sandboxResult = await this.maybeSpinUpSandbox(group);
      const sandboxPolicy = config.sandboxPolicy || 'required';

      if (sandboxResult && !sandboxResult.success && sandboxPolicy === 'required') {
        await this.logStrategyEvent(
          group,
          'sandbox_failed',
          `Watchdog aborted: sandbox required but spin-up failed — ${sandboxResult.error}`,
          { error: sandboxResult.error, policy: 'required', trigger: 'watchdog' }
        );
        await this.cancelWatchdogReminder(groupId);
        await this.dataComposer.repositories.taskGroups.update(groupId, {
          status: 'paused',
          strategy_paused_at: new Date().toISOString(),
        });
        return false;
      }

      if (sandboxResult?.success) {
        sandboxContainerName = sandboxResult.containerName;
      }
    }

    return this.triggerOwnerAgent(group, currentTask, 'watchdog', sandboxContainerName);
  }

  /**
   * Create a recurring watchdog reminder linked to the strategy.
   * The heartbeat picks this up periodically and checks if the strategy is stuck.
   */
  private async createWatchdogReminder(group: TaskGroup, userId: string): Promise<void> {
    const config = group.strategy_config as StrategyConfig;
    const intervalMinutes = config.watchdogIntervalMinutes || 10;

    try {
      // Cancel any existing watchdog before creating a new one to prevent duplicates
      await this.cancelWatchdogReminder(group.id);

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
          sb_id: group.sb_id,
          cron_expression: `*/${intervalMinutes} * * * *`,
          next_run_at: nextRunAt.toISOString(),
          status: 'active',
          metadata: {
            strategyWatchdog: true,
            groupId: group.id,
            strategy: group.strategy,
            sbId: group.sb_id,
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
  private async finalizeStrategy(
    group: TaskGroup,
    stats: {
      total: number;
      completed: number;
      pending: number;
      blocked: number;
      hasIncomplete: boolean;
    },
    config: StrategyConfig,
    userId: string
  ): Promise<void> {
    await this.dataComposer.repositories.taskGroups.update(group.id, {
      status: 'completed',
      execution_phase: 'completed',
      context_summary: stats.hasIncomplete
        ? `Strategy complete with issues: ${stats.completed}/${stats.total} done, ${stats.pending} pending, ${stats.blocked} blocked.`
        : `Strategy complete. ${stats.completed}/${stats.total} tasks done.`,
    });

    await this.cleanupStrategyResources(group.id);

    await this.logStrategyEvent(
      group,
      'strategy_completed',
      `Strategy complete: ${stats.completed}/${stats.total} tasks done`,
      {
        totalTasks: stats.total,
        completedTasks: stats.completed,
        pendingTasks: stats.pending,
        blockedTasks: stats.blocked,
        hasIncomplete: stats.hasIncomplete,
      }
    );

    await this.notifyDispatcher(
      group,
      config.checkInNotify || config.approvalNotify,
      `Strategy "${group.strategy}" complete on "${group.title}": ${stats.completed}/${stats.total} tasks finished.${stats.hasIncomplete ? ` WARNING: ${stats.pending} pending, ${stats.blocked} blocked tasks remain.` : ''}`,
      userId
    );

    if (config.supervisorId) {
      const supervisorSlug = await resolveAgentSlug(
        this.dataComposer.getClient(),
        config.supervisorId
      );
      if (supervisorSlug) {
        await this.notifyDispatcher(
          group,
          supervisorSlug,
          `[Supervisor audit] Strategy "${group.strategy}" on "${group.title}" is complete. ${stats.completed}/${stats.total} tasks done.${stats.hasIncomplete ? ` PROCESS VIOLATION: ${stats.pending} pending, ${stats.blocked} blocked tasks were not completed.` : ''} Review the activity stream for task_group_id ${group.id}.`,
          userId
        );
      }
    }

    if (config.userNotify) {
      await this.notifyDispatcher(
        group,
        config.userNotify,
        `Strategy complete: "${group.title}" — ${stats.completed}/${stats.total} tasks finished.${stats.hasIncomplete ? ` (${stats.pending} pending, ${stats.blocked} blocked)` : ''}`,
        userId
      );
    }
  }

  /**
   * Clean up strategy resources (watchdog, etc.) without logging a
   * strategy_cancelled event or changing group status. Use this when
   * the caller manages its own status transition and activity logging.
   */
  async cleanupStrategyResources(groupId: string): Promise<void> {
    await this.cancelWatchdogReminder(groupId);

    // Tear down ephemeral studio + sandbox if present
    const group = await this.dataComposer.repositories.taskGroups.findById(groupId);
    if (group) {
      await this.teardownEphemeralStudio(group).catch((err) => {
        logger.warn('Ephemeral studio teardown failed (non-fatal)', {
          groupId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

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
      const agentSlug = (await this.resolveOwnerSlug(group)) || 'system';
      await this.dataComposer.repositories.activityStream.logActivity({
        userId: group.user_id,
        agentId: agentSlug,
        type: 'state_change',
        subtype,
        content,
        sessionId: reqCtx?.sessionId,
        taskGroupId: group.id,
        payload: {
          groupId: group.id,
          groupTitle: group.title,
          strategy: group.strategy,
          sbId: group.sb_id || undefined,
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
