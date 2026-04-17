/**
 * MCP Tool Handlers for Tasks
 *
 * These tools enable agents to create, manage, and track tasks
 * across sessions. Tasks can optionally be scoped to projects.
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import type { TaskStatus, TaskPriority } from '../../data/repositories/project-tasks.repository';
import { resolveUser, type UserIdentifier } from '../../services/user-resolver';
import { getEffectiveAgentId } from '../../auth/enforce-identity';
import { getRequestContext } from '../../utils/request-context';
import { logger } from '../../utils/logger';

// Common user identifier schema
// Usually unnecessary — userId and email are auto-resolved from OAuth token.
const userIdentifierSchema = z.object({
  userId: z
    .string()
    .uuid()
    .optional()
    .describe('User UUID — usually unnecessary, auto-resolved from OAuth token'),
  email: z
    .string()
    .email()
    .optional()
    .describe('User email — usually unnecessary, auto-resolved from OAuth token'),
  platform: z
    .enum(['telegram', 'whatsapp', 'discord'])
    .optional()
    .describe('Platform name — only needed for platform-based user lookup'),
  platformId: z
    .string()
    .optional()
    .describe('Platform-specific user ID — only needed for platform-based user lookup'),
});

// ============================================================================
// CREATE TASK
// ============================================================================

export const createTaskSchema = z.object({
  ...userIdentifierSchema.shape,
  projectId: z.string().uuid().describe('Project ID to add the task to'),
  title: z.string().min(1).max(500).describe('Task title'),
  description: z.string().optional().describe('Detailed task description'),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional().default('medium'),
  tags: z.array(z.string()).optional().describe('Tags for categorization'),
  createdBy: z.string().optional().describe('Who created this task (e.g., "claude", "user")'),
});

type McpResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function mcpResponse(data: object, isError = false): McpResponse {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    isError,
  };
}

export async function handleCreateTask(
  args: z.infer<typeof createTaskSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    // Verify project exists and belongs to user
    const project = await dataComposer.repositories.projects.findById(args.projectId);
    if (!project) {
      return mcpResponse({ success: false, error: 'Project not found' }, true);
    }
    if (project.user_id !== resolved.user.id) {
      return mcpResponse({ success: false, error: 'Project does not belong to this user' }, true);
    }

    const task = await dataComposer.repositories.tasks.create({
      project_id: args.projectId,
      user_id: resolved.user.id,
      title: args.title,
      description: args.description,
      priority: args.priority as TaskPriority,
      tags: args.tags,
      created_by: args.createdBy || 'claude',
    });

    return mcpResponse({
      success: true,
      task: {
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        tags: task.tags,
        createdAt: task.created_at,
      },
    });
  } catch (error) {
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create task',
      },
      true
    );
  }
}

// ============================================================================
// LIST TASKS
// ============================================================================

export const listTasksSchema = z.object({
  ...userIdentifierSchema.shape,
  projectId: z.string().uuid().optional().describe('Filter by project'),
  groupId: z.string().uuid().optional().describe('Filter by task group'),
  status: z.enum(['pending', 'in_progress', 'completed', 'blocked']).optional(),
  activeOnly: z.boolean().optional().default(false).describe('Only show pending/in_progress tasks'),
  limit: z.number().optional().default(50),
});

export async function handleListTasks(
  args: z.infer<typeof listTasksSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    let tasks;
    if (args.activeOnly) {
      tasks = await dataComposer.repositories.tasks.listActiveTasks(
        resolved.user.id,
        args.projectId
      );
    } else {
      tasks = await dataComposer.repositories.tasks.listByUser(resolved.user.id, {
        status: args.status as TaskStatus | undefined,
        projectId: args.projectId,
        groupId: args.groupId,
        limit: args.limit,
      });
    }

    // Resolve project names
    const projectIds = [...new Set(tasks.map((t) => t.project_id).filter(Boolean))] as string[];
    const projects = await Promise.all(
      projectIds.map((id) => dataComposer.repositories.projects.findById(id))
    );
    const projectMap = new Map(projects.filter(Boolean).map((p) => [p!.id, p!.name]));

    // Resolve task group names
    const groupIds = [...new Set(tasks.map((t) => t.task_group_id).filter(Boolean))] as string[];
    const groupMap = new Map<string, string>();
    if (groupIds.length > 0) {
      const { data: groups } = await dataComposer
        .getClient()
        .from('task_groups' as never)
        .select('id, title')
        .in('id', groupIds as never);
      for (const g of (groups || []) as Array<{ id: string; title: string }>) {
        groupMap.set(g.id, g.title);
      }
    }

    return mcpResponse({
      success: true,
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        tags: task.tags,
        projectId: task.project_id,
        projectName: task.project_id ? projectMap.get(task.project_id) || 'Unknown' : null,
        taskGroupId: task.task_group_id || null,
        taskGroupTitle: task.task_group_id ? groupMap.get(task.task_group_id) || null : null,
        createdBy: task.created_by || null,
        blockedBy: task.blocked_by || null,
        dueDate: task.due_date || null,
        metadata: task.metadata || null,
        createdAt: task.created_at,
        completedAt: task.completed_at,
      })),
    });
  } catch (error) {
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list tasks',
      },
      true
    );
  }
}

// ============================================================================
// UPDATE TASK
// ============================================================================

export const updateTaskSchema = z.object({
  ...userIdentifierSchema.shape,
  taskId: z.string().uuid().describe('Task ID to update'),
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'blocked']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  tags: z.array(z.string()).optional(),
});

export async function handleUpdateTask(
  args: z.infer<typeof updateTaskSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    // Verify task exists and belongs to user
    const existing = await dataComposer.repositories.tasks.findById(args.taskId);
    if (!existing) {
      return mcpResponse({ success: false, error: 'Task not found' }, true);
    }
    if (existing.user_id !== resolved.user.id) {
      return mcpResponse({ success: false, error: 'Task does not belong to this user' }, true);
    }

    const updates: Record<string, unknown> = {};
    if (args.title !== undefined) updates.title = args.title;
    if (args.description !== undefined) updates.description = args.description;
    if (args.status !== undefined) {
      updates.status = args.status;
      // Clear completed_at when reopening a task (non-completed status).
      // Without this, reopened tasks retain the green "done" badge.
      if (args.status !== 'completed') {
        updates.completed_at = null;
      }
    }
    if (args.priority !== undefined) updates.priority = args.priority;
    if (args.tags !== undefined) updates.tags = args.tags;

    const task = await dataComposer.repositories.tasks.update(args.taskId, updates);

    return mcpResponse({
      success: true,
      task: {
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        tags: task.tags,
        completedAt: task.completed_at,
      },
    });
  } catch (error) {
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update task',
      },
      true
    );
  }
}

// ============================================================================
// COMPLETE TASK
// ============================================================================

export const completeTaskSchema = z.object({
  ...userIdentifierSchema.shape,
  taskId: z.string().uuid().describe('Task ID to mark as completed'),
});

export async function handleCompleteTask(
  args: z.infer<typeof completeTaskSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    // Verify task exists and belongs to user
    const existing = await dataComposer.repositories.tasks.findById(args.taskId);
    if (!existing) {
      return mcpResponse({ success: false, error: 'Task not found' }, true);
    }
    if (existing.user_id !== resolved.user.id) {
      return mcpResponse({ success: false, error: 'Task does not belong to this user' }, true);
    }

    const task = await dataComposer.repositories.tasks.completeTask(args.taskId);

    // Auto-remember: persist task completion as a memory for session continuity
    try {
      const agentId = getEffectiveAgentId(undefined);
      const salience = task.priority === 'high' || task.priority === 'critical' ? 'high' : 'medium';
      const topics = [`task:${task.id}`, ...(task.tags || [])];
      if (task.project_id) topics.push(`project:${task.project_id}`);

      await dataComposer.repositories.memory.remember({
        userId: resolved.user.id,
        content: `Completed task: ${task.title}${task.description ? ` — ${task.description}` : ''}`,
        summary: `Completed: ${task.title}`,
        topicKey: task.project_id ? `project:${task.project_id}` : undefined,
        source: 'session',
        salience: salience as 'medium' | 'high',
        topics,
        agentId: agentId || undefined,
        metadata: { taskId: task.id, autoCreated: true },
      });
    } catch (err) {
      // Non-fatal — task completion is the primary action, memory is best-effort
      logger.warn('Failed to auto-remember task completion:', err);
    }

    return mcpResponse({
      success: true,
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        completedAt: task.completed_at,
      },
    });
  } catch (error) {
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to complete task',
      },
      true
    );
  }
}

// ============================================================================
// GET PROJECT TASK STATS
// ============================================================================

export const getTaskStatsSchema = z.object({
  ...userIdentifierSchema.shape,
  projectId: z.string().uuid().describe('Project ID to get stats for'),
});

export async function handleGetTaskStats(
  args: z.infer<typeof getTaskStatsSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    // Verify project exists and belongs to user
    const project = await dataComposer.repositories.projects.findById(args.projectId);
    if (!project) {
      return mcpResponse({ success: false, error: 'Project not found' }, true);
    }
    if (project.user_id !== resolved.user.id) {
      return mcpResponse({ success: false, error: 'Project does not belong to this user' }, true);
    }

    const stats = await dataComposer.repositories.tasks.getProjectStats(args.projectId);

    return mcpResponse({
      success: true,
      stats: {
        projectId: args.projectId,
        projectName: project.name,
        ...stats,
        completionRate: stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0,
      },
    });
  } catch (error) {
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get task stats',
      },
      true
    );
  }
}

// ============================================================================
// ADD TASK COMMENT
// ============================================================================

export const addTaskCommentSchema = z.object({
  ...userIdentifierSchema.shape,
  taskId: z.string().uuid().describe('Task ID to comment on'),
  content: z.string().min(1).max(5000).describe('Comment content'),
  parentCommentId: z.string().uuid().optional().describe('Parent comment ID for threaded replies'),
  agentId: z.string().optional().describe('Agent ID for identity attribution'),
});

async function resolveIdentityIdForAgent(
  dataComposer: DataComposer,
  userId: string,
  agentId: string | undefined,
  workspaceId: string | undefined
): Promise<string | null> {
  if (!agentId) return null;
  let query = dataComposer
    .getClient()
    .from('agent_identities')
    .select('id')
    .eq('agent_id', agentId)
    .eq('user_id', userId);
  if (workspaceId) {
    query = query.eq('workspace_id', workspaceId);
  }
  const { data } = await query.limit(1).single();
  return (data as { id: string } | null)?.id ?? null;
}

export async function handleAddTaskComment(
  args: z.infer<typeof addTaskCommentSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    // Verify task exists and belongs to user
    const existing = await dataComposer.repositories.tasks.findById(args.taskId);
    if (!existing) {
      return mcpResponse({ success: false, error: 'Task not found' }, true);
    }
    if (existing.user_id !== resolved.user.id) {
      return mcpResponse({ success: false, error: 'Task does not belong to this user' }, true);
    }

    const agentId = getEffectiveAgentId(args.agentId);
    const reqCtx = getRequestContext();
    const workspaceId = reqCtx?.workspaceId;

    const identityId = await resolveIdentityIdForAgent(
      dataComposer,
      resolved.user.id,
      agentId,
      workspaceId
    );

    const { data: rawComment, error } = await dataComposer
      .getClient()
      .from('task_comments' as never)
      .insert({
        task_id: args.taskId,
        user_id: resolved.user.id,
        content: args.content.trim(),
        parent_comment_id: args.parentCommentId || null,
        created_by_agent_id: agentId || null,
        created_by_identity_id: identityId,
      } as never)
      .select()
      .single();

    if (error) {
      return mcpResponse(
        { success: false, error: `Failed to add comment: ${error.message}` },
        true
      );
    }

    const comment = rawComment as unknown as {
      id: string;
      task_id: string;
      content: string;
      created_at: string;
    };

    return mcpResponse({
      success: true,
      comment: {
        id: comment.id,
        taskId: comment.task_id,
        content: comment.content,
        authorAgentId: agentId || null,
        createdAt: comment.created_at,
      },
    });
  } catch (error) {
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add task comment',
      },
      true
    );
  }
}

// ============================================================================
// TASK GROUPS — CREATE / LIST
// ============================================================================

const taskGroupStatusEnum = z.enum(['active', 'paused', 'completed', 'cancelled']);
const taskGroupPriorityEnum = z.enum(['low', 'normal', 'high', 'urgent']);
const taskGroupOutputTargetEnum = z.enum(['spec', 'pr', 'report', 'proposal']);
const taskGroupOutputStatusEnum = z.enum(['ready_for_review', 'needs_more_work', 'blocked']);

export const createTaskGroupSchema = z.object({
  ...userIdentifierSchema.shape,
  title: z.string().min(1).max(500).describe('Task group title'),
  description: z.string().optional().describe('Detailed description / strategy'),
  projectId: z.string().uuid().optional().describe('Optional project scope'),
  priority: taskGroupPriorityEnum.optional().default('normal'),
  status: taskGroupStatusEnum.optional().default('active'),
  tags: z.array(z.string()).optional(),
  autonomous: z.boolean().optional().describe('Whether this group runs autonomously'),
  maxSessions: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Cap on autonomous sessions spent on this group'),
  contextSummary: z
    .string()
    .optional()
    .describe('Rolling context handed to each autonomous session'),
  threadKey: z
    .string()
    .optional()
    .describe('Thread key for coordination (e.g. pr:123, thread:foo)'),
  outputTarget: taskGroupOutputTargetEnum
    .optional()
    .describe('Expected deliverable type (spec, pr, report, proposal)'),
  outputStatus: taskGroupOutputStatusEnum.optional(),
  metadata: z.record(z.unknown()).optional(),
  agentId: z
    .string()
    .optional()
    .describe('Agent identity to attribute the group to (defaults to caller)'),
});

export async function handleCreateTaskGroup(
  args: z.infer<typeof createTaskGroupSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    if (args.projectId) {
      const project = await dataComposer.repositories.projects.findById(args.projectId);
      if (!project) {
        return mcpResponse({ success: false, error: 'Project not found' }, true);
      }
      if (project.user_id !== resolved.user.id) {
        return mcpResponse({ success: false, error: 'Project does not belong to this user' }, true);
      }
    }

    const agentId = getEffectiveAgentId(args.agentId);
    const reqCtx = getRequestContext();
    const identityId = await resolveIdentityIdForAgent(
      dataComposer,
      resolved.user.id,
      agentId,
      reqCtx?.workspaceId
    );

    const group = await dataComposer.repositories.taskGroups.create({
      user_id: resolved.user.id,
      identity_id: identityId,
      project_id: args.projectId ?? null,
      title: args.title,
      description: args.description,
      status: args.status,
      priority: args.priority,
      tags: args.tags,
      metadata: args.metadata,
      autonomous: args.autonomous,
      max_sessions: args.maxSessions,
      context_summary: args.contextSummary,
      output_target: args.outputTarget,
      output_status: args.outputStatus,
      thread_key: args.threadKey,
    });

    return mcpResponse({
      success: true,
      group: {
        id: group.id,
        title: group.title,
        description: group.description,
        status: group.status,
        priority: group.priority,
        tags: group.tags,
        projectId: group.project_id,
        identityId: group.identity_id,
        agentId: agentId || null,
        autonomous: group.autonomous,
        maxSessions: group.max_sessions,
        sessionsUsed: group.sessions_used,
        contextSummary: group.context_summary,
        outputTarget: group.output_target,
        outputStatus: group.output_status,
        threadKey: group.thread_key,
        metadata: group.metadata,
        createdAt: group.created_at,
        updatedAt: group.updated_at,
      },
    });
  } catch (error) {
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create task group',
      },
      true
    );
  }
}

export const listTaskGroupsSchema = z.object({
  ...userIdentifierSchema.shape,
  statuses: z
    .array(taskGroupStatusEnum)
    .optional()
    .describe(
      'Filter by one or more statuses: active, paused, completed, cancelled. Omit or pass empty array to include all statuses.'
    ),
  projectId: z.string().uuid().optional().describe('Filter by project'),
  identityId: z.string().uuid().optional().describe('Filter by agent identity UUID'),
  autonomousOnly: z.boolean().optional().default(false).describe('Only autonomous groups'),
  includeTaskCounts: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include per-status task counts per group'),
  limit: z.number().int().positive().max(500).optional().default(200),
});

export async function handleListTaskGroups(
  args: z.infer<typeof listTaskGroupsSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    // Empty array is treated the same as omitted: include all statuses.
    const statuses = args.statuses && args.statuses.length > 0 ? args.statuses : undefined;

    const groups = await dataComposer.repositories.taskGroups.listByUser(resolved.user.id, {
      status: statuses,
      projectId: args.projectId,
      identityId: args.identityId,
      autonomousOnly: args.autonomousOnly,
      limit: args.limit,
    });

    const countsByGroup = args.includeTaskCounts
      ? await dataComposer.repositories.taskGroups.taskCountsByGroup(
          resolved.user.id,
          groups.map((g) => g.id)
        )
      : {};

    // Resolve project + identity names for display
    const projectIds = [...new Set(groups.map((g) => g.project_id).filter(Boolean))] as string[];
    const projects = await Promise.all(
      projectIds.map((id) => dataComposer.repositories.projects.findById(id))
    );
    const projectMap = new Map(projects.filter(Boolean).map((p) => [p!.id, p!.name]));

    const identityIds = [...new Set(groups.map((g) => g.identity_id).filter(Boolean))] as string[];
    const identityMap = new Map<string, { agentId: string; name: string | null }>();
    if (identityIds.length > 0) {
      const { data: identities } = await dataComposer
        .getClient()
        .from('agent_identities')
        .select('id, agent_id, name')
        .in('id', identityIds);
      for (const row of (identities || []) as Array<{
        id: string;
        agent_id: string;
        name: string | null;
      }>) {
        identityMap.set(row.id, { agentId: row.agent_id, name: row.name });
      }
    }

    return mcpResponse({
      success: true,
      groups: groups.map((g) => ({
        id: g.id,
        title: g.title,
        description: g.description,
        status: g.status,
        priority: g.priority,
        tags: g.tags,
        projectId: g.project_id,
        projectName: g.project_id ? projectMap.get(g.project_id) || null : null,
        identityId: g.identity_id,
        agentId: g.identity_id ? identityMap.get(g.identity_id)?.agentId || null : null,
        agentName: g.identity_id ? identityMap.get(g.identity_id)?.name || null : null,
        autonomous: g.autonomous,
        maxSessions: g.max_sessions,
        sessionsUsed: g.sessions_used,
        contextSummary: g.context_summary,
        nextRunAfter: g.next_run_after,
        outputTarget: g.output_target,
        outputStatus: g.output_status,
        threadKey: g.thread_key,
        taskCounts: args.includeTaskCounts
          ? countsByGroup[g.id] || {
              total: 0,
              pending: 0,
              in_progress: 0,
              completed: 0,
              blocked: 0,
            }
          : undefined,
        metadata: g.metadata,
        createdAt: g.created_at,
        updatedAt: g.updated_at,
      })),
    });
  } catch (error) {
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list task groups',
      },
      true
    );
  }
}
