/**
 * Skill Source Providers
 *
 * Phase 1 provider abstraction for loading user skills from deterministic sources.
 * Current providers:
 * - cloud: PCP skills registry installations
 * - local: ~/.pcp/skills filesystem directory
 */

import { SkillsRepository } from './repository';
import { loadAllSkills as loadLocalSkills } from './loader';
import { checkEligibility } from './eligibility';
import type { LoadedSkill, SkillManifest, SkillType, UserInstalledSkill } from './types';

export type SkillSourceId = 'cloud' | 'local';

export const DEFAULT_SKILL_SOURCE_PRIORITY: SkillSourceId[] = ['cloud', 'local'];

export interface SkillSourceProvider {
  id: SkillSourceId;
  loadUserSkills(userId: string): Promise<LoadedSkill[]>;
}

export interface SkillSourceLoadResult {
  source: SkillSourceId;
  skills: LoadedSkill[];
}

/**
 * cloud:// installed skill -> runtime LoadedSkill
 */
export function cloudInstalledSkillToLoaded(cloud: UserInstalledSkill): LoadedSkill {
  const manifest: SkillManifest = {
    ...cloud.resolvedManifest,
    name: cloud.name,
    version: cloud.resolvedVersion,
    displayName: cloud.displayName,
    description: cloud.description,
    type: cloud.type as SkillType,
    category: cloud.category || undefined,
    tags: cloud.tags,
    emoji: cloud.emoji || undefined,
  };

  return {
    manifest,
    skillContent: cloud.resolvedContent,
    sourcePath: `cloud://${cloud.skillId}`,
    eligibility: checkEligibility(manifest.requirements),
  };
}

/**
 * Local filesystem provider (~/.pcp/skills + builtin)
 */
export class LocalSkillSourceProvider implements SkillSourceProvider {
  readonly id: SkillSourceId = 'local';

  constructor(private readonly userSkillsPath?: string) {}

  async loadUserSkills(_userId: string): Promise<LoadedSkill[]> {
    return loadLocalSkills(this.userSkillsPath);
  }
}

/**
 * Cloud installations provider (Supabase-backed)
 */
export class CloudSkillSourceProvider implements SkillSourceProvider {
  readonly id: SkillSourceId = 'cloud';

  constructor(private readonly repository: SkillsRepository) {}

  async loadUserSkills(userId: string): Promise<LoadedSkill[]> {
    const cloudSkills = await this.repository.getUserInstalledSkills(userId);
    return cloudSkills.map(cloudInstalledSkillToLoaded);
  }
}

/**
 * Deterministic skill merge by source priority.
 *
 * Rules:
 * - sources are applied in listed priority order
 * - later sources override earlier sources on name collision
 * - output sorted by skill name for deterministic ordering
 */
export function mergeSkillsByPriority(
  results: SkillSourceLoadResult[],
  priority: SkillSourceId[]
): LoadedSkill[] {
  const resultBySource = new Map(results.map((result) => [result.source, result.skills]));
  const orderedPriority: SkillSourceId[] = [];
  const seen = new Set<SkillSourceId>();

  // Apply explicit priority first
  for (const source of priority) {
    if (!seen.has(source)) {
      seen.add(source);
      orderedPriority.push(source);
    }
  }

  // Apply any missing sources in deterministic source-id order
  const missingSources = Array.from(resultBySource.keys())
    .filter((source) => !seen.has(source))
    .sort();
  for (const source of missingSources) {
    orderedPriority.push(source);
  }

  const merged = new Map<string, LoadedSkill>();

  for (const source of orderedPriority) {
    const skills = resultBySource.get(source) ?? [];
    const sortedSkills = [...skills].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
    for (const skill of sortedSkills) {
      merged.set(skill.manifest.name, skill);
    }
  }

  return Array.from(merged.values()).sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}
