/**
 * Compatibility with files and environments written before agentId -> sbSlug.
 *
 * Nothing rewrites ~/.ink/config.json or a studio's .ink/identity.json on
 * upgrade, and long-running processes keep the environment they started with.
 * Each test feeds the OLD shape to the NEW code.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveSlug, readIdentityJson } from './identity.js';

describe('identities written before the rename', () => {
  const saved: Record<string, string | undefined> = {};
  let originalCwd: string;
  let rootDir: string;
  let workDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    for (const k of ['HOME', 'AGENT_ID', 'SB_SLUG', 'SB_BACKEND', 'INK_BACKEND'])
      saved[k] = process.env[k];

    rootDir = mkdtempSync(join(tmpdir(), 'ink-legacy-slug-'));
    workDir = join(rootDir, 'work');
    mkdirSync(join(workDir, '.ink'), { recursive: true });
    process.chdir(workDir);

    process.env.HOME = rootDir;
    for (const k of ['AGENT_ID', 'SB_SLUG', 'SB_BACKEND', 'INK_BACKEND']) delete process.env[k];
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(rootDir, { recursive: true, force: true });
  });

  const writeIdentity = (obj: unknown) =>
    writeFileSync(join(workDir, '.ink', 'identity.json'), JSON.stringify(obj));
  const writeConfig = (obj: unknown) => {
    mkdirSync(join(rootDir, '.ink'), { recursive: true });
    writeFileSync(join(rootDir, '.ink', 'config.json'), JSON.stringify(obj));
  };

  describe('.ink/identity.json', () => {
    it('reads a legacy agentId key as sbSlug', () => {
      writeIdentity({ agentId: 'wren', context: 'main' });
      expect(readIdentityJson(workDir)?.sbSlug).toBe('wren');
    });

    it('prefers sbSlug when a file carries both', () => {
      writeIdentity({ sbSlug: 'lumen', agentId: 'wren' });
      expect(readIdentityJson(workDir)?.sbSlug).toBe('lumen');
    });

    it('resolves a slug from a legacy file with nothing else configured', () => {
      writeIdentity({ agentId: 'aster', context: 'main' });
      expect(resolveSlug()).toBe('aster');
    });
  });

  describe('environment', () => {
    it('falls back to AGENT_ID when SB_SLUG is absent', () => {
      process.env.AGENT_ID = 'myra';
      expect(resolveSlug()).toBe('myra');
    });

    it('prefers SB_SLUG over a stale inherited AGENT_ID', () => {
      process.env.SB_SLUG = 'benson';
      process.env.AGENT_ID = 'myra';
      expect(resolveSlug()).toBe('benson');
    });

    it('still lets an explicit --agent beat both', () => {
      process.env.SB_SLUG = 'benson';
      process.env.AGENT_ID = 'myra';
      expect(resolveSlug('wren')).toBe('wren');
    });
  });

  describe('~/.ink/config.json', () => {
    it('reads a legacy agentMapping', () => {
      writeConfig({ agentMapping: { 'claude-code': 'wren' } });
      expect(resolveSlug(undefined, 'claude')).toBe('wren');
    });

    it('prefers sbMapping when a config carries both', () => {
      writeConfig({
        sbMapping: { 'claude-code': 'lumen' },
        agentMapping: { 'claude-code': 'wren' },
      });
      expect(resolveSlug(undefined, 'claude')).toBe('lumen');
    });

    it('returns null when nothing anywhere names an SB', () => {
      // Control: the fallbacks must not invent an identity.
      expect(resolveSlug()).toBeNull();
    });
  });
});
