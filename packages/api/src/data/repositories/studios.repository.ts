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
  /** Canonical identity UUID — authoritative; agentId is a display slug. */
  sbId: string | null;
  sessionId: string | null;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  purpose: string | null;
  workType: string | null;
  slug: string | null;
  roleTemplate: string | null;
  defaultProjectId: string | null;
  status: StudioStatus;
  metadata: Json;
  /** Occupancy record — see StudioLeaseService. Null = vacant. */
  lease: Json | null;
  ephemeral: boolean;
  parentStudioId: string | null;
  /** Thread this studio was provisioned for. Overflow studios only. */
  threadKey: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  cleanedAt: string | null;
}

export interface CreateStudioInput {
  userId: string;
  agentId?: string;
  sbId?: string;
  sessionId?: string;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseBranch?: string;
  purpose?: string;
  workType?: WorkType;
  roleTemplate?: string;
  defaultProjectId?: string | null;
  ephemeral?: boolean;
  parentStudioId?: string | null;
  threadKey?: string | null;
  expiresAt?: string | null;
  metadata?: Json;
  /**
   * Explicit slug. REQUIRED when the worktree path does not follow the
   * legacy `<repo>--<slug>` sibling convention (e.g. ephemeral studios under
   * ~/.ink/studios) — the derived fallback would come back null there and
   * silently break reuse-by-slug.
   */
  slug?: string | null;
}

export interface UpdateStudioInput {
  status?: StudioStatus;
  sessionId?: string | null;
  purpose?: string;
  workType?: WorkType;
  roleTemplate?: string | null;
  worktreePath?: string;
  slug?: string | null;
  defaultProjectId?: string | null;
  metadata?: Json;
  /** Nullable: reviving an archived ephemeral studio must be able to clear it. */
  archivedAt?: string | null;
  cleanedAt?: string | null;
  expiresAt?: string | null;
  routePatterns?: string[];
}

/**
 * Derive a studio slug from the worktree folder path.
 * Convention: folders are named <repo>--<slug>, e.g.
 *   /path/to/personal-context-protocol--wren → "wren"
 */
export function deriveStudioSlug(worktreePath: string): string | null {
  const folder = worktreePath.split('/').pop() || '';
  const idx = folder.indexOf('--');
  if (idx === -1) return null;
  return folder.slice(idx + 2) || null;
}

export class StudiosRepository {
  constructor(private client: SupabaseClient<Database>) {}

