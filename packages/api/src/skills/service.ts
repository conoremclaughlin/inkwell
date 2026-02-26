/**
 * Skills Service
 *
 * High-level service for managing skills. Provides caching,
 * user settings integration, and status tracking.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadAllSkills, loadSkillByName, getSkillPaths, type SkillLoadOptions } from './loader';
import type {
  LoadedSkill,
  SkillSummary,
  SkillDetail,
  SkillStatus,
  SkillsListResponse,
  UserSkillSettings,
} from './types';

// In-memory cache
let skillsCache: LoadedSkill[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60000; // 1 minute

/**
 * Determine skill status based on eligibility and user settings
 */
function determineStatus(skill: LoadedSkill, userSettings?: UserSkillSettings): SkillStatus {
  if (userSettings?.enabled === false) {
    return 'disabled';
  }

  if (!skill.eligibility.eligible) {
    return 'needs-setup';
  }

  // For mini-apps, check if installed/configured
  if (skill.manifest.type === 'mini-app') {
    return 'installed';
  }

  // For CLI skills, check if binary exists
  if (skill.manifest.type === 'cli') {
    return skill.eligibility.eligible ? 'installed' : 'needs-setup';
  }

  return 'available';
}

/**
 * Convert LoadedSkill to SkillSummary
 */
function toSummary(skill: LoadedSkill, userSettings?: UserSkillSettings): SkillSummary {
  return {
    name: skill.manifest.name,
    displayName: skill.manifest.displayName || skill.manifest.name,
    description: skill.manifest.description,
    type: skill.manifest.type,
    emoji: skill.manifest.emoji,
    category: skill.manifest.category,
    tags: skill.manifest.tags,
    version: skill.manifest.version,
    status: determineStatus(skill, userSettings),
    triggers: skill.manifest.triggers?.keywords,
    functionCount: skill.manifest.functions?.length,
    capabilities: skill.manifest.capabilities,
    eligibility: skill.eligibility,
  };
}

/**
 * Convert LoadedSkill to SkillDetail
 */
function toDetail(skill: LoadedSkill, userSettings?: UserSkillSettings): SkillDetail {
  return {
    ...toSummary(skill, userSettings),
    skillContent: skill.skillContent,
    manifest: skill.manifest,
    userSettings,
  };
}

/**
 * Skills Service
 */
export class SkillsService {
  private loadOptions: SkillLoadOptions;

  constructor(options?: SkillLoadOptions) {
    this.loadOptions = options || {};
  }

  /**
   * Get all loaded skills (with caching)
   */
  private getSkills(forceRefresh = false): LoadedSkill[] {
    const now = Date.now();
    if (!forceRefresh && skillsCache && now - cacheTimestamp < CACHE_TTL_MS) {
      return skillsCache;
    }

    skillsCache = loadAllSkills(this.loadOptions);
    cacheTimestamp = now;
    return skillsCache;
  }

  /**
   * List all skills with summaries
   */
  listSkills(options?: {
    type?: string;
    category?: string;
    status?: SkillStatus;
    search?: string;
  }): SkillsListResponse {
    let skills = this.getSkills();

    // Filter by type
    if (options?.type) {
      skills = skills.filter((s) => s.manifest.type === options.type);
    }

    // Filter by category
    if (options?.category) {
      skills = skills.filter((s) => s.manifest.category === options.category);
    }

    // Filter by status
    if (options?.status) {
      skills = skills.filter((s) => determineStatus(s) === options.status);
    }

    // Search by name, description, or tags
    if (options?.search) {
      const searchLower = options.search.toLowerCase();
      skills = skills.filter(
        (s) =>
          s.manifest.name.toLowerCase().includes(searchLower) ||
          s.manifest.description.toLowerCase().includes(searchLower) ||
          s.manifest.displayName?.toLowerCase().includes(searchLower) ||
          s.manifest.tags?.some((t) => t.toLowerCase().includes(searchLower))
      );
    }

    // Get unique categories
    const categories = [
      ...new Set(skills.map((s) => s.manifest.category).filter(Boolean)),
    ] as string[];

    return {
      skills: skills.map((s) => toSummary(s)),
      categories,
      totalCount: skills.length,
    };
  }

  /**
   * Get skill details by name
   */
  getSkill(name: string): SkillDetail | null {
    const skill = loadSkillByName(name, this.loadOptions);
    if (!skill) return null;
    return toDetail(skill);
  }

  /**
   * Refresh eligibility for all skills
   */
  refreshEligibility(): SkillsListResponse {
    // Force refresh the cache
    skillsCache = null;
    return this.listSkills();
  }

  /**
   * Get skill paths being scanned
   */
  getSkillPaths(): string[] {
    return getSkillPaths(this.loadOptions);
  }

  /**
   * Check if a specific skill is eligible
   */
  checkSkillEligibility(name: string): { eligible: boolean; message?: string } {
    const skill = loadSkillByName(name, this.loadOptions);
    if (!skill) {
      return { eligible: false, message: `Skill "${name}" not found` };
    }
    return {
      eligible: skill.eligibility.eligible,
      message: skill.eligibility.message,
    };
  }
}

// Singleton instance
let serviceInstance: SkillsService | null = null;

/**
 * Read skills config from ~/.pcp/config.json.
 * Returns extraDirs if configured under `skills.extraDirs`.
 */
function readSkillsConfig(): SkillLoadOptions {
  const configPath = join(homedir(), '.pcp', 'config.json');
  if (!existsSync(configPath)) return {};

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const extraDirs = config?.skills?.extraDirs as string[] | undefined;
    return extraDirs?.length ? { extraDirs } : {};
  } catch {
    return {};
  }
}

/**
 * Get the skills service singleton.
 * When no options are provided, reads ~/.pcp/config.json for extraDirs.
 */
export function getSkillsService(options?: SkillLoadOptions): SkillsService {
  if (!serviceInstance) {
    // Merge caller options with config-file options (caller wins)
    const configOptions = readSkillsConfig();
    const merged: SkillLoadOptions = { ...configOptions, ...options };
    serviceInstance = new SkillsService(merged);
  }
  return serviceInstance;
}
