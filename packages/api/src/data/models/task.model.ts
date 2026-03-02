import type { Database } from '../supabase/types';
import type { TaskStatus, TaskPriority } from '../../types/shared';

export type Task = Database['public']['Tables']['tasks']['Row'];
export type TaskInsert = Database['public']['Tables']['tasks']['Insert'];
export type TaskUpdate = Database['public']['Tables']['tasks']['Update'];

export interface CreateTaskDTO {
  user_id: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  due_date?: Date;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateTaskDTO {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  due_date?: Date;
  completed_at?: Date;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface ListTasksOptions {
  status?: TaskStatus;
  priority?: TaskPriority;
  tags?: string[];
  limit?: number;
  offset?: number;
}
