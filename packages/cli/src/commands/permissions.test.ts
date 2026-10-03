import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { DEFAULT_CLAUDE_ALLOW_RULES, DEFAULT_CLAUDE_DENY_RULES } from '@inklabs/shared';

const CLI_PATH = join(__dirname, '..', '..', 'dist', 'cli.js');

function runSb(args: string[], cwd: string): string {
  return execFileSync('node', [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

function readSettings(cwd: string): Record<string, unknown> {
  const p = join(cwd, '.claude', 'settings.local.json');
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, 'utf-8'));
}

describe('sb permissions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sb-perms-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('auto creates allow and deny rules', () => {
    runSb(['permissions', 'auto'], tmpDir);
    const settings = readSettings(tmpDir);
    const perms = settings.permissions as { allow: string[]; deny: string[] };

    expect(perms.allow).toContain('Bash(*)');
    expect(perms.allow).toContain('Edit(*)');
    expect(perms.deny).toContain('Bash(rm -rf *)');
    expect(perms.deny).toContain('Bash(git push --force *)');
    expect(perms.deny).toContain('Bash(git reset --hard *)');
  });

  it('auto writes the one shared list, not a copy of it (design v3, item 6)', () => {
    runSb(['permissions', 'auto'], tmpDir);
    const perms = readSettings(tmpDir).permissions as { allow: string[]; deny: string[] };
    expect(perms.allow).toEqual([...DEFAULT_CLAUDE_ALLOW_RULES]);
    expect(perms.deny).toEqual([...DEFAULT_CLAUDE_DENY_RULES]);
    // The drifted copy never had it.
    expect(perms.allow).toContain('mcp__playwright__*');
  });

  it('preserves existing non-permission settings', () => {
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.claude', 'settings.local.json'),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] },
        enableAllProjectMcpServers: true,
      })
    );

    runSb(['permissions', 'auto'], tmpDir);
    const settings = readSettings(tmpDir);

    expect(settings.hooks).toBeDefined();
    expect(settings.enableAllProjectMcpServers).toBe(true);
    expect((settings.permissions as { allow: string[] }).allow).toContain('Bash(*)');
  });

  it('show reports no rules when none configured', () => {
    const output = runSb(['permissions', 'show'], tmpDir);
    expect(output).toContain('No permission rules configured');
  });

  it('show displays configured rules', () => {
    runSb(['permissions', 'auto'], tmpDir);
    const output = runSb(['permissions', 'show'], tmpDir);
    expect(output).toContain('Bash(*)');
    expect(output).toContain('rm -rf');
  });

  it('reset removes permission rules', () => {
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.claude', 'settings.local.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(*)'], deny: ['Bash(rm -rf *)'] },
        hooks: { Stop: [] },
      })
    );

    runSb(['permissions', 'reset'], tmpDir);
    const settings = readSettings(tmpDir);

    // An empty object, not a deleted key: `ink init` keeps an authored
    // object, and would fill a missing one with a profile (review 4177f7fe).
    expect(settings.permissions).toEqual({});
    expect(settings.hooks).toBeDefined();
  });

  it('reset leaves a durable {} for mode-only, ask-only, a missing key and a missing file (Lumen d74ce85d, P2 4)', () => {
    // A mode-only bypassPermissions must not survive a reset, and a missing
    // permissions key would be filled with a profile by the next ink init.
    const path = join(tmpDir, '.claude', 'settings.local.json');
    for (const before of [
      { permissions: { defaultMode: 'bypassPermissions' }, model: 'kept' },
      { permissions: { ask: ['Bash(*)'] }, model: 'kept' },
      { model: 'kept' },
    ]) {
      mkdirSync(join(tmpDir, '.claude'), { recursive: true });
      writeFileSync(path, JSON.stringify(before));
      runSb(['permissions', 'reset'], tmpDir);
      expect(readSettings(tmpDir), JSON.stringify(before)).toEqual({
        permissions: {},
        model: 'kept',
      });
    }
    rmSync(join(tmpDir, '.claude'), { recursive: true, force: true });
    runSb(['permissions', 'reset'], tmpDir);
    expect(readSettings(tmpDir)).toEqual({ permissions: {} });
  }, 20_000);

  // Each case spawns the built CLI (~0.5 s), so the cases are the minimum
  // that reaches both refusals in every command, with room for a loaded run.
  it('auto, reset and show refuse a malformed settings file and leave its bytes', () => {
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    const path = join(tmpDir, '.claude', 'settings.local.json');
    for (const [content, sub] of [
      ['{ "permissions": ', 'auto'],
      ['{ "permissions": ', 'reset'],
      ['{ "permissions": ', 'show'],
      ['[1, 2]', 'auto'],
    ]) {
      writeFileSync(path, content);
      let status = 0;
      try {
        runSb(['permissions', sub], tmpDir);
      } catch (error) {
        status = (error as { status?: number }).status ?? -1;
      }
      expect(status, `${sub} on ${content}`).toBe(1);
      expect(readFileSync(path, 'utf-8'), `${sub} on ${content}`).toBe(content);
    }
  }, 20_000);

  it('dry-run does not write file', () => {
    const output = runSb(['permissions', 'auto', '--dry-run'], tmpDir);
    expect(output).toContain('Would write');
    expect(existsSync(join(tmpDir, '.claude', 'settings.local.json'))).toBe(false);
  });
});
