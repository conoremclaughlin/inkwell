import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { inferSkillTrust, skillProvenanceFiles, skillRoots } from './skill-metadata.js';

export interface DiscoveredSkill {
  name: string;
  path: string;
  source: string;
  trustLevel: 'trusted' | 'local' | 'untrusted';
  provenance?: SkillProvenance;
}

export interface SkillInstruction {
  name: string;
  path: string;
  source: string;
  trustLevel: 'trusted' | 'local' | 'untrusted';
  provenance?: SkillProvenance;
  content: string;
  /** Optional hash of the complete file, before prompt truncation, from an async host. */
  contentDigest?: string;
}

export interface SkillProvenance {
  registry?: string;
  installSource?: string;
  sourceUrl?: string;
  installedAt?: string;
  digest?: string;
  trusted?: boolean;
}

function loadProvenance(skillPath: string): SkillProvenance | undefined {
  for (const name of skillProvenanceFiles) {
    const filePath = join(skillPath, name);
    if (!existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as SkillProvenance;
      return parsed;
    } catch {
      // Ignore malformed metadata.
    }
  }
  return undefined;
}

function discoverFromDir(dir: string, source: string): DiscoveredSkill[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const skills: DiscoveredSkill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(dir, entry.name);
    const marker = join(skillPath, 'SKILL.md');
    if (existsSync(marker)) {
      const provenance = loadProvenance(skillPath);
      skills.push({
        name: entry.name,
        path: skillPath,
        source,
        provenance,
        trustLevel: inferSkillTrust(source, provenance),
      });
      continue;
    }

    // Also support nested ".system/<skill>/SKILL.md" style directories.
    const nested = join(skillPath, '.system');
    if (existsSync(nested) && statSync(nested).isDirectory()) {
      const nestedEntries = readdirSync(nested, { withFileTypes: true });
      for (const nestedEntry of nestedEntries) {
        if (!nestedEntry.isDirectory()) continue;
        const nestedPath = join(nested, nestedEntry.name);
        if (existsSync(join(nestedPath, 'SKILL.md'))) {
          const provenance = loadProvenance(nestedPath);
          skills.push({
            name: `${entry.name}/.system/${nestedEntry.name}`,
            path: nestedPath,
            source,
            provenance,
            trustLevel: inferSkillTrust(source, provenance),
          });
        }
      }
    }
  }

  return skills;
}

export function discoverSkills(cwd: string): DiscoveredSkill[] {
  const roots = skillRoots(cwd, homedir());

  const all = roots.flatMap((root) => discoverFromDir(root.dir, root.source));
  const dedupe = new Map<string, DiscoveredSkill>();
  for (const skill of all) {
    const key = `${skill.name}:${skill.path}`;
    dedupe.set(key, skill);
  }
  return Array.from(dedupe.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function loadSkillInstruction(skill: DiscoveredSkill, maxChars = 8000): SkillInstruction {
  const skillFile = join(skill.path, 'SKILL.md');
  let content = '';
  try {
    content = readFileSync(skillFile, 'utf-8');
  } catch {
    content = '';
  }
  if (content.length > maxChars) {
    content = `${content.slice(0, maxChars)}\n\n...[truncated]`;
  }
  return {
    name: skill.name,
    path: skill.path,
    source: skill.source,
    trustLevel: skill.trustLevel,
    provenance: skill.provenance,
    content,
  };
}
