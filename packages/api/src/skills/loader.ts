/**
 * Skill Loader
 *
 * Loads skills from the filesystem using a 4-tier precedence cascade
 * (inspired by the AgentSkills format: https://docs.openclaw.ai/tools/skills).
 *
 * Skills can be:
 * - SKILL.md files with YAML frontmatter
 * - Directories with manifest.yaml + SKILL.md
 *
 * Loading order (lowest → highest precedence, later overrides by name):
 * 1. Built-in:  packages/api/src/skills/builtin/   (shipped with PCP)
 * 2. Extra dirs: configurable paths                 (ClawHub interop, etc.)
 * 3. Managed:   ~/.ink/skills/                      (user-installed, all SBs)
 * 4. Workspace:  <cwd>/.ink/skills/                 (per-worktree, per-SB)
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename, dirname } from 'path';
import * as yaml from 'yaml';
import type { SkillManifest, LoadedSkill, SkillType } from './types';
import { checkEligibility } from './eligibility';

const BUILTIN_SKILLS_PATH = join(__dirname, 'builtin');
const HOME = process.env.HOME || '';

/**
 * Options for skill loading.
 */
export interface SkillLoadOptions {
  /** Override the default ~/.ink/skills/ managed path */
  userSkillsPath?: string;
  /** Working directory for workspace-level skills (<cwd>/.ink/skills/) */
  workspacePath?: string;
  /** Additional skill directories (e.g., ["~/.openclaw/skills"]) */
  extraDirs?: string[];
}

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
 * Extract OpenClaw-format metadata from the `metadata.openclaw` frontmatter field.
 * Maps their nested format to our flat SkillManifest fields.
 *
 * OpenClaw nests emoji, os, requires, and install under `metadata.openclaw`:
 *   metadata: { openclaw: { emoji, os, requires: { bins }, install: [...] } }
 */
function extractOpenClawMetadata(frontmatter: Record<string, unknown>): Partial<SkillManifest> {
  const metadata = frontmatter.metadata as Record<string, unknown> | undefined;
  if (!metadata) return {};

  // metadata can be a string (JSON) or object
  let oc: Record<string, unknown> | undefined;
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata);
      oc = parsed?.openclaw as Record<string, unknown>;
    } catch {
      return {};
    }
  } else {
    oc = metadata.openclaw as Record<string, unknown> | undefined;
  }

  if (!oc) return {};

  const result: Partial<SkillManifest> = {};

  if (oc.emoji) result.emoji = oc.emoji as string;

  // Map requires + os → requirements
  const requires = oc.requires as Record<string, unknown> | undefined;
  const osArr = oc.os as string[] | undefined;
  if (requires || osArr) {
    const reqs: SkillManifest['requirements'] = {};
    if (requires?.bins) reqs.bins = requires.bins as string[];
    if (requires?.env) reqs.env = requires.env as string[];
    if (requires?.config) reqs.config = requires.config as string[];
    if (osArr) {
      // Map OpenClaw OS names → our names
      reqs.os = osArr.map((o) => {
        if (o === 'darwin') return 'macos';
        if (o === 'win32') return 'windows';
        return o;
      }) as Array<'macos' | 'linux' | 'windows'>;
    }
    result.requirements = reqs;
  }

  // Map install specs
  const installArr = oc.install as Array<Record<string, unknown>> | undefined;
  if (installArr?.length) {
    result.install = installArr.map((spec) => ({
      kind: (spec.kind as string) || 'manual',
      package: spec.package as string | undefined,
      bins: spec.bins as string[] | undefined,
      url: spec.url as string | undefined,
      instructions: (spec.label as string) || (spec.instructions as string) || undefined,
    })) as SkillManifest['install'];
  }

  return result;
}

/**
 * Convert frontmatter to SkillManifest.
 * Supports both PCP's flat format and OpenClaw's nested `metadata.openclaw` format.
 */
