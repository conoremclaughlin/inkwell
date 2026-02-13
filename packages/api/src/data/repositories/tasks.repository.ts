import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';
import type { Task, CreateTaskDTO, UpdateTaskDTO, ListTasksOptions } from '../models/task.model';
import { BaseRepository } from './base.repository';

export class TasksRepository extends BaseRepository {
  constructor(client: SupabaseClient<Database>) {
    super(client);
  }

  async create(taskData: CreateTaskDTO): Promise<Task> {
    try {
      const { data, error } = await this.client
        .from('tasks')
        .insert({
          ...taskData,
          due_date: taskData.due_date?.toISOString(),
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      this.handleError(error, 'create');
    }
  }

  async findById(id: string, userId: string): Promise<Task | null> {
    try {
      const { data, error } = await this.client
        .from('tasks')
        .select('*')
        .eq('id', id)
        .eq('user_id', userId)
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data;
    } catch (error) {
      this.handleError(error, 'findById');
    }
  }

  async list(userId: string, options?: ListTasksOptions): Promise<Task[]> {
    try {
      let query = this.client.from('tasks').select('*').eq('user_id', userId);

      if (options?.status) {
        query = query.eq('status', options.status);
      }

      if (options?.priority) {
        query = query.eq('priority', options.priority);
      }

      if (options?.tags?.length) {
        query = query.contains('tags', options.tags);
      }

      query = query.order('due_date', { ascending: true, nullsFirst: false });

      if (options?.limit) {
        query = query.limit(options.limit);
      }

      if (options?.offset) {
        query = query.range(options.offset, options.offset + (options.limit || 20) - 1);
      }

      const { data, error } = await query;

      if (error) throw error;
      return data || [];
    } catch (error) {
      this.handleError(error, 'list');
    }
  }

  async update(id: string, userId: string, taskData: UpdateTaskDTO): Promise<Task> {
    try {
      const updateData: Record<string, unknown> = { ...taskData };

      if (taskData.due_date) {
        updateData.due_date = taskData.due_date.toISOString();
      }

      if (taskData.completed_at) {
        updateData.completed_at = taskData.completed_at.toISOString();
      }

      const { data, error } = await this.client
        .from('tasks')
        .update(updateData)
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      this.handleError(error, 'update');
    }
  }

  async updateStatus(id: string, userId: string, status: string): Promise<Task> {
    try {
      const updateData: Record<string, unknown> = { status };

      // If marking as completed, set completed_at
      if (status === 'completed') {
        updateData.completed_at = new Date().toISOString();
      }

      const { data, error } = await this.client
        .from('tasks')
        .update(updateData)
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      this.handleError(error, 'updateStatus');
    }
  }

  async delete(id: string, userId: string): Promise<void> {
    try {
      const { error } = await this.client.from('tasks').delete().eq('id', id).eq('user_id', userId);

      if (error) throw error;
    } catch (error) {
      this.handleError(error, 'delete');
    }
  }
}
