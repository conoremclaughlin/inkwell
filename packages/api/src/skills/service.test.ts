/**
 * Tests for readSkillsConfig — precedence between ~/.ink/config.json and the
 * pre-rename ~/.pcp/config.json.
 *
 * The boundary that matters: an explicit `skills.extraDirs` in the canonical
 * config is authoritative even when empty. A value-seeking read would treat
 * `[]` as "nothing found" and reload directories from a stale legacy config
 * that the user had deliberately cleared.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readSkillsConfig } from './service';

let tempHome: string;
let origHome: string | undefined;

function writeConfig(dir: '.ink' | '.pcp', body: unknown): void {
  const target = join(tempHome, dir);
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, 'config.json'),
    typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n'
  );
}

beforeEach(() => {
  origHome = process.env.HOME;
  tempHome = join(
    tmpdir(),
    `ink-skills-config-${process.pid}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(tempHome, { recursive: true });
  process.env.HOME = tempHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
});

describe('readSkillsConfig', () => {
  it('returns nothing when no config exists', () => {
    expect(readSkillsConfig()).toEqual({});
  });

  it('reads extraDirs from the canonical ~/.ink/config.json', () => {
    writeConfig('.ink', { skills: { extraDirs: ['~/.openclaw/skills'] } });
    expect(readSkillsConfig()).toEqual({ extraDirs: ['~/.openclaw/skills'] });
  });

  it('falls back to the legacy ~/.pcp config when the canonical one is absent', () => {
    writeConfig('.pcp', { skills: { extraDirs: ['/legacy/skills'] } });
    expect(readSkillsConfig()).toEqual({ extraDirs: ['/legacy/skills'] });
  });

  it('falls back when the canonical config declares nothing about extraDirs', () => {
    writeConfig('.ink', { email: 'user@example.com' });
    writeConfig('.pcp', { skills: { extraDirs: ['/legacy/skills'] } });
    expect(readSkillsConfig()).toEqual({ extraDirs: ['/legacy/skills'] });
  });

  it('lets the canonical config win over the legacy one', () => {
    writeConfig('.ink', { skills: { extraDirs: ['/current/skills'] } });
    writeConfig('.pcp', { skills: { extraDirs: ['/legacy/skills'] } });
    expect(readSkillsConfig()).toEqual({ extraDirs: ['/current/skills'] });
  });

  // The bug this suite exists for: `[]` means "I want no extra dirs", not
  // "keep looking". Continuing to the legacy config resurrects cleared dirs.
  it('treats an explicitly empty canonical extraDirs as authoritative', () => {
    writeConfig('.ink', { skills: { extraDirs: [] } });
    writeConfig('.pcp', { skills: { extraDirs: ['/legacy/skills'] } });
    expect(readSkillsConfig()).toEqual({});
  });

  it('fails closed when the canonical config is unparseable', () => {
    writeConfig('.ink', '{ not json');
    writeConfig('.pcp', { skills: { extraDirs: ['/legacy/skills'] } });
    expect(readSkillsConfig()).toEqual({});
  });

  it('fails closed when canonical extraDirs is not an array', () => {
    writeConfig('.ink', { skills: { extraDirs: '/not/an/array' } });
    writeConfig('.pcp', { skills: { extraDirs: ['/legacy/skills'] } });
    expect(readSkillsConfig()).toEqual({});
  });

  it('fails closed when canonical extraDirs holds non-string entries', () => {
    writeConfig('.ink', { skills: { extraDirs: ['/ok', 42] } });
    writeConfig('.pcp', { skills: { extraDirs: ['/legacy/skills'] } });
    expect(readSkillsConfig()).toEqual({});
  });

  it('ignores an empty legacy extraDirs rather than returning an empty list', () => {
    writeConfig('.pcp', { skills: { extraDirs: [] } });
    expect(readSkillsConfig()).toEqual({});
  });
});
