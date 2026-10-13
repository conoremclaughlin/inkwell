/** Pure catalog conventions shared by synchronous CLI and asynchronous host I/O. */
import { join } from 'path';
import type { DiscoveredSkill, SkillProvenance } from './skill-discovery.js';

export const skillProvenanceFiles = ['skill-provenance.json', 'provenance.json', '.ink-skill.json'];

export function skillRoots(cwd: string, home: string) {
  return ['.codex', '.ink', '.claude', '.gemini'].flatMap((dot) => [
    { dir: join(cwd, dot, 'skills'), source: `repo:${dot}/skills` },
    { dir: join(home, dot, 'skills'), source: `home:~/${dot}/skills` },
  ]);
}

export function inferSkillTrust(
  source: string,
  provenance?: SkillProvenance
): DiscoveredSkill['trustLevel'] {
  if (provenance?.trusted) return 'trusted';
  if (source.startsWith('repo:')) return 'trusted';
  if (source.startsWith('home:')) return 'local';
  return 'untrusted';
}
