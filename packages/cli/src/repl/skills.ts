import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface DiscoveredSkill {
  name: string;
  path: string;
  source: string;
}

export interface SkillInstruction {
  name: string;
  path: string;
  source: string;
  content: string;
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
      skills.push({ name: entry.name, path: skillPath, source });
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
          skills.push({ name: `${entry.name}/.system/${nestedEntry.name}`, path: nestedPath, source });
        }
      }
    }
  }

  return skills;
}

export function discoverSkills(cwd: string): DiscoveredSkill[] {
  const roots: Array<{ dir: string; source: string }> = [
    { dir: join(cwd, '.codex', 'skills'), source: 'repo:.codex/skills' },
    { dir: join(homedir(), '.codex', 'skills'), source: 'home:~/.codex/skills' },
    { dir: join(cwd, '.pcp', 'skills'), source: 'repo:.pcp/skills' },
    { dir: join(homedir(), '.pcp', 'skills'), source: 'home:~/.pcp/skills' },
    { dir: join(cwd, '.claude', 'skills'), source: 'repo:.claude/skills' },
    { dir: join(homedir(), '.claude', 'skills'), source: 'home:~/.claude/skills' },
    { dir: join(cwd, '.gemini', 'skills'), source: 'repo:.gemini/skills' },
    { dir: join(homedir(), '.gemini', 'skills'), source: 'home:~/.gemini/skills' },
  ];

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
    content,
  };
}