function frontmatterToManifest(
  frontmatter: Record<string, unknown>,
  fileName: string
): SkillManifest {
  const name = (frontmatter.name as string) || basename(fileName, '.md').toLowerCase();

  // Extract OpenClaw nested metadata as fallback values
  const oc = extractOpenClawMetadata(frontmatter);

  return {
    name,
    version: (frontmatter.version as string) || '1.0.0',
    displayName:
      (frontmatter.displayName as string) || (frontmatter.display_name as string) || name,
    description: (frontmatter.description as string) || '',
    type: (frontmatter.type as SkillType) || 'guide',
    emoji: (frontmatter.emoji as string) || oc.emoji,
    category: frontmatter.category as string,
    tags: frontmatter.tags as string[],
    author: frontmatter.author as string,
    homepage: frontmatter.homepage as string,
    repository: frontmatter.repository as string,

    triggers: frontmatter.triggers as SkillManifest['triggers'],
    capabilities: frontmatter.capabilities as SkillManifest['capabilities'],
    requirements: (frontmatter.requirements as SkillManifest['requirements']) || oc.requirements,
    install: (frontmatter.install as SkillManifest['install']) || oc.install,

    functions: frontmatter.functions as SkillManifest['functions'],
    cli: frontmatter.cli as SkillManifest['cli'],
    guide: frontmatter.guide as SkillManifest['guide'],

    entry: frontmatter.entry as string,

    mcp: frontmatter.mcp as SkillManifest['mcp'],
  };
}

/**
 * Replace {baseDir} placeholder with the skill's source directory path.
 * This lets SKILL.md reference bundled scripts relative to its own directory.
 */
function resolveBaseDir(content: string, sourcePath: string): string {
  return content.replace(/\{baseDir\}/g, sourcePath);
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
    const skillContent = resolveBaseDir(body, dirname(filePath));

    return {
      manifest,
      skillContent,
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

      skillContent = resolveBaseDir(skillContent, dirPath);
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
 * Expand ~ to $HOME in a path
 */
function expandHome(p: string): string {
  return p.replace(/^~/, HOME);
}

/**
 * Load all skills using the 4-tier precedence cascade.
 *
 * Accepts either the legacy single-string `userSkillsPath` parameter
 * or the full `SkillLoadOptions` object.
 */
export function loadAllSkills(options?: string | SkillLoadOptions): LoadedSkill[] {
  // Backwards compat: accept bare string as userSkillsPath
  const opts: SkillLoadOptions =
    typeof options === 'string' ? { userSkillsPath: options } : options || {};

  // Map keyed by skill name — last write wins (higher precedence overrides)
  const skills = new Map<string, LoadedSkill>();

  // Tier 1: Built-in (lowest precedence)
  for (const s of scanDirectory(BUILTIN_SKILLS_PATH)) {
    skills.set(s.manifest.name, s);
  }

  // Tier 2: Extra dirs (ClawHub, etc.)
  if (opts.extraDirs) {
    for (const dir of opts.extraDirs) {
      for (const s of scanDirectory(expandHome(dir))) {
        skills.set(s.manifest.name, s);
      }
    }
  }

  // Tier 3: Managed (~/.ink/skills/)
  const userPath = opts.userSkillsPath || join(HOME, '.ink', 'skills');
  for (const s of scanDirectory(userPath)) {
    skills.set(s.manifest.name, s);
  }

  // Tier 4: Workspace (<cwd>/.ink/skills/) — highest precedence
  if (opts.workspacePath) {
    const wsSkillsPath = join(opts.workspacePath, '.ink', 'skills');
    for (const s of scanDirectory(wsSkillsPath)) {
      skills.set(s.manifest.name, s);
    }
  }

  return Array.from(skills.values());
}

/**
 * Load a specific skill by name
 */
export function loadSkillByName(
  name: string,
  options?: string | SkillLoadOptions
): LoadedSkill | null {
  const allSkills = loadAllSkills(options);
  return allSkills.find((s) => s.manifest.name === name) || null;
}

/**
 * Get all skill paths being scanned
 */
export function getSkillPaths(options?: string | SkillLoadOptions): string[] {
  const opts: SkillLoadOptions =
    typeof options === 'string' ? { userSkillsPath: options } : options || {};

  const paths = [BUILTIN_SKILLS_PATH];

  if (opts.extraDirs) {
    for (const dir of opts.extraDirs) {
      paths.push(expandHome(dir));
    }
  }

  paths.push(opts.userSkillsPath || join(HOME, '.ink', 'skills'));

  if (opts.workspacePath) {
    paths.push(join(opts.workspacePath, '.ink', 'skills'));
  }

  return paths;
}
