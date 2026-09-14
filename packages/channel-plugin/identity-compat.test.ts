/**
 * The channel plugin's own identity resolution, against pre-rename inputs.
 *
 * This is a SECOND reader of .ink/identity.json — it does not share the CLI's
 * readIdentityJson funnel — so normalizing there did not cover it. With an
 * existing legacy file it silently fell through to the 'wren' default and would
 * have polled and marked messages under the wrong identity.
 *
 * These exercise the real exported resolver, not a copy of its logic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveSlug } from './index';

const ENV_KEYS = ['INK_SB_SLUG', 'INK_AGENT_ID', 'SB_SLUG', 'AGENT_ID'] as const;

describe('channel plugin identity resolution', () => {
  const saved: Record<string, string | undefined> = {};
  let root: string;
  let cwd: string;

  const writeIdentity = (obj: unknown) => {
    mkdirSync(join(root, '.ink'), { recursive: true });
    writeFileSync(join(root, '.ink', 'identity.json'), JSON.stringify(obj));
  };

  beforeEach(() => {
    cwd = process.cwd();
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    root = mkdtempSync(join(tmpdir(), 'ink-channel-identity-'));
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(cwd);
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves a legacy identity.json rather than falling back to the default', () => {
    writeIdentity({ agentId: 'aster', context: 'main' });

    const slug = resolveSlug();

    expect(slug).toBe('aster');
    // The fallback is what made this silent: wrong identity, no error.
    expect(slug).not.toBe('wren');
  });

  it('honours the documented SB_SLUG', () => {
    process.env.SB_SLUG = 'aster';
    expect(resolveSlug()).toBe('aster');
  });

  it('keeps the plugin-specific override ahead of the general one', () => {
    process.env.INK_SB_SLUG = 'benson';
    process.env.SB_SLUG = 'aster';
    expect(resolveSlug()).toBe('benson');
  });

  it('still reads the pre-rename AGENT_ID for processes that predate the change', () => {
    process.env.AGENT_ID = 'myra';
    expect(resolveSlug()).toBe('myra');
  });

  it('prefers a current-format file over the legacy key', () => {
    writeIdentity({ sbSlug: 'lumen', agentId: 'aster' });
    expect(resolveSlug()).toBe('lumen');
  });

  it('still defaults when nothing names an SB', () => {
    // Control: the compat paths must not invent an identity.
    expect(resolveSlug()).toBe('wren');
  });
});
