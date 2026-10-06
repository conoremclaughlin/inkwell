/**
 * The studio checklist at a launch (task 2841c7a9): an incomplete linked
 * worktree is completed for its ROW's owner before the session is resolved;
 * a complete one and the main worktree are left alone. Placement, the row
 * lookup and the routine are injected; the checklist read is the real one,
 * against real files.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { auditStudio } from '@inklabs/shared';
import type { CompleteStudioReport } from './studio-complete.js';
import {
  completeStudioForLaunch,
  describeLaunchStudioResult,
  offerRootInitAtLaunch,
  type LaunchStudioDeps,
  type LaunchStudioLookup,
  type RootInitDeps,
} from './launch-studio.js';

/** The server's get_studio, for the tests that use the default lookup. */
const server = vi.hoisted(() => ({ studio: null as Record<string, unknown> | null }));
vi.mock('./ink-mcp.js', () => ({
  callInkTool: vi.fn(async () => ({ studio: server.studio })),
}));

let root: string;
let studio: string;

const STUDIO_ID = '191b7705-85bd-4c76-b622-43f655bf7fd6';

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'launch-studio-')));
  studio = join(root, 'repo--alpha');
  mkdirSync(studio);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const linked = () => ({ toplevel: studio, mainRoot: join(root, 'repo'), linked: true });
const main = () => ({ toplevel: join(root, 'repo'), mainRoot: null, linked: false });

function report(complete: boolean): CompleteStudioReport {
  return {
    worktreePath: studio,
    linked: true,
    steps: [
      { label: '.mcp.json', status: 'exists' },
      { label: 'identity', status: 'created', detail: 'sbSlug lumen' },
      { label: 'hooks (gemini)', status: 'created' },
    ],
    audit: {
      worktreePath: studio,
      linked: true,
      checks: [],
      missing: complete ? [] : ['studio-id'],
      complete,
    },
  };
}

function deps(overrides: Partial<LaunchStudioDeps> = {}) {
  return {
    placement: linked,
    lookupStudio: vi.fn(
      async (): Promise<LaunchStudioLookup> => ({
        status: 'found',
        row: { id: STUDIO_ID, sbSlug: 'lumen' },
      })
    ),
    runInit: vi.fn(async () => report(true)),
    ...overrides,
  };
}

/** Every checklist item, so the audit reads complete. */
function seedComplete(dir: string) {
  const INK = 'node /repo/packages/cli/dist/cli.js';
  const cmd = (name: string, backend: string) => ({
    hooks: [{ type: 'command', command: `${INK} hooks ${name} --backend ${backend}` }],
  });
  mkdirSync(join(dir, '.ink'), { recursive: true });
  mkdirSync(join(dir, '.claude'), { recursive: true });
  mkdirSync(join(dir, '.codex'), { recursive: true });
  mkdirSync(join(dir, '.gemini'), { recursive: true });
  writeFileSync(
    join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { inkwell: { type: 'http', url: 'http://localhost:3001/mcp' } } })
  );
  writeFileSync(
    join(dir, '.ink', 'identity.json'),
    JSON.stringify({ sbSlug: 'lumen', studioId: STUDIO_ID })
  );
  writeFileSync(
    join(dir, '.claude', 'settings.local.json'),
    JSON.stringify({
      permissions: { allow: ['Bash(*)'] },
      hooks: {
        PreCompact: [cmd('pre-compact', 'claude-code')],
        SessionStart: [cmd('post-compact', 'claude-code'), cmd('on-session-start', 'claude-code')],
        PreToolUse: [cmd('on-tool-approval', 'claude-code')],
        UserPromptSubmit: [cmd('on-prompt', 'claude-code')],
        Stop: [cmd('on-stop', 'claude-code')],
      },
    })
  );
  writeFileSync(
    join(dir, '.codex', 'config.toml'),
    [
      '[mcp_servers.inkwell]',
      'url = "http://localhost:3001/mcp"',
      '[hooks]',
      `session_start = "${INK} hooks on-session-start --backend codex"`,
      `user_prompt = "${INK} hooks on-prompt --backend codex"`,
      `session_end = "${INK} hooks on-stop --backend codex"`,
    ].join('\n')
  );
  writeFileSync(
    join(dir, '.gemini', 'settings.json'),
    JSON.stringify({
      mcpServers: { inkwell: { type: 'http', url: 'http://localhost:3001/mcp' } },
      hooks: {
        SessionStart: [cmd('on-session-start', 'gemini')],
        BeforeAgent: [cmd('on-prompt', 'gemini')],
        AfterAgent: [cmd('on-stop', 'gemini')],
      },
    })
  );
}

