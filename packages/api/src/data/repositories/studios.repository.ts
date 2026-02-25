/**
 * Studios Repository
 *
 * Manages git worktree studios for parallel agent work:
 * - Track active worktrees per user/agent
 * - Link studios to sessions
 * - Lifecycle management (active → idle → archived → cleaned)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '../supabase/types';
import { resolveIdentityId } from '../../auth/resolve-identity';

type StudiosTable = Database['public']['Tables']['studios'];

export type StudioStatus = 'active' | 'idle' | 'archived' | 'cleaned';
export type WorkType = 'feature' | 'bugfix' | 'refactor' | 'chore' | 'experiment' | 'other';

export interface Studio {
  id: string;
  userId: string;
  agentId: string | null;
  sessionId: string | null;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  purpose: string | null;
  workType: string | null;
  roleTemplate: string | null;
  status: StudioStatus;
  metadata: Json;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  cleanedAt: string | null;
}

export interface CreateStudioInput {
  userId: string;
  agentId?: string;
  identityId?: string;
  sessionId?: string;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseBranch?: string;
  purpose?: string;
  workType?: WorkType;
  roleTemplate?: string;
  metadata?: Json;
}

export interface UpdateStudioInput {
  status?: StudioStatus;
  sessionId?: string | null;
  purpose?: string;
  workType?: WorkType;
  roleTemplate?: string | null;
  metadata?: Json;
  archivedAt?: string;
  cleanedAt?: string;
}

export class StudiosRepository {
  constructor(private client: SupabaseClient<Database>) {}

  private mapRow(row: Record<string, unknown>): Studio {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      agentId: (row.agent_id as string) || null,
      sessionId: (row.session_id as string) || null,
      repoRoot: row.repo_root as string,
      worktreePath: row.worktree_path as string,
      branch: row.branch as string,
      baseBranch: row.base_branch as string,
      purpose: (row.purpose as string) || null,
      workType: (row.work_type as string) || null,
      roleTemplate: (row.role_template as string) || null,
      status: row.status as StudioStatus,
      metadata: (row.metadata as Json) || {},
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      archivedAt: (row.archived_at as string) || null,
      cleanedAt: (row.cleaned_at as string) || null,
    };
  }

  async create(input: CreateStudioInput): Promise<Studio> {
    const identityId =
      input.identityId ||
      (input.agentId ? await resolveIdentityId(this.client, input.userId, input.agentId) : null);

    const insertData: StudiosTable['Insert'] = {
      user_id: input.userId,
      agent_id: input.agentId,
      identity_id: identityId,
      session_id: input.sessionId,
      repo_root: input.repoRoot,
      worktree_path: input.worktreePath,
      branch: input.branch,
      base_branch: input.baseBranch || 'main',
      purpose: input.purpose,
      work_type: input.workType,
      role_template: input.roleTemplate,
      status: 'active',
      metadata: input.metadata || {},
    };

    const { data, error } = await this.client
      .from('studios')
      .insert(insertData as never)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create studio: ${error.message}`);
    }

    return this.mapRow(data as Record<string, unknown>);
  }

  async findById(id: string): Promise<Studio | null> {
    const { data, error } = await this.client.from('studios').select('*').eq('id', id).single();

    if (error && error.code !== 'PGRST116') {
      throw new Error(`Failed to find studio: ${error.message}`);
    }

    return data ? this.mapRow(data as Record<string, unknown>) : null;
  }

  async findByBranch(branch: string): Promise<Studio | null> {
    const { data, error } = await this.client
      .from('studios')
      .select('*')
      .eq('branch', branch)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw new Error(`Failed to find studio by branch: ${error.message}`);
    }

    return data ? this.mapRow(data as Record<string, unknown>) : null;
  }

  async findByPath(worktreePath: string): Promise<Studio | null> {
    const { data, error } = await this.client
      .from('studios')
      .select('*')
      .eq('worktree_path', worktreePath)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw new Error(`Failed to find studio by path: ${error.message}`);
    }

    return data ? this.mapRow(data as Record<string, unknown>) : null;
  }

  async listByUser(
    userId: string,
    opts?: { status?: StudioStatus; agentId?: string }
  ): Promise<Studio[]> {
    let query = this.client
      .from('studios')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (opts?.status) {
      query = query.eq('status', opts.status);
    }

    if (opts?.agentId) {
      query = query.eq('agent_id', opts.agentId);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to list studios: ${error.message}`);
    }

    return (data || []).map((row) => this.mapRow(row as Record<string, unknown>));
  }

  async listByIds(userId: string, ids: string[]): Promise<Studio[]> {
    if (ids.length === 0) {
      return [];
    }

    const { data, error } = await this.client
      .from('studios')
      .select('*')
      .eq('user_id', userId)
      .in('id', ids);

    if (error) {
      throw new Error(`Failed to list studios by ids: ${error.message}`);
    }

    return (data || []).map((row) => this.mapRow(row as Record<string, unknown>));
  }

  async listActive(userId: string): Promise<Studio[]> {
    const { data, error } = await this.client
      .from('studios')
      .select('*')
      .eq('user_id', userId)
      .in('status', ['active', 'idle'])
      .order('updated_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to list active studios: ${error.message}`);
    }

    return (data || []).map((row) => this.mapRow(row as Record<string, unknown>));
  }

  async update(id: string, input: UpdateStudioInput): Promise<Studio> {
    const updateData: Record<string, unknown> = {};

    if (input.status !== undefined) updateData.status = input.status;
    if (input.sessionId !== undefined) updateData.session_id = input.sessionId;
    if (input.purpose !== undefined) updateData.purpose = input.purpose;
    if (input.workType !== undefined) updateData.work_type = input.workType;
    if (input.roleTemplate !== undefined) updateData.role_template = input.roleTemplate;
    if (input.metadata !== undefined) updateData.metadata = input.metadata;
    if (input.archivedAt !== undefined) updateData.archived_at = input.archivedAt;
    if (input.cleanedAt !== undefined) updateData.cleaned_at = input.cleanedAt;

    const { data, error } = await this.client
      .from('studios')
      .update(updateData as never)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update studio: ${error.message}`);
    }

    return this.mapRow(data as Record<string, unknown>);
  }

  async linkSession(id: string, sessionId: string): Promise<Studio> {
    return this.update(id, { sessionId, status: 'active' });
  }

  async unlinkSession(id: string): Promise<Studio> {
    return this.update(id, { sessionId: null, status: 'idle' });
  }

  async markCleaned(id: string): Promise<Studio> {
    return this.update(id, {
      status: 'cleaned',
      cleanedAt: new Date().toISOString(),
    });
  }
}
