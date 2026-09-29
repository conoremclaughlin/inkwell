/**
 * Lumen's round-1 findings on PR #699, kept as regressions, plus the
 * classification they asked for.
 *
 * The first test is Lumen's reproduction as delivered: an unavailable
 * server on the first launch, the studio's real owner on the second. At
 * 5f6dd7bb the first launch wrote the visitor as owner and the second kept
 * it, because a lookup that failed was treated as a lookup that found
 * nothing and completeStudio never replaces an owner it finds. The rule
 * now: only the server's own "Studio not found" means none; every other
 * failure is no answer, and no answer writes no owner.
 *
 * The chain under test is real — completeStudioForLaunch → runInit →
 * completeStudio on a temp worktree with a stubbed placement — with the
 * RPC mocked at ink-mcp, registration and skills stubbed, the backend
 * lookup stubbed, and HOME isolated before anything reads it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { auditStudio } from '@inklabs/shared';

const isolated = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pr699-home-'));
  process.env.HOME = home;
  return { home };
});

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('./ink-mcp.js', () => ({
  callInkTool: rpc.call,
  getInkServerUrl: () => 'http://127.0.0.1:1',
}));

import { completeStudioForLaunch, describeLaunchStudioResult } from './launch-studio.js';
import { runInit } from '../commands/init.js';

let root: string;
let studio: string;
let main: string;
const STUDIO_ID = '00000000-0000-4000-8000-000000000699';
const placement = () => ({ toplevel: studio, mainRoot: main, linked: true });
const initDeps = () => ({
  register: vi.fn(async () => null),
  syncSkills: vi.fn(async () => ({ label: 'skills', status: 'skipped' as const })),
  lookupBackend: vi.fn(async (slug: string) => (slug === 'lumen' ? 'codex' : 'claude')),
});
const identityPath = () => join(studio, '.ink', 'identity.json');
const identity = () => JSON.parse(readFileSync(identityPath(), 'utf8')) as Record<string, unknown>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pr699-review-'));
  studio = join(root, 'repo--owner');
  main = join(root, 'repo');
  mkdirSync(studio);
  mkdirSync(main);
  rpc.call.mockReset();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  // The isolated HOME outlives the suite by design; keep it empty of anything
  // a test wrote so the next test starts as the first did.
  for (const entry of ['.ink'])
    rmSync(join(isolated.home, entry), { recursive: true, force: true });
});

// The placement is stubbed at BOTH layers: the launcher's own read and the
// one runInit makes for itself. A temp directory is not a git worktree, and
// without the second stub runInit would treat it as a main worktree and
// write no identity for any reason, which would make every test here pass
// vacuously against the bug it is meant to catch.
function launch(slug: string, d = initDeps()) {
  return completeStudioForLaunch(studio, slug, {
    placement,
    runInit: (cwd, opts) => runInit(cwd, opts, { ...d, placement }),
  });
}

describe('an unavailable owner lookup is not permission to assign the launch identity (Lumen, #699 P1)', () => {
  it('does not permanently assign the visitor as owner after an unavailable lookup', async () => {
    rpc.call.mockRejectedValueOnce(new Error('fetch failed'));
    await launch('wren');
    const afterFailure = existsSync(identityPath()) ? identity().sbSlug : undefined;
    // The server recovers and returns the studio's real owner on the next launch.
    rpc.call.mockResolvedValueOnce({ studio: { id: STUDIO_ID, sbSlug: 'lumen' } });
    await launch('wren');
    expect({ afterFailure, afterRecovery: identity().sbSlug }).toEqual({
      afterFailure: undefined,
      afterRecovery: 'lumen',
    });
  });

  it('with no answer, everything that needs no owner is still completed, and the report says what was left', async () => {
    rpc.call.mockRejectedValueOnce(new Error('Inkwell call failed (401): token rejected'));
    const result = await launch('wren');
    expect(result.ran).toBe(true);
    expect(result.owner).toBeUndefined();
    expect(result.ownerUnknown).toContain('401');
    expect(existsSync(identityPath())).toBe(false);
    const audit = auditStudio(studio, { linked: true });
    expect(audit.missing).toEqual(['identity', 'studio-id']);
    const [line] = describeLaunchStudioResult(result);
    expect(line).toContain('owner is unknown');
    expect(line).toContain('ink init');
  });

  it('a server answer with neither a studio nor an error is no answer either', async () => {
    rpc.call.mockResolvedValueOnce({ success: true });
    const result = await launch('wren');
    expect(result.ownerUnknown).toBeTruthy();
    expect(existsSync(identityPath())).toBe(false);
  });

  it("only the server's own 'Studio not found' means none: then the launching slug owns and registers", async () => {
    rpc.call.mockRejectedValueOnce(new Error('Inkwell tool error: Studio not found'));
    const d = initDeps();
    d.register.mockResolvedValueOnce(STUDIO_ID);
    const result = await launch('wren', d);
    expect(result.owner).toBe('wren');
    expect(identity()).toMatchObject({ sbSlug: 'wren', studioId: STUDIO_ID, backend: 'claude' });
    expect(d.register).toHaveBeenCalledWith(expect.objectContaining({ sbSlug: 'wren' }));
  });

  it('a row with an owner names that owner, whoever launches', async () => {
    rpc.call.mockResolvedValueOnce({ studio: { id: STUDIO_ID, sbSlug: 'lumen' } });
    const d = initDeps();
    const result = await launch('wren', d);
    expect(result.owner).toBe('lumen');
    expect(identity()).toMatchObject({ sbSlug: 'lumen', studioId: STUDIO_ID, backend: 'codex' });
    expect(d.register).not.toHaveBeenCalled();
    expect(d.lookupBackend).toHaveBeenCalledWith('lumen');
  });

  it('an existing local owner keeps its file whatever the server says, and the backend is theirs', async () => {
    mkdirSync(join(studio, '.ink'));
    writeFileSync(identityPath(), JSON.stringify({ sbSlug: 'lumen' }));
    rpc.call.mockRejectedValueOnce(new Error('fetch failed'));
    await launch('wren');
    // No answer: the file is not touched, not even to record the studio id.
    expect(identity()).toEqual({ sbSlug: 'lumen' });
    rpc.call.mockResolvedValueOnce({ studio: { id: STUDIO_ID, sbSlug: 'lumen' } });
    await launch('wren');
    expect(identity()).toMatchObject({ sbSlug: 'lumen', studioId: STUDIO_ID, backend: 'codex' });
  });
});
