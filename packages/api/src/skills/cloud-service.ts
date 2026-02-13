/**
 * Cloud Skills Service
 *
 * Integrates cloud-based skills from the registry with local skills.
 * Provides a unified interface for:
 * - Browsing the skills registry
 * - Installing/uninstalling skills
 * - Loading user's installed skills on bootstrap
 * - Merging local and cloud skills
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { SkillsRepository } from './repository';
import { loadAllSkills as loadLocalSkills } from './loader';
import { checkEligibility } from './eligibility';
import { logger } from '../utils/logger';
import {
  CloudSkillSourceProvider,
  DEFAULT_SKILL_SOURCE_PRIORITY,
  LocalSkillSourceProvider,
  mergeSkillsByPriority,
  type SkillSourceId,
  type SkillSourceProvider,
} from './providers';
import type {
  LoadedSkill,
  SkillSummary,
  SkillsListResponse,
  UserInstalledSkill,
  RegistrySkillSummary,
  RegistrySkillDetail,
  ListRegistrySkillsOptions,
  InstallSkillOptions,
  PublishSkillOptions,
} from './types';

interface CloudSkillsServiceOptions {
  userSkillsPath?: string;
  sourcePriority?: SkillSourceId[];
  providers?: SkillSourceProvider[];
}

export class CloudSkillsService {
  private repository: SkillsRepository;
  private providers: SkillSourceProvider[];
  private sourcePriority: SkillSourceId[];

  constructor(supabase: SupabaseClient, options: CloudSkillsServiceOptions = {}) {
    this.repository = new SkillsRepository(supabase);
    this.sourcePriority = options.sourcePriority || DEFAULT_SKILL_SOURCE_PRIORITY;
    this.providers = options.providers || [
      new CloudSkillSourceProvider(this.repository),
      new LocalSkillSourceProvider(options.userSkillsPath),
    ];
  }

  // ===========================================================================
  // Registry Browsing
  // ===========================================================================

  /**
   * Browse the skills registry
   */
  async browseRegistry(
    options: ListRegistrySkillsOptions = {},
    currentUserId?: string
  ): Promise<{ skills: RegistrySkillSummary[]; total: number; categories: string[] }> {
    const [{ skills, total }, categories] = await Promise.all([
      this.repository.listRegistrySkills(options, currentUserId),
      this.repository.getCategories(),
    ]);

    return { skills, total, categories };
  }

  /**
   * Get detailed information about a skill in the registry
   */
  async getRegistrySkill(
    idOrName: string,
    currentUserId?: string
  ): Promise<RegistrySkillDetail | null> {
    return this.repository.getRegistrySkill(idOrName, currentUserId);
  }

  // ===========================================================================
  // Installation Management
  // ===========================================================================

  /**
   * Install a skill from the registry
   */
  async installSkill(options: InstallSkillOptions): Promise<{ success: boolean; message: string }> {
    try {
      await this.repository.installSkill(options);
      return { success: true, message: 'Skill installed successfully' };
    } catch (error) {
      logger.error('Failed to install skill:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to install skill',
      };
    }
  }

  /**
   * Uninstall a skill
   */
  async uninstallSkill(
    skillId: string,
    userId: string
  ): Promise<{ success: boolean; message: string }> {
    try {
      await this.repository.uninstallSkill(skillId, userId);
      return { success: true, message: 'Skill uninstalled successfully' };
    } catch (error) {
      logger.error('Failed to uninstall skill:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to uninstall skill',
      };
    }
  }

  /**
   * Toggle skill enabled/disabled
   */
  async toggleSkill(
    installationId: string,
    userId: string,
    enabled: boolean
  ): Promise<{ success: boolean }> {
    try {
      await this.repository.updateInstallation(installationId, userId, { enabled });
      return { success: true };
    } catch (error) {
      logger.error('Failed to toggle skill:', error);
      return { success: false };
    }
  }

  /**
   * Pin a skill to a specific version
   */
  async pinSkillVersion(
    installationId: string,
    userId: string,
    version: string | null
  ): Promise<{ success: boolean }> {
    try {
      await this.repository.updateInstallation(installationId, userId, { versionPinned: version });
      return { success: true };
    } catch (error) {
      logger.error('Failed to pin skill version:', error);
      return { success: false };
    }
  }

  // ===========================================================================
  // Loading Skills (Bootstrap)
  // ===========================================================================

  /**
   * Load all skills for a user (combines local + cloud installed)
   * Used during bootstrap to get the user's complete skill set.
   */
  async loadUserSkills(userId: string): Promise<LoadedSkill[]> {
    const loadResults = await Promise.all(
      this.providers.map(async (provider) => {
        try {
          const skills = await provider.loadUserSkills(userId);
          return { source: provider.id, skills };
        } catch (error) {
          logger.error(
            `Failed to load ${provider.id} skills; continuing with other sources`,
            error
          );
          return { source: provider.id, skills: [] };
        }
      })
    );

    return mergeSkillsByPriority(loadResults, this.sourcePriority);
  }

  /**
   * Get a unified list of skills (for admin dashboard)
   * Shows both local and cloud skills with installation status.
   */
  async listAllSkills(
    userId: string,
    options?: { type?: string; category?: string; search?: string }
  ): Promise<SkillsListResponse> {
    // Load local skills
    const localSkills = loadLocalSkills();

    // Load user's cloud installations
    let cloudInstallations: UserInstalledSkill[] = [];
    try {
      cloudInstallations = await this.repository.getUserInstalledSkills(userId);
    } catch (error) {
      logger.warn('Failed to load cloud installations:', error);
    }

    // Merge: local skills + cloud-only installations
    const skillMap = new Map<string, SkillSummary>();

    // Add local skills
    for (const skill of localSkills) {
      const summary = this.loadedToSummary(skill, 'local');
      skillMap.set(skill.manifest.name, summary);
    }

    // Add cloud installations (if not already local)
    for (const cloud of cloudInstallations) {
      if (!skillMap.has(cloud.name)) {
        const summary = this.cloudToSummary(cloud);
        skillMap.set(cloud.name, summary);
      } else {
        // Mark local skill as also cloud-installed
        const existing = skillMap.get(cloud.name)!;
        existing.status = 'installed';
      }
    }

    let skills = Array.from(skillMap.values());

    // Apply filters
    if (options?.type) {
      skills = skills.filter((s) => s.type === options.type);
    }
    if (options?.category) {
      skills = skills.filter((s) => s.category === options.category);
    }
    if (options?.search) {
      const searchLower = options.search.toLowerCase();
      skills = skills.filter(
        (s) =>
          s.name.toLowerCase().includes(searchLower) ||
          s.displayName.toLowerCase().includes(searchLower) ||
          s.description.toLowerCase().includes(searchLower)
      );
    }

    // Get categories
    const categories = [...new Set(skills.map((s) => s.category).filter(Boolean))] as string[];

    return {
      skills,
      categories,
      totalCount: skills.length,
    };
  }

  // ===========================================================================
  // Publishing
  // ===========================================================================

  /**
   * Publish a new skill to the registry
   */
  async publishSkill(
    options: PublishSkillOptions
  ): Promise<{ success: boolean; skillId?: string; message: string }> {
    try {
      const skill = await this.repository.publishSkill(options);
      return {
        success: true,
        skillId: skill.id,
        message: `Skill "${options.name}" published successfully`,
      };
    } catch (error) {
      logger.error('Failed to publish skill:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to publish skill',
      };
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Convert LoadedSkill to SkillSummary
   */
  private loadedToSummary(skill: LoadedSkill, _source: 'local' | 'cloud'): SkillSummary {
    return {
      name: skill.manifest.name,
      displayName: skill.manifest.displayName || skill.manifest.name,
      description: skill.manifest.description,
      type: skill.manifest.type,
      emoji: skill.manifest.emoji,
      category: skill.manifest.category,
      tags: skill.manifest.tags,
      version: skill.manifest.version,
      status: skill.eligibility.eligible ? 'available' : 'needs-setup',
      triggers: skill.manifest.triggers?.keywords,
      functionCount: skill.manifest.functions?.length,
      capabilities: skill.manifest.capabilities,
      eligibility: skill.eligibility,
    };
  }

  /**
   * Convert UserInstalledSkill to SkillSummary
   */
  private cloudToSummary(cloud: UserInstalledSkill): SkillSummary {
    const eligibility = checkEligibility(cloud.manifest.requirements);

    return {
      name: cloud.name,
      displayName: cloud.displayName,
      description: cloud.description,
      type: cloud.type,
      emoji: cloud.emoji || undefined,
      category: cloud.category || undefined,
      tags: cloud.tags,
      version: cloud.resolvedVersion,
      status: cloud.enabled ? (eligibility.eligible ? 'installed' : 'needs-setup') : 'disabled',
      triggers: cloud.manifest.triggers?.keywords,
      functionCount: cloud.manifest.functions?.length,
      capabilities: cloud.manifest.capabilities,
      eligibility,
    };
  }
}

// Singleton
let cloudServiceInstance: CloudSkillsService | null = null;

export function getCloudSkillsService(supabase: SupabaseClient): CloudSkillsService {
  if (!cloudServiceInstance) {
    cloudServiceInstance = new CloudSkillsService(supabase);
  }
  return cloudServiceInstance;
}
