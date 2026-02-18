import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverSkills, loadSkillInstruction } from './skills.js';

describe('discoverSkills', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('finds SKILL.md folders in repo-level codex skills', () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-skills-'));
    dirs.push(root);

    const skillDir = join(root, '.codex', 'skills', 'playwright');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# Playwright Skill\n');

    const found = discoverSkills(root);
    expect(found.some((skill) => skill.name === 'playwright')).toBe(true);
  });

  it('loads skill instructions with truncation guard', () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-skills-'));
    dirs.push(root);

    const skillDir = join(root, '.codex', 'skills', 'policy');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# Policy\n\n'.padEnd(200, 'x'));

    const [skill] = discoverSkills(root).filter((entry) => entry.name === 'policy');
    const loaded = loadSkillInstruction(skill, 40);
    expect(loaded.content.length).toBeGreaterThan(40);
    expect(loaded.content).toContain('...[truncated]');
  });
});
