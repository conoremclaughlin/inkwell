/**
 * Skill Loader
 *
 * Loads skills from the filesystem. Skills can be:
 * - SKILL.md files with YAML frontmatter (like clawdbot)
 * - Directories with manifest.yaml + SKILL.md
 *
 * Default skill locations:
 * 1. Built-in: packages/api/src/skills/builtin/
 * 2. User skills: ~/.pcp/skills/
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import * as yaml from 'yaml';
import type { SkillManifest, LoadedSkill, SkillType } from './types';
import { checkEligibility } from './eligibility';

const BUILTIN_SKILLS_PATH = join(__dirname, 'builtin');

/**
 * Parse YAML frontmatter from markdown content
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  try {
    const frontmatter = yaml.parse(match[1]) || {};
    return { frontmatter, body: match[2].trim() };
  } catch {
    return { frontmatter: {}, body: content };
  }
}

/**
 * Convert frontmatter to SkillManifest
 */
function frontmatterToManifest(
  frontmatter: Record<string, unknown>,
  fileName: string
): SkillManifest {
  const name = (frontmatter.name as string) || basename(fileName, '.md').toLowerCase();

  return {
    name,
    version: (frontmatter.version as string) || '1.0.0',
    displayName:
      (frontmatter.displayName as string) || (frontmatter.display_name as string) || name,
    description: (frontmatter.description as string) || '',
    type: (frontmatter.type as SkillType) || 'guide',
    emoji: frontmatter.emoji as string,
    category: frontmatter.category as string,
    tags: frontmatter.tags as string[],
    author: frontmatter.author as string,
    homepage: frontmatter.homepage as string,
    repository: frontmatter.repository as string,

    triggers: frontmatter.triggers as SkillManifest['triggers'],
    capabilities: frontmatter.capabilities as SkillManifest['capabilities'],
    requirements: frontmatter.requirements as SkillManifest['requirements'],
    install: frontmatter.install as SkillManifest['install'],

    functions: frontmatter.functions as SkillManifest['functions'],
    cli: frontmatter.cli as SkillManifest['cli'],
    guide: frontmatter.guide as SkillManifest['guide'],

    entry: frontmatter.entry as string,
  };
}

/**
 * Load a single skill from a SKILL.md file
 */
function loadSkillFromFile(filePath: string): LoadedSkill | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);

    const manifest = frontmatterToManifest(frontmatter, basename(filePath));
    const eligibility = checkEligibility(manifest.requirements);

    return {
      manifest,
      skillContent: body,
      sourcePath: filePath,
      eligibility,
    };
  } catch (error) {
    console.error(`Failed to load skill from ${filePath}:`, error);
    return null;
  }
}

/**
 * Load a skill from a directory (with manifest.yaml)
 */
function loadSkillFromDirectory(dirPath: string): LoadedSkill | null {
  const manifestPath = join(dirPath, 'manifest.yaml');
  const skillMdPath = join(dirPath, 'SKILL.md');

  // Try manifest.yaml first
  if (existsSync(manifestPath)) {
    try {
      const manifestContent = readFileSync(manifestPath, 'utf-8');
      const manifest = yaml.parse(manifestContent) as SkillManifest;

      // Load SKILL.md if it exists
      let skillContent = '';
      if (existsSync(skillMdPath)) {
        const mdContent = readFileSync(skillMdPath, 'utf-8');
        const { body } = parseFrontmatter(mdContent);
        skillContent = body;
      }

      const eligibility = checkEligibility(manifest.requirements);

      return {
        manifest,
        skillContent,
        sourcePath: dirPath,
        eligibility,
      };
    } catch (error) {
      console.error(`Failed to load skill from ${manifestPath}:`, error);
      return null;
    }
  }

  // Fallback to SKILL.md
  if (existsSync(skillMdPath)) {
    return loadSkillFromFile(skillMdPath);
  }

  return null;
}

/**
 * Scan a directory for skills
 */
function scanDirectory(dirPath: string): LoadedSkill[] {
  if (!existsSync(dirPath)) {
    return [];
  }

  const skills: LoadedSkill[] = [];
  const entries = readdirSync(dirPath);

  for (const entry of entries) {
    const fullPath = join(dirPath, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      // Directory-based skill
      const skill = loadSkillFromDirectory(fullPath);
      if (skill) {
        skills.push(skill);
      }
    } else if (entry.endsWith('.md') && entry !== 'README.md') {
      // Single-file skill
      const skill = loadSkillFromFile(fullPath);
      if (skill) {
        skills.push(skill);
      }
    }
  }

  return skills;
}

/**
 * Load all skills from default locations
 */
export function loadAllSkills(userSkillsPath?: string): LoadedSkill[] {
  const skills: LoadedSkill[] = [];

  // Load built-in skills
  skills.push(...scanDirectory(BUILTIN_SKILLS_PATH));

  // Load user skills
  const userPath = userSkillsPath || join(process.env.HOME || '', '.pcp', 'skills');
  skills.push(...scanDirectory(userPath));

  return skills;
}

/**
 * Load a specific skill by name
 */
export function loadSkillByName(name: string, userSkillsPath?: string): LoadedSkill | null {
  const allSkills = loadAllSkills(userSkillsPath);
  return allSkills.find((s) => s.manifest.name === name) || null;
}

/**
 * Get skill paths being scanned
 */
export function getSkillPaths(userSkillsPath?: string): string[] {
  const userPath = userSkillsPath || join(process.env.HOME || '', '.pcp', 'skills');
  return [BUILTIN_SKILLS_PATH, userPath];
}
