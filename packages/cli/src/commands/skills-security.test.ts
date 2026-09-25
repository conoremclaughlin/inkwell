import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync, execFileSync } from 'child_process';

const state = vi.hoisted(() => ({ home: '' }));
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  homedir: () => state.home,
}));
vi.mock('../lib/ink-mcp.js', () => ({ callInkTool: vi.fn() }));
vi.mock('./mcp.js', () => ({ syncMcpConfig: vi.fn() }));
vi.mock('child_process', () => ({
  execSync: vi.fn(() => {
    throw new Error('Unexpected shell execution');
  }),
  execFileSync: vi.fn(() => {
    throw new Error('Unexpected process execution');
  }),
}));

let skills: typeof import('./skills.js');
beforeEach(async () => {
  vi.clearAllMocks();
  state.home = mkdtempSync(join(tmpdir(), 'ink-skills-security-'));
  vi.resetModules();
  skills = await import('./skills.js');
});
afterEach(() => rmSync(state.home, { recursive: true, force: true }));

describe('skill paths and replacement', () => {
  // Dangerous names are tested on the pure validator, never a real executor
  // or filesystem sink. All replacement fixtures below stay in one temp tree.
  it.each([
    '',
    '.',
    '..',
    '../outside',
    '/outside',
    'nested/skill',
    'nested\\skill',
    '$(echo marker)',
    'skill;echo',
    '--flag',
    'demo\n',
    'demo\r',
  ])('rejects names that are not a single safe component: %s', (name) =>
    expect(() => skills.assertSkillName(name)).toThrow('Skill name')
  );

  it('rejects non-string runtime values at the pure boundary', () => {
    expect(() => skills.assertSkillName(null as never)).toThrow('Skill name');
    expect(() => skills.assertSkillName({} as never)).toThrow('Skill name');
  });

  it('writes and links a valid skill idempotently', () => {
    const backend = join(state.home, '.claude', 'skills');
    expect(skills.writeCanonicalSkill('demo-skill', '# Invented skill')).toBe(true);
    expect(skills.writeCanonicalSkill('demo-skill', '# Invented skill')).toBe(false);
    expect(skills.ensureSkillSymlink(backend, 'demo-skill')).toBe('created');
    expect(skills.ensureSkillSymlink(backend, 'demo-skill')).toBe('exists');
    expect(readFileSync(join(backend, 'demo-skill', 'SKILL.md'), 'utf8')).toBe('# Invented skill');
  });

  it('replaces a legacy directory with a symlink without launching a shell', () => {
    const backend = join(state.home, '.claude', 'skills');
    mkdirSync(join(backend, 'demo-skill'), { recursive: true });
    writeFileSync(join(backend, 'demo-skill', 'SKILL.md'), 'old');
    skills.writeCanonicalSkill('demo-skill', 'new');
    expect(skills.ensureSkillSymlink(backend, 'demo-skill')).toBe('updated');
    expect(lstatSync(join(backend, 'demo-skill')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(backend, 'demo-skill', 'SKILL.md'), 'utf8')).toBe('new');
    expect(execSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('repairs a dangling symlink without reading or removing its target', () => {
    const backend = join(state.home, '.claude', 'skills');
    mkdirSync(backend, { recursive: true });
    symlinkSync(join(state.home, 'missing'), join(backend, 'demo-skill'));
    skills.writeCanonicalSkill('demo-skill', 'new');
    expect(skills.ensureSkillSymlink(backend, 'demo-skill')).toBe('updated');
    expect(readlinkSync(join(backend, 'demo-skill'))).toBe(
      join(state.home, '.ink', 'skills', 'demo-skill')
    );
  });

  it.each(['directory', 'file'])('refuses a canonical skill %s symlink', (kind) => {
    const canonical = join(state.home, '.ink', 'skills');
    const outside = join(state.home, 'outside');
    mkdirSync(canonical, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, 'SKILL.md'), 'untouched');
    if (kind === 'directory') {
      symlinkSync(outside, join(canonical, 'demo-skill'));
    } else {
      mkdirSync(join(canonical, 'demo-skill'));
      symlinkSync(join(outside, 'SKILL.md'), join(canonical, 'demo-skill', 'SKILL.md'));
    }
    expect(() => skills.writeCanonicalSkill('demo-skill', 'replacement')).toThrow('symlink');
    expect(readFileSync(join(outside, 'SKILL.md'), 'utf8')).toBe('untouched');
  });
});
