/**
 * Tasks Repository (formerly Project Tasks)
 *
 * Manages tasks for persistent tracking across sessions.
 * After the task unification migration, project_tasks was renamed to tasks.
 * project_id is now nullable — tasks can be standalone or project-scoped.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'archived';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface ProjectTask {
  id: string;
  project_id: string | null;
  user_id: string;
  title: string;
  description?: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  tags: string[];
  blocked_by?: string[] | null;
  created_by?: string | null;
  completed_at?: string | null;
  task_group_id?: string | null;
  task_order?: number | null;
  due_date?: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectTaskInput {
  project_id?: string | null;
  user_id: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  tags?: string[];
  blocked_by?: string[];
  created_by?: string;
  task_group_id?: string;
  task_order?: number;
}

export interface UpdateProjectTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  tags?: string[];
  blocked_by?: string[];
}

export class ProjectTasksRepository {
  constructor(private client: SupabaseClient<Database>) {}

  /**
   * Create a new task
   */
  async create(input: CreateProjectTaskInput): Promise<ProjectTask> {
    const insertData: Record<string, unknown> = {
      project_id: input.project_id,
      user_id: input.user_id,
      title: input.title,
      description: input.description,
      status: input.status || 'pending',
      priority: input.priority || 'medium',
      tags: input.tags || [],
      blocked_by: input.blocked_by,
      created_by: input.created_by,
    };
    if (input.task_group_id !== undefined) insertData.task_group_id = input.task_group_id;
    if (input.task_order !== undefined) insertData.task_order = input.task_order;

    const { data, error } = await this.client
      .from('tasks')
      .insert(insertData as never)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create task: ${error.message}`);
    }

    return data as unknown as ProjectTask;
  }

  /**
   * Find task by ID
   */
  async findById(id: string): Promise<ProjectTask | null> {
    const { data, error } = await this.client.from('tasks').select('*').eq('id', id).single();

    if (error && error.code !== 'PGRST116') {
      throw new Error(`Failed to find task: ${error.message}`);
    }

    return data as unknown as ProjectTask | null;
  }

  /**
   * List tasks for a project
   */
  async listByProject(
    projectId: string,
    options?: {
      status?: TaskStatus | TaskStatus[];
      priority?: TaskPriority;
      limit?: number;
    }
  ): Promise<ProjectTask[]> {
    let query = this.client
      .from('tasks')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (options?.status) {
      if (Array.isArray(options.status)) {
        query = query.in('status', options.status);
      } else {
        query = query.eq('status', options.status);
      }
    }

    if (options?.priority) {
      query = query.eq('priority', options.priority);
    }

    if (options?.limit) {
      query = query.limit(options.limit);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to list tasks: ${error.message}`);
    }

    return (data || []) as unknown as ProjectTask[];
  }

  /**
   * List tasks for a user across all projects
   */
  async listByUser(
    userId: string,
    options?: {
      status?: TaskStatus | TaskStatus[];
      projectId?: string;
      groupId?: string;
      limit?: number;
    }
  ): Promise<ProjectTask[]> {
    let query = this.client
      .from('tasks')
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

    if (options?.projectId) {
      query = query.eq('project_id', options.projectId);
    }

    if (options?.groupId) {
      query = query.eq('task_group_id', options.groupId);
    }

    if (options?.limit) {
      query = query.limit(options.limit);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to list tasks: ${error.message}`);
    }

    return (data || []) as unknown as ProjectTask[];
  }

  /**
   * List pending/in_progress tasks (active work)
   */
  async listActiveTasks(userId: string, projectId?: string): Promise<ProjectTask[]> {
    return this.listByUser(userId, {
      status: ['pending', 'in_progress'],
      projectId,
    });
  }

  /**
   * Update a task
   */
  async update(id: string, input: UpdateProjectTaskInput): Promise<ProjectTask> {
    const { data, error } = await this.client
      .from('tasks')
      .update(input as never)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update task: ${error.message}`);
    }

    return data as unknown as ProjectTask;
  }

  /**
   * Mark task as in progress
   */
  async startTask(id: string): Promise<ProjectTask> {
    return this.update(id, { status: 'in_progress' });
  }

  /**
   * Mark task as completed
   */
  async completeTask(id: string): Promise<ProjectTask> {
    return this.update(id, { status: 'completed' });
  }

  /**
   * Mark task as blocked
   */
  async blockTask(id: string, blockedBy?: string[]): Promise<ProjectTask> {
    return this.update(id, { status: 'blocked', blocked_by: blockedBy });
  }

  /**
   * Reopen a completed task
   */
  async reopenTask(id: string): Promise<ProjectTask> {
    return this.update(id, { status: 'pending' });
  }

  /**
   * Archive a task (soft delete). Tasks are never hard-deleted —
   * the execution log must be reproducible.
   */
  async archive(id: string): Promise<ProjectTask> {
    return this.update(id, { status: 'archived' as TaskStatus });
  }

  /**
   * @deprecated Use archive() instead. Tasks should never be hard-deleted.
   */
  async delete(id: string): Promise<void> {
    // Soft delete: archive instead of destroying
    await this.archive(id);
  }

  /**
   * Get task statistics for a project
   */
  async getProjectStats(projectId: string): Promise<{
    total: number;
    pending: number;
    in_progress: number;
    completed: number;
    blocked: number;
  }> {
    const tasks = await this.listByProject(projectId);

    return {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === 'pending').length,
      in_progress: tasks.filter((t) => t.status === 'in_progress').length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      blocked: tasks.filter((t) => t.status === 'blocked').length,
    };
  }
}
