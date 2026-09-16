/**
 * Tests for lib/user-config.ts — resolution order between ~/.ink/config.json
 * and the pre-rename ~/.pcp/config.json.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readUserConfig, userConfigPath, NOT_SIGNED_IN_MESSAGE } from './user-config.js';

let tempHome: string;
let origHome: string | undefined;

function writeConfig(dir: '.ink' | '.pcp', body: unknown): void {
  const target = join(tempHome, dir);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'config.json'), JSON.stringify(body, null, 2) + '\n');
}

beforeEach(() => {
  origHome = process.env.HOME;
  tempHome = join(
    tmpdir(),
    `ink-user-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(tempHome, { recursive: true });
  // homedir() reads HOME on POSIX — override it to sandbox the test.
  process.env.HOME = tempHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
});

describe('readUserConfig', () => {
  it('returns null when no config exists', () => {
    expect(readUserConfig()).toBeNull();
  });

  it('reads ~/.ink/config.json — where `ink auth login` writes', () => {
    writeConfig('.ink', { email: 'user@example.com', userId: 'uuid-1' });
    expect(readUserConfig()).toEqual({ email: 'user@example.com', userId: 'uuid-1' });
  });

  // ~/.ink is canonical. Honouring a stale ~/.pcp/config.json would report an
  // email while ~/.ink/auth.json holds no token, clearing the signed-in gate
  // only to fail deeper. Pre-rename installs need `ink auth login` regardless.
  it('ignores the legacy ~/.pcp/config.json', () => {
    writeConfig('.pcp', { email: 'legacy@example.com', userId: 'uuid-legacy' });
    expect(readUserConfig()).toBeNull();
  });

  it('does not let a legacy config shadow a signed-out ~/.ink', () => {
    writeConfig('.pcp', { email: 'legacy@example.com' });
    mkdirSync(join(tempHome, '.ink'), { recursive: true });
    writeFileSync(join(tempHome, '.ink', 'config.json'), '{ not json');
    expect(readUserConfig()).toBeNull();
  });

  it('returns null when ~/.ink/config.json is unparseable', () => {
    mkdirSync(join(tempHome, '.ink'), { recursive: true });
    writeFileSync(join(tempHome, '.ink', 'config.json'), '{ not json');
    expect(readUserConfig()).toBeNull();
  });

  it('surfaces agentMapping and skills.extraDirs', () => {
    writeConfig('.ink', {
      email: 'user@example.com',
      agentMapping: { 'claude-code': 'wren' },
      skills: { extraDirs: ['~/.openclaw/skills'] },
    });
    const config = readUserConfig();
    expect(config?.agentMapping?.['claude-code']).toBe('wren');
    expect(config?.skills?.extraDirs).toEqual(['~/.openclaw/skills']);
  });
});

describe('config paths', () => {
  it('points at ~/.ink/config.json', () => {
    expect(userConfigPath()).toBe(join(tempHome, '.ink', 'config.json'));
  });
});

describe('NOT_SIGNED_IN_MESSAGE', () => {
  // `ink init` only touches the repo; it never writes ~/.ink/config.json.
  // Telling users to run it left them in a loop (issue #331).
  it('directs users to `ink auth login`, not `ink init`', () => {
    expect(NOT_SIGNED_IN_MESSAGE).toContain('ink auth login');
    expect(NOT_SIGNED_IN_MESSAGE).not.toContain('ink init');
  });
});
