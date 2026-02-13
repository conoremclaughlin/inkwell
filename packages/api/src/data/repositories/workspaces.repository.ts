/**
 * Workspaces Repository
 *
 * Manages git worktree workspaces for parallel agent work:
 * - Track active worktrees per user/agent
 * - Link workspaces to sessions
 * - Lifecycle management (active → idle → archived → cleaned)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '../supabase/types';

// Type alias for the table to help with Supabase generics
type WorkspacesTable = Database['public']['Tables']['workspaces'];

export type WorkspaceStatus = 'active' | 'idle' | 'archived' | 'cleaned';
export type WorkType = 'feature' | 'bugfix' | 'refactor' | 'chore' | 'experiment' | 'other';

export interface Workspace {
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
  status: WorkspaceStatus;
  metadata: Json;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  cleanedAt: string | null;
}

export interface CreateWorkspaceInput {
  userId: string;
  agentId?: string;
  sessionId?: string;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseBranch?: string;
  purpose?: string;
  workType?: WorkType;
  metadata?: Json;
}

export interface UpdateWorkspaceInput {
  status?: WorkspaceStatus;
  sessionId?: string | null;
  purpose?: string;
  workType?: WorkType;
  metadata?: Json;
  archivedAt?: string;
  cleanedAt?: string;
}

export class WorkspacesRepository {
  constructor(private client: SupabaseClient<Database>) {}

  /**
   * Map a snake_case DB row to camelCase Workspace interface
   */
  private mapRow(row: Record<string, unknown>): Workspace {
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
      status: row.status as WorkspaceStatus,
      metadata: (row.metadata as Json) || {},
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      archivedAt: (row.archived_at as string) || null,
      cleanedAt: (row.cleaned_at as string) || null,
    };
  }

  /**
   * Create a new workspace
   */
  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    const insertData: WorkspacesTable['Insert'] = {
      user_id: input.userId,
      agent_id: input.agentId,
      session_id: input.sessionId,
      repo_root: input.repoRoot,
      worktree_path: input.worktreePath,
      branch: input.branch,
      base_branch: input.baseBranch || 'main',
      purpose: input.purpose,
      work_type: input.workType,
      status: 'active',
      metadata: input.metadata || {},
    };

    const { data, error } = await this.client
      .from('workspaces')
      .insert(insertData as never)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create workspace: ${error.message}`);
    }

    return this.mapRow(data as Record<string, unknown>);
  }

  /**
   * Find workspace by ID
   */
  async findById(id: string): Promise<Workspace | null> {
    const { data, error } = await this.client
      .from('workspaces')
      .select('*')
      .eq('id', id)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw new Error(`Failed to find workspace: ${error.message}`);
    }

    return data ? this.mapRow(data as Record<string, unknown>) : null;
  }

  /**
   * Find workspace by branch name
   */
  async findByBranch(branch: string): Promise<Workspace | null> {
    const { data, error } = await this.client
      .from('workspaces')
      .select('*')
      .eq('branch', branch)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw new Error(`Failed to find workspace by branch: ${error.message}`);
    }

    return data ? this.mapRow(data as Record<string, unknown>) : null;
  }

  /**
   * Find workspace by worktree path
   */
  async findByPath(worktreePath: string): Promise<Workspace | null> {
    const { data, error } = await this.client
      .from('workspaces')
      .select('*')
      .eq('worktree_path', worktreePath)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw new Error(`Failed to find workspace by path: ${error.message}`);
    }

    return data ? this.mapRow(data as Record<string, unknown>) : null;
  }

  /**
   * List workspaces for a user, optionally filtered by status and/or agentId
   */
  async listByUser(
    userId: string,
    opts?: { status?: WorkspaceStatus; agentId?: string }
  ): Promise<Workspace[]> {
    let query = this.client
      .from('workspaces')
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
      throw new Error(`Failed to list workspaces: ${error.message}`);
    }

    return (data || []).map((row) => this.mapRow(row as Record<string, unknown>));
  }

  /**
   * List workspaces by IDs for a specific user.
   */
  async listByIds(userId: string, ids: string[]): Promise<Workspace[]> {
    if (ids.length === 0) {
      return [];
    }

    const { data, error } = await this.client
      .from('workspaces')
      .select('*')
      .eq('user_id', userId)
      .in('id', ids);

    if (error) {
      throw new Error(`Failed to list workspaces by ids: ${error.message}`);
    }

    return (data || []).map((row) => this.mapRow(row as Record<string, unknown>));
  }

  /**
   * List active workspaces for a user (status in 'active' or 'idle')
   */
  async listActive(userId: string): Promise<Workspace[]> {
    const { data, error } = await this.client
      .from('workspaces')
      .select('*')
      .eq('user_id', userId)
      .in('status', ['active', 'idle'])
      .order('updated_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to list active workspaces: ${error.message}`);
    }

    return (data || []).map((row) => this.mapRow(row as Record<string, unknown>));
  }

  /**
   * Update a workspace
   */
  async update(id: string, input: UpdateWorkspaceInput): Promise<Workspace> {
    const updateData: Record<string, unknown> = {};

    if (input.status !== undefined) {
      updateData.status = input.status;
    }
    if (input.sessionId !== undefined) {
      updateData.session_id = input.sessionId;
    }
    if (input.purpose !== undefined) {
      updateData.purpose = input.purpose;
    }
    if (input.workType !== undefined) {
      updateData.work_type = input.workType;
    }
    if (input.metadata !== undefined) {
      updateData.metadata = input.metadata;
    }
    if (input.archivedAt !== undefined) {
      updateData.archived_at = input.archivedAt;
    }
    if (input.cleanedAt !== undefined) {
      updateData.cleaned_at = input.cleanedAt;
    }

    const { data, error } = await this.client
      .from('workspaces')
      .update(updateData as never)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update workspace: ${error.message}`);
    }

    return this.mapRow(data as Record<string, unknown>);
  }

  /**
   * Link a session to a workspace
   */
  async linkSession(id: string, sessionId: string): Promise<Workspace> {
    return this.update(id, { sessionId, status: 'active' });
  }

  /**
   * Unlink a session from a workspace (sets session_id to null, status to 'idle')
   */
  async unlinkSession(id: string): Promise<Workspace> {
    return this.update(id, { sessionId: null, status: 'idle' });
  }

  /**
   * Mark a workspace as cleaned
   */
  async markCleaned(id: string): Promise<Workspace> {
    return this.update(id, {
      status: 'cleaned',
      cleanedAt: new Date().toISOString(),
    });
  }
}
