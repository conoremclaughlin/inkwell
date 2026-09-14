/**
 * The OpenClaw plugin's persisted user configuration, across the rename.
 *
 * plugins.entries.pcp.config.agentId is what users already have on disk.
 * Updating the manifest does not rewrite their files, and the schema sets
 * additionalProperties:false — so dropping the key made the manifest REJECT a
 * working config, and the code read only the new key even when validation was
 * bypassed. Persisted user configuration is not an MCP tool parameter.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveSlug } from './index';

const manifest = JSON.parse(readFileSync(join(__dirname, 'openclaw.plugin.json'), 'utf-8')) as {
  configSchema: { additionalProperties: boolean; properties: Record<string, unknown> };
};

describe('openclaw plugin config manifest', () => {
  it('is strict, which is why a dropped key would reject an existing config', () => {
    // Guard the guard: if this ever stops being false, the test below proves nothing.
    expect(manifest.configSchema.additionalProperties).toBe(false);
  });

  it('still accepts the key users already have', () => {
    expect(Object.keys(manifest.configSchema.properties)).toContain('agentId');
  });

  it('declares the new key as the one to write', () => {
    expect(Object.keys(manifest.configSchema.properties)).toContain('sbSlug');
  });
});

describe('openclaw plugin identity resolution', () => {
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = ['SB_SLUG', 'AGENT_ID', 'HOME'] as const;
  let root: string;

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      if (k !== 'HOME') delete process.env[k];
    }
    root = mkdtempSync(join(tmpdir(), 'ink-openclaw-config-'));
    process.env.HOME = root;
    mkdirSync(join(root, '.ink'), { recursive: true });
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves a configured legacy agentId', () => {
    // This is what index.ts passes: pluginConfig.sbSlug ?? pluginConfig.agentId
    expect(resolveSlug(undefined ?? 'aster')).toBe('aster');
  });

  it('reads a legacy agentMapping out of the user config', () => {
    writeFileSync(
      join(root, '.ink', 'config.json'),
      JSON.stringify({ agentMapping: { openclaw: 'benson' } })
    );
    expect(resolveSlug()).toBe('benson');
  });

  it('prefers sbMapping when the config carries both', () => {
    writeFileSync(
      join(root, '.ink', 'config.json'),
      JSON.stringify({ sbMapping: { openclaw: 'lumen' }, agentMapping: { openclaw: 'benson' } })
    );
    expect(resolveSlug()).toBe('lumen');
  });

  it('returns null when nothing names an SB', () => {
    // Control: no fabricated identity.
    expect(resolveSlug()).toBeNull();
  });
});
