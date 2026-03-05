import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

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

    expect(settings.permissions).toBeUndefined();
    expect(settings.hooks).toBeDefined();
  });

  it('dry-run does not write file', () => {
    const output = runSb(['permissions', 'auto', '--dry-run'], tmpDir);
    expect(output).toContain('Would write');
    expect(existsSync(join(tmpDir, '.claude', 'settings.local.json'))).toBe(false);
  });
});
