/**
 * `ink permissions sync` (task cd2fe361): where the profile and its owner
 * come from, and which checkouts it refuses. The file-level behaviour is
 * pinned in lib/permission-sync.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { StudioLookup } from '../lib/studio-lookup.js';
import { runPermissionsSync } from './permissions.js';

let studio: string;
let settingsPath: string;
const AUTHORED = { permissions: { allow: ['Read(*)'], deny: [] } };

beforeEach(() => {
  studio = mkdtempSync(join(tmpdir(), 'permissions-sync-'));
  settingsPath = join(studio, '.claude', 'settings.local.json');
  mkdirSync(join(studio, '.claude'));
  writeFileSync(settingsPath, JSON.stringify(AUTHORED, null, 2) + '\n');
});
afterEach(() => {
  rmSync(studio, { recursive: true, force: true });
});

const linked = () => ({ toplevel: studio, mainRoot: '/repo', linked: true });
const row = (permissionProfile?: 'builder' | 'reviewer', sbSlug?: string) =>
  vi.fn(
    async (): Promise<StudioLookup> => ({
      status: 'found',
      row: {
        id: 'studio-1',
        ...(sbSlug ? { sbSlug } : {}),
        ...(permissionProfile ? { permissionProfile } : {}),
      },
    })
  );
const unchanged = () =>
  expect(readFileSync(settingsPath, 'utf-8')).toBe(JSON.stringify(AUTHORED, null, 2) + '\n');

describe('runPermissionsSync', () => {
  it("takes the profile and owner from the studio's row", async () => {
    const lookupStudio = row('reviewer', 'lumen');
    const report = await runPermissionsSync(studio, {}, { placement: linked, lookupStudio });
    expect(lookupStudio).toHaveBeenCalledWith(studio);
    expect(report).toMatchObject({ outcome: 'would-add', profile: 'reviewer', owner: 'lumen' });
    if (!('plan' in report) || !report.plan) throw new Error('no plan');
    expect(report.plan.addDeny).toContain('Bash(git commit *)');
    expect(report.plan.addAllow).toContain('Edit(~/.ink/files/lumen-scratch/**)');
    unchanged();
  });

  it('writes only with apply', async () => {
    const report = await runPermissionsSync(
      studio,
      { apply: true },
      { placement: linked, lookupStudio: row('builder', 'wren') }
    );
    expect(report.outcome).toBe('added');
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).permissions.allow).toContain(
      'mcp__playwright__*'
    );
  });

  it('flags a person passed win over the row, and both flags need no row at all', async () => {
    const fromFlags = await runPermissionsSync(
      studio,
      { profile: 'builder', owner: 'myra' },
      { placement: linked, lookupStudio: vi.fn(async () => ({ status: 'none' }) as const) }
    );
    expect(fromFlags).toMatchObject({ outcome: 'would-add', profile: 'builder', owner: 'myra' });

    const mixed = await runPermissionsSync(
      studio,
      { profile: 'builder' },
      { placement: linked, lookupStudio: row('reviewer', 'lumen') }
    );
    expect(mixed).toMatchObject({ profile: 'builder', owner: 'lumen' });
  });

  it('refuses the main worktree, whose settings are the operator’s own rules', async () => {
    const lookupStudio = row('builder', 'wren');
    const report = await runPermissionsSync(
      studio,
      { apply: true },
      { placement: () => ({ toplevel: studio, mainRoot: null, linked: false }), lookupStudio }
    );
    expect(report.outcome).toBe('refused');
    expect(lookupStudio).not.toHaveBeenCalled();
    unchanged();
  });

  it('refuses when the row cannot be read, is missing, or names no profile, and changes nothing', async () => {
    const cases: Array<() => Promise<StudioLookup>> = [
      async () => ({ status: 'unknown', reason: 'server not reachable' }),
      async () => ({ status: 'none' }),
      async () => ({ status: 'found', row: { id: 'studio-1', sbSlug: 'wren' } }),
    ];
    for (const lookupStudio of cases) {
      const report = await runPermissionsSync(
        studio,
        { apply: true },
        { placement: linked, lookupStudio }
      );
      expect(report.outcome).toBe('refused');
    }
    unchanged();
  });

  it('refuses an unknown profile name and an owner that cannot name a scratch path', async () => {
    const badProfile = await runPermissionsSync(
      studio,
      { apply: true, profile: 'admin', owner: 'wren' },
      { placement: linked }
    );
    expect(badProfile.outcome).toBe('refused');
    const badOwner = await runPermissionsSync(
      studio,
      { apply: true, profile: 'builder', owner: '../x' },
      { placement: linked }
    );
    expect(badOwner.outcome).toBe('refused');
    unchanged();
  });
});
