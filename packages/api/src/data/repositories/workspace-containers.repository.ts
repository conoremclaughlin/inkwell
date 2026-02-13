/**
 * Workspace Containers Repository
 *
 * Product-level workspace containers (personal/team), distinct from git worktree studios.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '../supabase/types';

type WorkspaceContainersTable = Database['public']['Tables']['workspace_containers'];
type WorkspaceMembersTable = Database['public']['Tables']['workspace_members'];

export type WorkspaceContainerType = 'personal' | 'team';
export type WorkspaceMemberRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface WorkspaceContainer {
  id: string;
  userId: string;
  name: string;
  slug: string;
  type: WorkspaceContainerType;
  description: string | null;
  metadata: Json;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceMemberRole;
  createdAt: string;
}

export interface CreateWorkspaceContainerInput {
  userId: string;
  name: string;
  slug: string;
  type?: WorkspaceContainerType;
  description?: string;
  metadata?: Json;
}

export interface UpdateWorkspaceContainerInput {
  name?: string;
  slug?: string;
  type?: WorkspaceContainerType;
  description?: string | null;
  metadata?: Json;
  archivedAt?: string | null;
}

export class WorkspaceContainersRepository {
  constructor(private client: SupabaseClient<Database>) {}

  private mapContainerRow(row: Record<string, unknown>): WorkspaceContainer {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      name: row.name as string,
      slug: row.slug as string,
      type: row.type as WorkspaceContainerType,
      description: (row.description as string) || null,
      metadata: (row.metadata as Json) || {},
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      archivedAt: (row.archived_at as string) || null,
    };
  }

  private mapMemberRow(row: Record<string, unknown>): WorkspaceMember {
    return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      userId: row.user_id as string,
      role: row.role as WorkspaceMemberRole,
      createdAt: row.created_at as string,
    };
  }

  async create(input: CreateWorkspaceContainerInput): Promise<WorkspaceContainer> {
    const insertData: WorkspaceContainersTable['Insert'] = {
      user_id: input.userId,
      name: input.name,
      slug: input.slug,
      type: input.type || 'personal',
      description: input.description,
      metadata: input.metadata || {},
    };

    const { data, error } = await this.client
      .from('workspace_containers')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create workspace container: ${error.message}`);
    }

    return this.mapContainerRow(data as Record<string, unknown>);
  }

  async findById(id: string, userId: string): Promise<WorkspaceContainer | null> {
    const { data, error } = await this.client
      .from('workspace_containers')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw new Error(`Failed to find workspace container: ${error.message}`);
    }

    return data ? this.mapContainerRow(data as Record<string, unknown>) : null;
  }

  async listByUser(
    userId: string,
    opts?: {
      type?: WorkspaceContainerType;
      includeArchived?: boolean;
    }
  ): Promise<WorkspaceContainer[]> {
    let query = this.client
      .from('workspace_containers')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (opts?.type) {
      query = query.eq('type', opts.type);
    }

    if (!opts?.includeArchived) {
      query = query.is('archived_at', null);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to list workspace containers: ${error.message}`);
    }

    return (data || []).map((row) => this.mapContainerRow(row as Record<string, unknown>));
  }

  async update(
    id: string,
    userId: string,
    input: UpdateWorkspaceContainerInput
  ): Promise<WorkspaceContainer> {
    const updateData: WorkspaceContainersTable['Update'] = {};

    if (input.name !== undefined) updateData.name = input.name;
    if (input.slug !== undefined) updateData.slug = input.slug;
    if (input.type !== undefined) updateData.type = input.type;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.metadata !== undefined) updateData.metadata = input.metadata;
    if (input.archivedAt !== undefined) updateData.archived_at = input.archivedAt;

    const { data, error } = await this.client
      .from('workspace_containers')
      .update(updateData)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update workspace container: ${error.message}`);
    }

    return this.mapContainerRow(data as Record<string, unknown>);
  }

  async ensurePersonalWorkspace(userId: string): Promise<WorkspaceContainer> {
    const { data: existing, error: existingError } = await this.client
      .from('workspace_containers')
      .select('*')
      .eq('user_id', userId)
      .eq('slug', 'personal')
      .is('archived_at', null)
      .maybeSingle();

    if (existingError) {
      throw new Error(`Failed to look up personal workspace: ${existingError.message}`);
    }

    if (existing) {
      return this.mapContainerRow(existing as Record<string, unknown>);
    }

    const created = await this.create({
      userId,
      name: 'Personal',
      slug: 'personal',
      type: 'personal',
    });

    await this.addMember(created.id, userId, 'owner');
    return created;
  }

  async addMember(
    workspaceId: string,
    memberUserId: string,
    role: WorkspaceMemberRole
  ): Promise<WorkspaceMember> {
    const insertData: WorkspaceMembersTable['Insert'] = {
      workspace_id: workspaceId,
      user_id: memberUserId,
      role,
    };

    const { data, error } = await this.client
      .from('workspace_members')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to add workspace member: ${error.message}`);
    }

    return this.mapMemberRow(data as Record<string, unknown>);
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    const { data, error } = await this.client
      .from('workspace_members')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to list workspace members: ${error.message}`);
    }

    return (data || []).map((row) => this.mapMemberRow(row as Record<string, unknown>));
  }
}
