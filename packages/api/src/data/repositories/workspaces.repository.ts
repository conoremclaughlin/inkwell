/**
 * Workspaces Repository
 *
 * Product-level workspaces (personal/team), distinct from git worktree studios.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '../supabase/types';

type WorkspacesTable = Database['public']['Tables']['workspaces'];
type WorkspaceMembersTable = Database['public']['Tables']['workspace_members'];

export type WorkspaceType = 'personal' | 'team';
export type WorkspaceMemberRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface Workspace {
  id: string;
  userId: string;
  name: string;
  slug: string;
  type: WorkspaceType;
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

export interface WorkspaceMemberUser {
  id: string;
  email: string | null;
  firstName: string | null;
  username: string | null;
  lastLoginAt: string | null;
}

export interface WorkspaceMemberWithUser extends WorkspaceMember {
  user: WorkspaceMemberUser | null;
}

export interface WorkspaceMembership extends Workspace {
  role: WorkspaceMemberRole;
  membershipCreatedAt: string;
}

export interface CreateWorkspaceInput {
  userId: string;
  name: string;
  slug: string;
  type?: WorkspaceType;
  description?: string;
  metadata?: Json;
}

export interface UpdateWorkspaceInput {
  name?: string;
  slug?: string;
  type?: WorkspaceType;
  description?: string | null;
  metadata?: Json;
  archivedAt?: string | null;
}

export class WorkspacesRepository {
  constructor(private client: SupabaseClient<Database>) {}

  private mapContainerRow(row: Record<string, unknown>): Workspace {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      name: row.name as string,
      slug: row.slug as string,
      type: row.type as WorkspaceType,
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

  async findRawById(id: string): Promise<Workspace | null> {
    const { data, error } = await this.client.from('workspaces').select('*').eq('id', id).single();

    if (error && error.code !== 'PGRST116') {
      throw new Error(`Failed to find workspace: ${error.message}`);
    }

    return data ? this.mapContainerRow(data as Record<string, unknown>) : null;
  }

  async findMembership(workspaceId: string, userId: string): Promise<WorkspaceMember | null> {
    const { data, error } = await this.client
      .from('workspace_members')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to find workspace membership: ${error.message}`);
    }

    return data ? this.mapMemberRow(data as Record<string, unknown>) : null;
  }

  async getMemberRole(workspaceId: string, userId: string): Promise<WorkspaceMemberRole | null> {
    const membership = await this.findMembership(workspaceId, userId);
    return membership?.role ?? null;
  }

  async canManageWorkspace(workspaceId: string, userId: string): Promise<boolean> {
    const role = await this.getMemberRole(workspaceId, userId);
    return role === 'owner' || role === 'admin';
  }

  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    const insertData: WorkspacesTable['Insert'] = {
      user_id: input.userId,
      name: input.name,
      slug: input.slug,
      type: input.type || 'personal',
      description: input.description,
      metadata: input.metadata || {},
    };

    const { data, error } = await this.client
      .from('workspaces')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create workspace: ${error.message}`);
    }

    return this.mapContainerRow(data as Record<string, unknown>);
  }

  async findById(id: string, userId: string): Promise<Workspace | null> {
    const membership = await this.findMembership(id, userId);
    if (!membership) {
      return null;
    }

    return this.findRawById(id);
  }

  async listMembershipsByUser(
    userId: string,
    opts?: {
      type?: WorkspaceType;
      includeArchived?: boolean;
    }
  ): Promise<WorkspaceMembership[]> {
    const { data: membershipRows, error: membershipError } = await this.client
      .from('workspace_members')
      .select('*')
      .eq('user_id', userId);

    if (membershipError) {
      throw new Error(`Failed to list workspace memberships: ${membershipError.message}`);
    }

    const memberships = (membershipRows || []).map((row) =>
      this.mapMemberRow(row as Record<string, unknown>)
    );
    if (memberships.length === 0) {
      return [];
    }

    const workspaceIds = Array.from(
      new Set(memberships.map((membership) => membership.workspaceId))
    );
    let query = this.client
      .from('workspaces')
      .select('*')
      .in('id', workspaceIds)
      .order('updated_at', { ascending: false });

    if (opts?.type) {
      query = query.eq('type', opts.type);
    }

    if (!opts?.includeArchived) {
      query = query.is('archived_at', null);
    }

    const { data: workspaceRows, error: workspaceError } = await query;
    if (workspaceError) {
      throw new Error(`Failed to list workspaces: ${workspaceError.message}`);
    }

    const workspaceById = new Map<string, Workspace>();
    for (const row of workspaceRows || []) {
      const workspace = this.mapContainerRow(row as Record<string, unknown>);
      workspaceById.set(workspace.id, workspace);
    }

    const membershipByWorkspaceId = new Map<string, WorkspaceMember>();
    for (const membership of memberships) {
      membershipByWorkspaceId.set(membership.workspaceId, membership);
    }

    const results: WorkspaceMembership[] = [];
    for (const workspace of workspaceById.values()) {
      const membership = membershipByWorkspaceId.get(workspace.id);
      if (!membership) continue;
      results.push({
        ...workspace,
        role: membership.role,
        membershipCreatedAt: membership.createdAt,
      });
    }

    return results;
  }

  async listByUser(
    userId: string,
    opts?: {
      type?: WorkspaceType;
      includeArchived?: boolean;
    }
  ): Promise<Workspace[]> {
    const memberships = await this.listMembershipsByUser(userId, opts);
    return memberships.map((membership) => ({
      id: membership.id,
      userId: membership.userId,
      name: membership.name,
      slug: membership.slug,
      type: membership.type,
      description: membership.description,
      metadata: membership.metadata,
      createdAt: membership.createdAt,
      updatedAt: membership.updatedAt,
      archivedAt: membership.archivedAt,
    }));
  }

  async update(id: string, userId: string, input: UpdateWorkspaceInput): Promise<Workspace> {
    const updateData: WorkspacesTable['Update'] = {};

    if (input.name !== undefined) updateData.name = input.name;
    if (input.slug !== undefined) updateData.slug = input.slug;
    if (input.type !== undefined) updateData.type = input.type;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.metadata !== undefined) updateData.metadata = input.metadata;
    if (input.archivedAt !== undefined) updateData.archived_at = input.archivedAt;

    const { data, error } = await this.client
      .from('workspaces')
      .update(updateData)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update workspace: ${error.message}`);
    }

    return this.mapContainerRow(data as Record<string, unknown>);
  }

  async ensurePersonalWorkspace(userId: string): Promise<Workspace> {
    const { data: existing, error: existingError } = await this.client
      .from('workspaces')
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
      .upsert(insertData, {
        onConflict: 'workspace_id,user_id',
        ignoreDuplicates: false,
      })
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

  async listMembersWithUsers(workspaceId: string): Promise<WorkspaceMemberWithUser[]> {
    const members = await this.listMembers(workspaceId);
    if (members.length === 0) {
      return [];
    }

    const uniqueUserIds = Array.from(new Set(members.map((member) => member.userId)));
    const { data: users, error } = await this.client
      .from('users')
      .select('id, email, first_name, username, last_login_at')
      .in('id', uniqueUserIds);

    if (error) {
      throw new Error(`Failed to resolve workspace member profiles: ${error.message}`);
    }

    const usersById = new Map(
      (users || []).map((user) => [
        user.id,
        {
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          username: user.username,
          lastLoginAt: user.last_login_at,
        } as WorkspaceMemberUser,
      ])
    );

    return members.map((member) => ({
      ...member,
      user: usersById.get(member.userId) ?? null,
    }));
  }
}
