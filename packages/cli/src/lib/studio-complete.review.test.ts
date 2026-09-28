/**
 * Lumen's round-1 contract probes on PR #692, adopted (task c3b34be8).
 *
 * These run the REAL skills step (the server responses are mocked) so the
 * routine's own guarantees hold end to end, not only for the steps this
 * module writes itself. HOME is a fresh temp dir set before any import,
 * because the skills module captures the home directory at import time and
 * would otherwise write into the real ~/.ink/skills.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  rmSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const home = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathMod = require('path') as typeof import('path');
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'pr692-home-'));
  process.env.HOME = dir;
  delete process.env.INK_ACCESS_TOKEN;
  delete process.env.INK_SESSION_ID;
  delete process.env.INK_CONTEXT;
  process.env.INK_SERVER_URL = 'http://127.0.0.1:1';
  return { dir };
});

vi.mock('./ink-mcp.js', () => ({
  callInkTool: vi.fn(async (name: string) =>
    name === 'list_skills'
      ? {
          success: true,
          skills: [
            {
              name: 'pr692-fixture',
              type: 'mcp',
              mcp: { name: 'pr692-fixture', command: 'node', args: ['never-executed.js'] },
            },
          ],
        }
      : {
          success: true,
          skillName: 'pr692-fixture',
          type: 'mcp',
          version: '1',
          description: 'Synthetic review fixture',
          content: 'Fixture only',
          mcp: { name: 'pr692-fixture', command: 'node', args: ['never-executed.js'] },
        }
  ),
}));

import { completeStudio } from './studio-complete.js';

const id = '00000000-0000-4000-8000-000000000692';
let root: string;
let main: string;
let studio: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pr692-review-')));
  main = join(root, 'repo');
  studio = join(root, 'repo--fixture');
  mkdirSync(main);
  mkdirSync(studio);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('PR #692 round 1 (Lumen): contracts that hold through the real skills step', () => {
  it('keeps a symlinked .mcp.json target unchanged through the REAL skills step', async () => {
    const target = join(root, 'outside.json');
    const original = JSON.stringify({
      mcpServers: { inkwell: { type: 'http', url: 'http://127.0.0.1:1/mcp' } },
    });
    writeFileSync(target, original);
    symlinkSync(target, join(studio, '.mcp.json'));

    const report = await completeStudio(studio, { sbSlug: 'wren', mainRoot: main, studioId: id });

    expect(report.steps.find((s) => s.label === '.mcp.json')?.status).toBe('failed');
    // The skills step is the one writer of .mcp.json this module does not
    // own; it must refuse the link too, and the routine must not hand it
    // a target the earlier step already refused.
    expect(readFileSync(target, 'utf8')).toBe(original);
    expect(report.steps.find((s) => s.label === 'skills sync')?.status).not.toBe('created');
  });

  it('keeps a legacy identity owner when completing for a different caller', async () => {
    mkdirSync(join(studio, '.ink'));
    writeFileSync(
      join(studio, '.ink', 'identity.json'),
      JSON.stringify({ agentId: 'lumen', studio: 'fixture', studioId: id })
    );
    const register = vi.fn(async () => id);
    await completeStudio(studio, {
      sbSlug: 'wren',
      mainRoot: main,
      register,
      syncSkills: async () => ({ label: 'skills sync', status: 'skipped' as const }),
    });
    const saved = JSON.parse(readFileSync(join(studio, '.ink', 'identity.json'), 'utf8'));
    expect(saved.sbSlug ?? saved.agentId).toBe('lumen');
    expect(register).not.toHaveBeenCalled();
  });

  it('the temp HOME is the one the skills module captured', () => {
    expect(process.env.HOME).toBe(home.dir);
  });
});