  private mapRow(row: Record<string, unknown>): Studio {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      agentId: (row.agent_id as string) || null,
      sbId: (row.sb_id as string) || null,
      sessionId: (row.session_id as string) || null,
      repoRoot: row.repo_root as string,
      worktreePath: row.worktree_path as string,
      branch: row.branch as string,
      baseBranch: row.base_branch as string,
      purpose: (row.purpose as string) || null,
      workType: (row.work_type as string) || null,
      slug: (row.slug as string) || null,
      roleTemplate: (row.role_template as string) || null,
      defaultProjectId: (row.default_project_id as string) || null,
      status: row.status as StudioStatus,
      metadata: (row.metadata as Json) || {},
      lease: (row.lease as Json) ?? null,
      ephemeral: Boolean(row.ephemeral),
      parentStudioId: (row.parent_studio_id as string) || null,
      threadKey: (row.thread_key as string) || null,
      expiresAt: (row.expires_at as string) || null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      archivedAt: (row.archived_at as string) || null,
      cleanedAt: (row.cleaned_at as string) || null,
    };
  }

  async create(input: CreateStudioInput): Promise<Studio> {
    const sbId =
      input.sbId ||
      (input.agentId ? await resolveIdentityId(this.client, input.userId, input.agentId) : null);

    const insertData: StudiosTable['Insert'] = {
      user_id: input.userId,
      agent_id: input.agentId,
      sb_id: sbId,
      session_id: input.sessionId,
      repo_root: input.repoRoot,
      worktree_path: input.worktreePath,
      branch: input.branch,
      base_branch: input.baseBranch || 'main',
      purpose: input.purpose,
      work_type: input.workType,
      role_template: input.roleTemplate,
      default_project_id: input.defaultProjectId ?? null,
      ephemeral: input.ephemeral ?? false,
      parent_studio_id: input.parentStudioId ?? null,
      thread_key: input.threadKey ?? null,
      expires_at: input.expiresAt ?? null,
      slug: input.slug !== undefined ? input.slug : deriveStudioSlug(input.worktreePath),
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

  async findByBranch(
    branch: string,
    scope?: { userId?: string; agentId?: string }
  ): Promise<Studio | null> {
    let q = this.client.from('studios').select('*').eq('branch', branch);
    if (scope?.userId) q = q.eq('user_id', scope.userId);
    if (scope?.agentId) q = q.eq('agent_id', scope.agentId);
    q = q.order('updated_at', { ascending: false }).limit(1);

    const { data, error } = await q.maybeSingle();

    if (error) {
      throw new Error(`Failed to find studio by branch: ${error.message}`);
    }

    return data ? this.mapRow(data as Record<string, unknown>) : null;
  }

  async findByPath(
    worktreePath: string,
    scope?: { userId?: string; agentId?: string }
  ): Promise<Studio | null> {
    let q = this.client.from('studios').select('*').eq('worktree_path', worktreePath);
    if (scope?.userId) q = q.eq('user_id', scope.userId);
    if (scope?.agentId) q = q.eq('agent_id', scope.agentId);
    q = q.order('updated_at', { ascending: false }).limit(1);

    const { data, error } = await q.maybeSingle();

    if (error) {
      throw new Error(`Failed to find studio by path: ${error.message}`);
    }

    return data ? this.mapRow(data as Record<string, unknown>) : null;
  }

  /**
   * Look up a studio by its human-readable slug, scoped to a user.
   * Slugs (e.g. "wren", "wren-omega") are what users speak about; they
   * resolve to UUIDs for DB operations. Scoped to user_id because slug
   * uniqueness is only guaranteed per-user, not globally.
   */
  async findBySlug(userId: string, slug: string): Promise<Studio | null> {
    const { data, error } = await this.client
      .from('studios')
      .select('*')
      .eq('user_id', userId)
      .eq('slug', slug)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw new Error(`Failed to find studio by slug: ${error.message}`);
    }

    return data ? this.mapRow(data as Record<string, unknown>) : null;
  }

  /**
   * Any studio already bound to this repo, used as a provisioning seed: it
   * tells us the repo's base branch and project without inventing either.
   * Oldest-first so the seed is the most established row, not the newest.
   */
  async findByRepoRoot(userId: string, repoRoot: string): Promise<Studio | null> {
    const { data, error } = await this.client
      .from('studios')
      .select('*')
      .eq('user_id', userId)
      .eq('repo_root', repoRoot)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to find studio by repo root: ${error.message}`);
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

  /** Ephemeral studios created for a thread's overflow. Indexed on (user_id, thread_key). */
  async listEphemeralByThread(userId: string, threadKey: string): Promise<Studio[]> {
    const { data, error } = await this.client
      .from('studios')
      .select('*')
      .eq('user_id', userId)
      .eq('ephemeral', true)
      .eq('thread_key', threadKey)
      .in('status', ['active', 'idle']);

    if (error) {
      throw new Error(`Failed to list ephemeral studios by thread: ${error.message}`);
    }

    return (data || []).map((row) => this.mapRow(row as Record<string, unknown>));
  }

  /** Ephemeral studios past their expires_at, still open. Sweep candidates. */
  async listExpiredEphemeral(asOfIso: string): Promise<Studio[]> {
    const { data, error } = await this.client
      .from('studios')
      .select('*')
      .eq('ephemeral', true)
      .not('expires_at', 'is', null)
      .lte('expires_at', asOfIso)
      .in('status', ['active', 'idle']);

    if (error) {
      throw new Error(`Failed to list expired ephemeral studios: ${error.message}`);
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
    if (input.worktreePath !== undefined) updateData.worktree_path = input.worktreePath;
    if (input.slug !== undefined) updateData.slug = input.slug;
    if (input.defaultProjectId !== undefined)
      updateData.default_project_id = input.defaultProjectId;
    if (input.metadata !== undefined) updateData.metadata = input.metadata;
    if (input.archivedAt !== undefined) updateData.archived_at = input.archivedAt;
    if (input.cleanedAt !== undefined) updateData.cleaned_at = input.cleanedAt;
    if (input.expiresAt !== undefined) updateData.expires_at = input.expiresAt;
    if (input.routePatterns !== undefined) updateData.route_patterns = input.routePatterns;

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