describe('completeStudioForLaunch — the permission profile comes from the row', () => {
  it("a row's profile is passed to ink init", async () => {
    const d = deps({
      lookupStudio: vi.fn(
        async (): Promise<LaunchStudioLookup> => ({
          status: 'found',
          row: { id: STUDIO_ID, sbSlug: 'lumen', permissionProfile: 'reviewer' },
        })
      ),
    });
    await completeStudioForLaunch(studio, 'wren', d);
    expect(d.runInit).toHaveBeenCalledWith(studio, {
      agent: 'lumen',
      studioId: STUDIO_ID,
      permissionProfile: 'reviewer',
    });
  });

  it('the default lookup reads it from get_studio: a detached row is a reviewer, a branch row a builder', async () => {
    for (const [row, expected] of [
      [{ id: STUDIO_ID, sbSlug: 'lumen', branch: 'detached:origin/pr/7' }, 'reviewer'],
      [{ id: STUDIO_ID, sbSlug: 'lumen', branch: 'lumen/feat/x', metadata: {} }, 'builder'],
    ] as const) {
      server.studio = { ...row };
      const d = { placement: linked, runInit: vi.fn(async () => report(true)) };
      await completeStudioForLaunch(studio, 'wren', d);
      expect(d.runInit).toHaveBeenCalledWith(
        studio,
        expect.objectContaining({ agent: 'lumen', permissionProfile: expected })
      );
    }
  });
});

describe('completeStudioForLaunch', () => {
  it("an incomplete studio is completed for its row's owner, not for the -a slug", async () => {
    // `ink -a wren` in Lumen's studio: the identity file must say lumen.
    const d = deps();
    const result = await completeStudioForLaunch(studio, 'wren', d);
    expect(result.ran).toBe(true);
    expect(result.owner).toBe('lumen');
    expect(result.missingBefore).toContain('identity');
    expect(d.lookupStudio).toHaveBeenCalledWith(studio);
    // This row carries no profile, so no permissions are written.
    expect(d.runInit).toHaveBeenCalledWith(studio, {
      agent: 'lumen',
      studioId: STUDIO_ID,
      permissions: false,
    });
  });

  it('a worktree the server confirms has no row takes the launching slug and registers as ink init would', async () => {
    const d = deps({
      lookupStudio: vi.fn(async (): Promise<LaunchStudioLookup> => ({ status: 'none' })),
    });
    const result = await completeStudioForLaunch(studio, 'wren', d);
    expect(result.owner).toBe('wren');
    // No row, no profile: in a detached PR checkout a default would be kept
    // by every later run (review 4177f7fe, P2 1).
    expect(d.runInit).toHaveBeenCalledWith(studio, { agent: 'wren', permissions: false });
  });

  it('a worktree whose owner the server could not name is completed with studio setup off', async () => {
    const d = deps({
      lookupStudio: vi.fn(
        async (): Promise<LaunchStudioLookup> => ({ status: 'unknown', reason: 'fetch failed' })
      ),
    });
    const result = await completeStudioForLaunch(studio, 'wren', d);
    expect(result.owner).toBeUndefined();
    expect(result.ownerUnknown).toBe('fetch failed');
    // Permissions are left too: their profile comes from the same row, and
    // their scratch paths name the owner (design v3, item 5).
    expect(d.runInit).toHaveBeenCalledWith(studio, {
      agent: 'wren',
      studioSetup: false,
      permissions: false,
    });
    const [line, ...rest] = describeLaunchStudioResult(result);
    expect(line).toContain('owner is unknown');
    expect(line).toContain('fetch failed');
    expect(rest).toEqual([]);
  });

  it('a complete studio costs the checklist read and nothing else', async () => {
    seedComplete(studio);
    expect(auditStudio(studio, { linked: true }).complete).toBe(true);
    const d = deps();
    const result = await completeStudioForLaunch(studio, 'wren', d);
    expect(result).toEqual({ ran: false });
    expect(d.lookupStudio).not.toHaveBeenCalled();
    expect(d.runInit).not.toHaveBeenCalled();
  });

  it('the main worktree is never completed from a launch', async () => {
    const d = deps({ placement: main });
    expect(await completeStudioForLaunch(join(root, 'repo'), 'wren', d)).toEqual({ ran: false });
    expect(d.runInit).not.toHaveBeenCalled();
  });

  it('a routine that leaves items missing is reported, with the repair named', async () => {
    const d = deps({ runInit: vi.fn(async () => report(false)) });
    const result = await completeStudioForLaunch(studio, 'wren', d);
    const lines = describeLaunchStudioResult(result);
    expect(lines[0]).toBe('Studio completed for lumen: created identity, hooks (gemini)');
    expect(lines[1]).toContain('studio-id');
    expect(lines[1]).toContain('ink init');
  });

  it('a completed run reports what it wrote, in one line', async () => {
    const result = await completeStudioForLaunch(studio, 'wren', deps());
    expect(describeLaunchStudioResult(result)).toEqual([
      'Studio completed for lumen: created identity, hooks (gemini)',
    ]);
    expect(describeLaunchStudioResult({ ran: false })).toEqual([]);
  });

  it('a repaired file is reported as updated, apart from what was created', async () => {
    // A hook file that carried the Inkwell hooks under an older ink path is
    // rewritten; the line says it was updated, so a repair reads as one.
    const repaired = report(true);
    repaired.steps.push({ label: 'hooks (claude-code)', status: 'updated' });
    const d = deps({ runInit: vi.fn(async () => repaired) });
    const result = await completeStudioForLaunch(studio, 'wren', d);
    expect(describeLaunchStudioResult(result)).toEqual([
      'Studio completed for lumen: created identity, hooks (gemini); updated hooks (claude-code)',
    ]);
  });
});

