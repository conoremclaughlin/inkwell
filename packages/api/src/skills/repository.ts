/**
 * Skills Repository
 *
 * Database operations for the cloud-based skills registry.
 * Handles skills, versions, and user installations.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger';
import type {
  DbSkill,
  DbSkillVersion,
  DbSkillInstallation,
  UserInstalledSkill,
  ListRegistrySkillsOptions,
  InstallSkillOptions,
  PublishSkillOptions,
  RegistrySkillSummary,
  RegistrySkillDetail,
  SkillManifest,
  ForkSkillOptions,
  DeprecateSkillOptions,
  UpdateSkillContentOptions,
  DbSkillWithManagement,
} from './types';

// Helper to convert snake_case DB rows to camelCase
function toCamelCase<T>(row: Record<string, unknown>): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    result[camelKey] = value;
  }
  return result as T;
}

export class SkillsRepository {
  constructor(private supabase: SupabaseClient) {}

  // ===========================================================================
  // Registry Operations (Browse/Search)
  // ===========================================================================

  /**
   * List skills from the registry
   */
  async listRegistrySkills(
    options: ListRegistrySkillsOptions = {},
    currentUserId?: string
  ): Promise<{ skills: RegistrySkillSummary[]; total: number }> {
    const { type, category, search, isOfficial, limit = 50, offset = 0 } = options;

    let query = this.supabase
      .from('skills')
      .select('*', { count: 'exact' })
      .eq('is_public', true)
      .order('install_count', { ascending: false });

    if (type) {
      query = query.eq('type', type);
    }
    if (category) {
      query = query.eq('category', category);
    }
    if (isOfficial !== undefined) {
      query = query.eq('is_official', isOfficial);
    }
    if (search) {
      query = query.or(
        `name.ilike.%${search}%,display_name.ilike.%${search}%,description.ilike.%${search}%`
      );
    }

    query = query.range(offset, offset + limit - 1);

    const { data, error, count } = await query;

    if (error) {
      logger.error('Failed to list registry skills:', error);
      throw error;
    }

    // If user is logged in, check which skills they have installed
    let installedSkillIds: Set<string> = new Set();
    if (currentUserId) {
      const { data: installations } = await this.supabase
        .from('skill_installations')
        .select('skill_id')
        .eq('user_id', currentUserId);

      if (installations) {
        installedSkillIds = new Set(installations.map((i) => i.skill_id));
      }
    }

    const skills: RegistrySkillSummary[] = (data || []).map((row) => ({
      id: row.id,
      name: row.name,
      displayName: row.display_name,
      description: row.description,
      type: row.type,
      category: row.category,
      tags: row.tags || [],
      emoji: row.emoji,
      currentVersion: row.current_version,
      author: row.author,
      isOfficial: row.is_official,
      isVerified: row.is_verified,
      installCount: row.install_count,
      isInstalled: installedSkillIds.has(row.id),
    }));

    return { skills, total: count || 0 };
  }

  /**
   * Get skill detail by ID or name
   */
  async getRegistrySkill(
    idOrName: string,
    currentUserId?: string
  ): Promise<RegistrySkillDetail | null> {
    // Try by ID first, then by name
    let query = this.supabase.from('skills').select('*').eq('is_public', true);

    // Check if it's a UUID
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrName);
    if (isUuid) {
      query = query.eq('id', idOrName);
    } else {
      query = query.eq('name', idOrName);
    }

    const { data: skill, error } = await query.single();

    if (error || !skill) {
      return null;
    }

    // Get versions
    const { data: versions } = await this.supabase
      .from('skill_versions')
      .select('version, published_at, changelog')
      .eq('skill_id', skill.id)
      .order('published_at', { ascending: false });

    // Check if installed
    let isInstalled = false;
    if (currentUserId) {
      const { data: installation } = await this.supabase
        .from('skill_installations')
        .select('id')
        .eq('user_id', currentUserId)
        .eq('skill_id', skill.id)
        .single();

      isInstalled = !!installation;
    }

    return {
      id: skill.id,
      name: skill.name,
      displayName: skill.display_name,
      description: skill.description,
      type: skill.type,
      category: skill.category,
      tags: skill.tags || [],
      emoji: skill.emoji,
      currentVersion: skill.current_version,
      author: skill.author,
      isOfficial: skill.is_official,
      isVerified: skill.is_verified,
      installCount: skill.install_count,
      isInstalled,
      manifest: skill.manifest as SkillManifest,
      content: skill.content,
      repositoryUrl: skill.repository_url,
      homepageUrl: skill.homepage_url,
      versions: (versions || []).map((v) => ({
        version: v.version,
        publishedAt: v.published_at,
        changelog: v.changelog,
      })),
    };
  }

  /**
   * Get available categories
   */
  async getCategories(): Promise<string[]> {
    const { data, error } = await this.supabase
      .from('skills')
      .select('category')
      .eq('is_public', true)
      .not('category', 'is', null);

    if (error) {
      logger.error('Failed to get categories:', error);
      return [];
    }

    const categories = [...new Set(data?.map((r) => r.category).filter(Boolean))];
    return categories.sort();
  }

  // ===========================================================================
  // Installation Operations
  // ===========================================================================

  /**
   * Install a skill for a user
   */
  async installSkill(options: InstallSkillOptions): Promise<DbSkillInstallation> {
    const { skillId, userId, versionPinned, config } = options;

    const { data, error } = await this.supabase
      .from('skill_installations')
      .upsert(
        {
          user_id: userId,
          skill_id: skillId,
          version_pinned: versionPinned || null,
          config: config || {},
          enabled: true,
        },
        { onConflict: 'user_id,skill_id' }
      )
      .select()
      .single();

    if (error) {
      logger.error('Failed to install skill:', error);
      throw error;
    }

    return toCamelCase<DbSkillInstallation>(data);
  }

  /**
   * Uninstall a skill for a user
   */
  async uninstallSkill(skillId: string, userId: string): Promise<void> {
    const { error } = await this.supabase
      .from('skill_installations')
      .delete()
      .eq('skill_id', skillId)
      .eq('user_id', userId);

    if (error) {
      logger.error('Failed to uninstall skill:', error);
      throw error;
    }
  }

  /**
   * Get user's installed skills
   */
  async getUserInstalledSkills(userId: string): Promise<UserInstalledSkill[]> {
    const { data, error } = await this.supabase
      .from('skill_installations')
      .select('*')
      .eq('user_id', userId)
      .eq('enabled', true);

    if (error) {
      logger.error('Failed to get user installed skills:', error);
      throw error;
    }

    return (data || []).map((row) => toCamelCase<UserInstalledSkill>(row));
  }

  /**
   * Update skill installation settings
   */
  async updateInstallation(
    installationId: string,
    userId: string,
    updates: Partial<{
      enabled: boolean;
      versionPinned: string | null;
      config: Record<string, unknown>;
    }>
  ): Promise<DbSkillInstallation> {
    const updateData: Record<string, unknown> = {};
    if (updates.enabled !== undefined) updateData.enabled = updates.enabled;
    if (updates.versionPinned !== undefined) updateData.version_pinned = updates.versionPinned;
    if (updates.config !== undefined) updateData.config = updates.config;

    const { data, error } = await this.supabase
      .from('skill_installations')
      .update(updateData)
      .eq('id', installationId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      logger.error('Failed to update installation:', error);
      throw error;
    }

    return toCamelCase<DbSkillInstallation>(data);
  }

  /**
   * Record skill usage
   */
  async recordUsage(skillId: string, userId: string): Promise<void> {
    const { error } = await this.supabase
      .from('skill_installations')
      .update({
        last_used_at: new Date().toISOString(),
        usage_count: this.supabase.rpc('increment_usage_count'),
      })
      .eq('skill_id', skillId)
      .eq('user_id', userId);

    if (error) {
      // Non-critical, just log
      logger.warn('Failed to record skill usage:', error);
    }
  }

  // ===========================================================================
  // Publishing Operations
  // ===========================================================================

  /**
   * Publish a new skill to the registry.
   *
   * Also creates an initial version record in code for portability.
   */
  async publishSkill(options: PublishSkillOptions): Promise<DbSkill> {
    const {
      name,
      displayName,
      description,
      type,
      category,
      tags,
      emoji,
      version,
      manifest,
      content,
      authorUserId,
      repositoryUrl,
      isPublic = true,
    } = options;

    const fullManifest: SkillManifest = {
      name,
      version,
      displayName,
      description,
      type,
      category,
      tags,
      emoji,
      ...manifest,
    };

    const { data, error } = await this.supabase
      .from('skills')
      .upsert(
        {
          name,
          display_name: displayName,
          description,
          type,
          category: category || null,
          tags: tags || [],
          emoji: emoji || null,
          current_version: version,
          manifest: fullManifest,
          content,
          author_user_id: authorUserId || null,
          repository_url: repositoryUrl || null,
          is_public: isPublic,
          published_at: new Date().toISOString(),
          last_published_by: authorUserId || null,
        },
        { onConflict: 'name' }
      )
      .select()
      .single();

    if (error) {
      logger.error('Failed to publish skill:', error);
      throw error;
    }

    // Create initial version record in code (not relying on DB trigger)
    const { error: versionError } = await this.supabase.from('skill_versions').upsert(
      {
        skill_id: data.id,
        version,
        manifest: fullManifest,
        content,
        changelog: 'Initial release',
        published_by: authorUserId || null,
        published_at: new Date().toISOString(),
      },
      { onConflict: 'skill_id,version' }
    );

    if (versionError) {
      logger.warn('Failed to create initial version record:', versionError);
    } else {
      logger.info(`Initial version ${version} created for skill ${name}`);
    }

    return toCamelCase<DbSkill>(data);
  }

  /**
   * Update an existing skill (creates new version automatically via trigger)
   */
  async updateSkill(
    skillId: string,
    authorUserId: string,
    updates: Partial<{
      displayName: string;
      description: string;
      category: string;
      tags: string[];
      emoji: string;
      version: string;
      manifest: Partial<SkillManifest>;
      content: string;
    }>
  ): Promise<DbSkill> {
    // Verify ownership
    const { data: existing } = await this.supabase
      .from('skills')
      .select('author_user_id')
      .eq('id', skillId)
      .single();

    if (!existing || existing.author_user_id !== authorUserId) {
      throw new Error('Unauthorized: You can only update your own skills');
    }

    const updateData: Record<string, unknown> = {};
    if (updates.displayName) updateData.display_name = updates.displayName;
    if (updates.description) updateData.description = updates.description;
    if (updates.category !== undefined) updateData.category = updates.category;
    if (updates.tags) updateData.tags = updates.tags;
    if (updates.emoji !== undefined) updateData.emoji = updates.emoji;
    if (updates.version) updateData.current_version = updates.version;
    if (updates.manifest) updateData.manifest = updates.manifest;
    if (updates.content) updateData.content = updates.content;

    const { data, error } = await this.supabase
      .from('skills')
      .update(updateData)
      .eq('id', skillId)
      .select()
      .single();

    if (error) {
      logger.error('Failed to update skill:', error);
      throw error;
    }

    return toCamelCase<DbSkill>(data);
  }

  // ===========================================================================
  // Version Operations
  // ===========================================================================

  /**
   * Get all versions of a skill
   */
  async getSkillVersions(skillId: string): Promise<DbSkillVersion[]> {
    const { data, error } = await this.supabase
      .from('skill_versions')
      .select('*')
      .eq('skill_id', skillId)
      .order('published_at', { ascending: false });

    if (error) {
      logger.error('Failed to get skill versions:', error);
      throw error;
    }

    return (data || []).map((row) => toCamelCase<DbSkillVersion>(row));
  }

  /**
   * Get a specific version of a skill
   */
  async getSkillVersion(skillId: string, version: string): Promise<DbSkillVersion | null> {
    const { data, error } = await this.supabase
      .from('skill_versions')
      .select('*')
      .eq('skill_id', skillId)
      .eq('version', version)
      .single();

    if (error) {
      return null;
    }

    return toCamelCase<DbSkillVersion>(data);
  }

  // ===========================================================================
  // Skill Management Operations
  // ===========================================================================

  /**
   * Check skill ownership for authorization
   */
  private async checkSkillOwnership(
    skillId: string,
    userId: string
  ): Promise<{ authorized: boolean; skill: DbSkillWithManagement | null; reason?: string }> {
    const { data: skill, error } = await this.supabase
      .from('skills')
      .select('*')
      .eq('id', skillId)
      .single();

    if (error || !skill) {
      return { authorized: false, skill: null, reason: 'Skill not found' };
    }

    const dbSkill = toCamelCase<DbSkillWithManagement>(skill);

    // Official skills can only be modified by the original author (admin check done at API level)
    if (dbSkill.isOfficial && dbSkill.authorUserId !== userId) {
      return {
        authorized: false,
        skill: dbSkill,
        reason: 'Official skills can only be modified by administrators',
      };
    }

    // Regular skill - check author
    if (dbSkill.authorUserId && dbSkill.authorUserId !== userId) {
      return { authorized: false, skill: dbSkill, reason: 'You can only modify your own skills' };
    }

    // Skill has no author (legacy) - allow modification
    if (!dbSkill.authorUserId) {
      return { authorized: true, skill: dbSkill };
    }

    return { authorized: true, skill: dbSkill };
  }

  /**
   * Fork an existing skill to create a user's own copy
   */
  async forkSkill(options: ForkSkillOptions): Promise<DbSkillWithManagement> {
    const { sourceSkillId, newName, newDisplayName, forkerUserId, customizations } = options;

    // Get source skill (must be public)
    const { data: source, error: sourceError } = await this.supabase
      .from('skills')
      .select('*')
      .eq('id', sourceSkillId)
      .eq('is_public', true)
      .single();

    if (sourceError || !source) {
      throw new Error('Source skill not found or not public');
    }

    // Check name availability
    const { data: existing } = await this.supabase
      .from('skills')
      .select('id')
      .eq('name', newName)
      .single();

    if (existing) {
      throw new Error(`Skill name "${newName}" is already taken`);
    }

    // Create forked skill
    const { data, error } = await this.supabase
      .from('skills')
      .insert({
        name: newName,
        display_name: newDisplayName || `${source.display_name} (Fork)`,
        description: customizations?.description || source.description,
        type: source.type,
        category: customizations?.category || source.category,
        tags: customizations?.tags || source.tags,
        emoji: source.emoji,
        current_version: '1.0.0',
        manifest: source.manifest,
        content: source.content,
        author_user_id: forkerUserId,
        forked_from_id: sourceSkillId,
        is_official: false,
        is_public: true,
        is_verified: false,
        status: 'active',
        repository_url: null,
        homepage_url: null,
        last_published_by: forkerUserId,
        published_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      logger.error('Failed to fork skill:', error);
      throw error;
    }

    // Create initial version record for forked skill
    const { error: versionError } = await this.supabase.from('skill_versions').upsert(
      {
        skill_id: data.id,
        version: '1.0.0',
        manifest: source.manifest,
        content: source.content,
        changelog: `Forked from ${source.name}`,
        published_by: forkerUserId,
        published_at: new Date().toISOString(),
      },
      { onConflict: 'skill_id,version' }
    );

    if (versionError) {
      logger.warn('Failed to create version record for fork:', versionError);
    }

    logger.info(`Skill forked: ${source.name} -> ${newName} by user ${forkerUserId}`);
    return toCamelCase<DbSkillWithManagement>(data);
  }

  /**
   * Deprecate a skill
   */
  async deprecateSkill(options: DeprecateSkillOptions): Promise<DbSkillWithManagement> {
    const { skillId, userId, message } = options;

    // Verify ownership
    const auth = await this.checkSkillOwnership(skillId, userId);
    if (!auth.authorized) {
      throw new Error(auth.reason || 'Unauthorized');
    }

    const { data, error } = await this.supabase
      .from('skills')
      .update({
        status: 'deprecated',
        deprecated_at: new Date().toISOString(),
        deprecated_by: userId,
        deprecation_message: message || null,
      })
      .eq('id', skillId)
      .select()
      .single();

    if (error) {
      logger.error('Failed to deprecate skill:', error);
      throw error;
    }

    logger.info(`Skill deprecated: ${auth.skill?.name} by user ${userId}`);
    return toCamelCase<DbSkillWithManagement>(data);
  }

  /**
   * Soft-delete a skill
   */
  async deleteSkill(skillId: string, userId: string): Promise<void> {
    const auth = await this.checkSkillOwnership(skillId, userId);
    if (!auth.authorized) {
      throw new Error(auth.reason || 'Unauthorized');
    }

    const { error } = await this.supabase
      .from('skills')
      .update({ status: 'deleted' })
      .eq('id', skillId);

    if (error) {
      logger.error('Failed to delete skill:', error);
      throw error;
    }

    logger.info(`Skill deleted: ${auth.skill?.name} by user ${userId}`);
  }

  /**
   * Update skill with version bump and explicit version record creation.
   *
   * Note: This handles version creation in code rather than via DB trigger
   * for better portability across database systems.
   */
  async updateSkillWithVersion(
    skillId: string,
    authorUserId: string,
    updates: UpdateSkillContentOptions
  ): Promise<DbSkillWithManagement> {
    // Verify ownership
    const auth = await this.checkSkillOwnership(skillId, authorUserId);
    if (!auth.authorized) {
      throw new Error(auth.reason || 'Unauthorized');
    }

    const existingSkill = auth.skill!;
    const updateData: Record<string, unknown> = {
      last_published_by: authorUserId,
      updated_at: new Date().toISOString(),
    };

    if (updates.displayName) updateData.display_name = updates.displayName;
    if (updates.description) updateData.description = updates.description;
    if (updates.category !== undefined) updateData.category = updates.category;
    if (updates.tags) updateData.tags = updates.tags;
    if (updates.emoji !== undefined) updateData.emoji = updates.emoji;
    if (updates.version) updateData.current_version = updates.version;
    if (updates.content) updateData.content = updates.content;

    // Build merged manifest
    const existingManifest = existingSkill.manifest || {};
    const newManifest = updates.manifest
      ? { ...existingManifest, ...updates.manifest, version: updates.version }
      : { ...existingManifest, version: updates.version };
    updateData.manifest = newManifest;

    const { data, error } = await this.supabase
      .from('skills')
      .update(updateData)
      .eq('id', skillId)
      .select()
      .single();

    if (error) {
      logger.error('Failed to update skill:', error);
      throw error;
    }

    // Create version record in code (not relying on DB trigger for portability)
    const contentChanged = updates.content && updates.content !== existingSkill.content;
    const manifestChanged = JSON.stringify(newManifest) !== JSON.stringify(existingManifest);

    if (contentChanged || manifestChanged) {
      const { error: versionError } = await this.supabase.from('skill_versions').upsert(
        {
          skill_id: skillId,
          version: updates.version,
          manifest: newManifest,
          content: updates.content || existingSkill.content,
          changelog: updates.changelog || null,
          published_by: authorUserId,
          published_at: new Date().toISOString(),
        },
        { onConflict: 'skill_id,version' }
      );

      if (versionError) {
        // Log but don't fail - skill update succeeded
        logger.warn('Failed to create version record:', versionError);
      } else {
        logger.info(`Version ${updates.version} created for skill ${existingSkill.name}`);
      }
    }

    logger.info(
      `Skill updated: ${existingSkill.name} to version ${updates.version} by user ${authorUserId}`
    );
    return toCamelCase<DbSkillWithManagement>(data);
  }

  /**
   * Get skill by ID (internal, includes management fields)
   */
  async getSkillById(skillId: string): Promise<DbSkillWithManagement | null> {
    const { data, error } = await this.supabase
      .from('skills')
      .select('*')
      .eq('id', skillId)
      .single();

    if (error || !data) {
      return null;
    }

    return toCamelCase<DbSkillWithManagement>(data);
  }
}
