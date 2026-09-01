/**
 * Regression: create_studio must seed a new studio's local config from the
 * resolved MAIN worktree root, not from the caller's repoRoot. A linked
 * worktree calling create_studio would otherwise copy its own customised
 * .mcp.json (or nothing at all) into the new studio even when main has the
 * canonical bootstrap files. Mirrors the CLI's canonical-main default
 * (resolveCopySourceRoot).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

vi.mock('../../services/user-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/user-resolver')>();
  return {
    ...actual,
    resolveUserOrThrow: vi.fn(async () => ({
      user: { id: '00000000-0000-0000-0000-000000000001' },
    })),
  };
});

vi.mock('../../services/studio-settings', () => ({
  ensureStudioSettings: vi.fn(async () => undefined),
}));

import { handleCreateStudio } from './studio-handlers';
import type { DataComposer } from '../../data/composer';

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: 'pipe' });
}

const MAIN_MCP = JSON.stringify({
  mcpServers: { inkwell: { type: 'http', url: 'http://main-config' } },
});
const LINKED_MCP = JSON.stringify({
  mcpServers: { inkwell: { type: 'http', url: 'http://linked-custom' } },
});

describe('handleCreateStudio bootstrap source', () => {
  let base: string;
  let mainRoot: string;
  let linkedPath: string;

  const studiosCreate = vi.fn(async (input: Record<string, unknown>) => ({
    id: 'studio-test-id',
    status: 'active',
    createdAt: '2026-08-12T00:00:00Z',
    ...input,
  }));

  const dataComposer = {
    repositories: {
      studios: { create: studiosCreate },
      projects: { findById: vi.fn() },
    },
  } as unknown as DataComposer;

  beforeEach(() => {
    // realpath because git prints resolved worktree paths (macOS tmpdir is a
    // symlink: /var/folders → /private/var/folders) and the handler derives
    // the new studio path from git's output.
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'studio-bootstrap-')));
    mainRoot = path.join(base, 'repo');
    mkdirSync(mainRoot);
    git('init -b main', mainRoot);
    git('config user.email test@example.com', mainRoot);
    git('config user.name Test', mainRoot);
    writeFileSync(path.join(mainRoot, '.gitignore'), '.mcp.json\n.env.local\n.codex/\n.gemini/\n');
    git('add .gitignore', mainRoot);
    git('commit -m init', mainRoot);

    // Bootstrap files are gitignored — they exist only as local files in main
    writeFileSync(path.join(mainRoot, '.mcp.json'), MAIN_MCP);
    writeFileSync(path.join(mainRoot, '.env.local'), 'SOURCE=main\n');

    // A linked worktree with a customised .mcp.json and no .env.local
    linkedPath = path.join(base, 'repo--linked');
    git(`worktree add -b linked ${linkedPath}`, mainRoot);
    writeFileSync(path.join(linkedPath, '.mcp.json'), LINKED_MCP);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('seeds a studio created from a linked worktree with main config, not the linked copy', async () => {
    const result = await handleCreateStudio(
      {
        agentId: 'wren',
        repoRoot: linkedPath, // caller is inside the linked worktree
        slug: 'fresh',
        baseBranch: 'main',
      },
      dataComposer
    );

    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);

    const studioPath = path.join(base, 'repo--fresh');
    expect(existsSync(studioPath)).toBe(true);

    // .mcp.json must come from main, not the linked worktree's customised copy
    expect(readFileSync(path.join(studioPath, '.mcp.json'), 'utf-8')).toBe(MAIN_MCP);
    // .env.local exists only in main — bootstrapping from the linked path
    // would have copied nothing
    expect(readFileSync(path.join(studioPath, '.env.local'), 'utf-8')).toBe('SOURCE=main\n');

    // The studio record is anchored to the resolved main root as well
    expect(studiosCreate).toHaveBeenCalledWith(expect.objectContaining({ repoRoot: mainRoot }));
  });

  it('seeds a studio created from the main root with its own config', async () => {
    const result = await handleCreateStudio(
      {
        agentId: 'wren',
        repoRoot: mainRoot,
        slug: 'direct',
        baseBranch: 'main',
      },
      dataComposer
    );

    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);

    const studioPath = path.join(base, 'repo--direct');
    expect(readFileSync(path.join(studioPath, '.mcp.json'), 'utf-8')).toBe(MAIN_MCP);
    expect(readFileSync(path.join(studioPath, '.env.local'), 'utf-8')).toBe('SOURCE=main\n');
  });
});

/**
 * close_studio must rescue before it destroys (Lumen, PR #563 P1).
 *
 * Ephemeral worktrees are detached: a CLEAN tree can hold commits reachable
 * from no branch, and `git worktree remove` deletes them without complaint.
 * The rescue behaviour itself (stash + ink-rescue anchoring) is pinned
 * behaviourally in studio-lease.service.test.ts; what a mock cannot see is
 * whether close_studio actually CALLS it inside the destructive window — so
 * the wiring is pinned in source order, the same way the ActiveRun clear
 * ordering is pinned in interrupt-active-runs.test.ts.
 */
describe('close_studio rescues before removal (source order)', () => {
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'studio-handlers.ts'),
    'utf-8'
  );
  const removalAt = source.indexOf("['worktree', 'remove', '--', studio.worktreePath]");

  it('captures with rescue enabled between the claim check and the removal', () => {
    const claimCheckAt = source.lastIndexOf('verifyClaim', removalAt);
    const captureAt = source.lastIndexOf('captureWorktreeState', removalAt);
    expect(removalAt).toBeGreaterThan(-1);
    expect(captureAt).toBeGreaterThan(claimCheckAt);
    // The capture in that window runs with rescue enabled.
    expect(source.slice(captureAt, removalAt)).toContain('rescue: true');
  });

  it('fails closed: an unsuccessful rescue aborts with the studio intact', () => {
    const captureAt = source.lastIndexOf('captureWorktreeState', removalAt);
    const gate = source.slice(captureAt, removalAt);
    expect(gate).toContain('rescueSucceeded');
    expect(gate).toContain('abortKeepingStudioUsable');
  });

  it('tolerates an already-absent worktree instead of failing its close', () => {
    const captureAt = source.lastIndexOf('captureWorktreeState', removalAt);
    const guard = source.slice(source.lastIndexOf('worktreePresent', captureAt), captureAt);
    expect(guard).toContain('worktreePresent');
  });
});