describe('offerRootInitAtLaunch — a main worktree ink was never set up in (task 5cabaeeb)', () => {
  let repo: string;
  let stderr: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    repo = join(root, 'repo');
    mkdirSync(repo);
    stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    stderr.mockRestore();
  });

  const rootDeps = (overrides: Partial<RootInitDeps> = {}) => ({
    placement: main,
    confirm: vi.fn(async () => true),
    runInit: vi.fn(async () => report(true)),
    ...overrides,
  });
  const printed = () => stderr.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');

  it('an incomplete root asks, and on a yes runs ink init there for the launching SB', async () => {
    const confirm = vi.fn(async (_question: string) => true);
    const d = rootDeps({ confirm });
    const result = await offerRootInitAtLaunch(repo, 'wren', { interactive: true }, d);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain('Run ink init now? [Y/n]');
    expect(confirm.mock.calls[0][0]).toContain('.mcp.json');
    expect(d.runInit).toHaveBeenCalledWith(repo, { agent: 'wren' });
    expect(result).toMatchObject({ offered: true, ran: true });
    expect(result.missingBefore).toContain('mcp-json');
  });

  it('a no leaves every file alone and names the repair', async () => {
    const d = rootDeps({ confirm: vi.fn(async () => false) });
    const result = await offerRootInitAtLaunch(repo, 'wren', { interactive: true }, d);
    expect(d.runInit).not.toHaveBeenCalled();
    expect(result).toMatchObject({ offered: true, ran: false });
    expect(printed()).toContain('Run ink init in');
  });

  it('with no one to ask it warns and changes nothing', async () => {
    const d = rootDeps();
    const result = await offerRootInitAtLaunch(repo, 'wren', { interactive: false }, d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.runInit).not.toHaveBeenCalled();
    expect(result).toMatchObject({ offered: false, ran: false });
    expect(printed()).toContain('Run: ink init');
  });

  it('a complete root is not asked about', async () => {
    seedComplete(repo);
    expect(auditStudio(repo, { linked: false }).complete).toBe(true);
    const d = rootDeps();
    const result = await offerRootInitAtLaunch(repo, 'wren', { interactive: true }, d);
    expect(result).toEqual({ offered: false, ran: false });
    expect(d.confirm).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('a linked worktree is left to the studio routine', async () => {
    const d = rootDeps({ placement: linked });
    const result = await offerRootInitAtLaunch(studio, 'wren', { interactive: true }, d);
    expect(result).toEqual({ offered: false, ran: false });
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it('a failed ink init does not refuse the launch', async () => {
    const d = rootDeps({
      runInit: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });
    await expect(
      offerRootInitAtLaunch(repo, 'wren', { interactive: true }, d)
    ).resolves.toMatchObject({ ran: false });
    expect(printed()).toContain('Run: ink init');
  });
});
