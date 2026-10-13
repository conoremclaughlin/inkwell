/** The CLI skill-server discovery order, using async IO and an explicit home. */
import { readFile, readdir, stat } from 'fs/promises';
import { join, isAbsolute } from 'path';
import { parseSkillMcpContent } from '../providers/skill-mcp-parser.js';
import type { SkillMcpServer } from '../providers/skill-mcp.js';

async function directories(path: string) {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((x) => x.isDirectory());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
async function marker(path: string) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
export async function discoverHostedSkillMcpServers(
  cwd: string,
  home: string
): Promise<SkillMcpServer[]> {
  if (!isAbsolute(cwd) || !isAbsolute(home))
    throw new Error('Skill discovery needs absolute host roots');
  const skills: Array<{ name: string; path: string }> = [];
  for (const dot of ['.codex', '.ink', '.claude', '.gemini']) {
    for (const root of [cwd, home]) {
      const dir = join(root, dot, 'skills');
      for (const entry of await directories(dir)) {
        const skillPath = join(dir, entry.name);
        if (await marker(join(skillPath, 'SKILL.md'))) {
          skills.push({ name: entry.name, path: skillPath });
          continue;
        }
        for (const nested of await directories(join(skillPath, '.system'))) {
          const path = join(skillPath, '.system', nested.name);
          if (await marker(join(path, 'SKILL.md')))
            skills.push({ name: `${entry.name}/.system/${nested.name}`, path });
        }
      }
    }
  }
  const deduped = [...new Map(skills.map((s) => [`${s.name}:${s.path}`, s])).values()].sort(
    (a, b) => a.name.localeCompare(b.name)
  );
  const servers: SkillMcpServer[] = [];
  for (const skill of deduped) {
    const parsed = parseSkillMcpContent(await readFile(join(skill.path, 'SKILL.md'), 'utf8'));
    if (parsed) servers.push(parsed);
  }
  return servers;
}
