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

  it('returns nothing when the config declares no extraDirs', () => {
    writeConfig('.ink', { email: 'user@example.com' });
    expect(readSkillsConfig()).toEqual({});
  });

  it('treats an explicitly empty extraDirs as "no extra dirs"', () => {
    writeConfig('.ink', { skills: { extraDirs: [] } });
    expect(readSkillsConfig()).toEqual({});
  });

  it('yields nothing when the config is unparseable', () => {
    writeConfig('.ink', '{ not json');
    expect(readSkillsConfig()).toEqual({});
  });

  it('yields nothing when extraDirs is not an array', () => {
    writeConfig('.ink', { skills: { extraDirs: '/not/an/array' } });
    expect(readSkillsConfig()).toEqual({});
  });

  it('yields nothing when extraDirs holds non-string entries', () => {
    writeConfig('.ink', { skills: { extraDirs: ['/ok', 42] } });
    expect(readSkillsConfig()).toEqual({});
  });

  // ~/.pcp/config.json is the pre-rename location. Nothing has written it
  // since, so reading it could only ever resurrect stale directories.
  it('never reads the legacy ~/.pcp/config.json', () => {
    writeConfig('.pcp', { skills: { extraDirs: ['/legacy/skills'] } });
    expect(readSkillsConfig()).toEqual({});
  });

  it('does not consult the legacy config when the canonical one is malformed', () => {
    writeConfig('.ink', '{ not json');
    writeConfig('.pcp', { skills: { extraDirs: ['/legacy/skills'] } });
    expect(readSkillsConfig()).toEqual({});
  });
});
