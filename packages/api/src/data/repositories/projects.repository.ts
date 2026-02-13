import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';
import { BaseRepository } from './base.repository';

export type ProjectStatus = 'active' | 'paused' | 'completed' | 'archived';

export interface Project {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  tech_stack: string[] | null;
  repository_url: string | null;
  goals: string[] | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ProjectInsert {
  user_id: string;
  name: string;
  description?: string | null;
  status?: ProjectStatus;
  tech_stack?: string[];
  repository_url?: string | null;
  goals?: string[];
  metadata?: Record<string, unknown>;
}

export interface ProjectUpdate {
  name?: string;
  description?: string | null;
  status?: ProjectStatus;
  tech_stack?: string[];
  repository_url?: string | null;
  goals?: string[];
  metadata?: Record<string, unknown>;
}

export class ProjectsRepository extends BaseRepository {
  constructor(client: SupabaseClient<Database>) {
    super(client);
  }

  async findById(id: string): Promise<Project | null> {
    try {
      const { data, error } = await this.client.from('projects').select('*').eq('id', id).single();

      if (error && error.code !== 'PGRST116') throw error;
      return data as Project | null;
    } catch (error) {
      this.handleError(error, 'findById');
    }
  }

  async findByUserAndName(userId: string, name: string): Promise<Project | null> {
    try {
      const { data, error } = await this.client
        .from('projects')
        .select('*')
        .eq('user_id', userId)
        .eq('name', name)
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data as Project | null;
    } catch (error) {
      this.handleError(error, 'findByUserAndName');
    }
  }

  async findAllByUser(userId: string, status?: ProjectStatus): Promise<Project[]> {
    try {
      let query = this.client
        .from('projects')
        .select('*')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false });

      if (status) {
        query = query.eq('status', status);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data as Project[]) || [];
    } catch (error) {
      this.handleError(error, 'findAllByUser');
    }
  }

  async create(data: ProjectInsert): Promise<Project> {
    try {
      const { data: inserted, error } = await this.client
        .from('projects')
        .insert(data)
        .select()
        .single();

      if (error) throw error;
      return inserted as Project;
    } catch (error) {
      this.handleError(error, 'create');
    }
  }

  async update(id: string, data: ProjectUpdate): Promise<Project> {
    try {
      const { data: updated, error } = await this.client
        .from('projects')
        .update(data)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return updated as Project;
    } catch (error) {
      this.handleError(error, 'update');
    }
  }

  async upsertByName(data: ProjectInsert): Promise<Project> {
    try {
      const existing = await this.findByUserAndName(data.user_id, data.name);

      if (existing) {
        return await this.update(existing.id, {
          description: data.description,
          status: data.status,
          tech_stack: data.tech_stack,
          repository_url: data.repository_url,
          goals: data.goals,
          metadata: data.metadata,
        });
      } else {
        return await this.create(data);
      }
    } catch (error) {
      this.handleError(error, 'upsertByName');
    }
  }

  async delete(id: string): Promise<void> {
    try {
      const { error } = await this.client.from('projects').delete().eq('id', id);

      if (error) throw error;
    } catch (error) {
      this.handleError(error, 'delete');
    }
  }
}
