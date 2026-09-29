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
  type LaunchStudioDeps,
  type LaunchStudioLookup,
} from './launch-studio.js';

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

describe('completeStudioForLaunch', () => {
  it("an incomplete studio is completed for its row's owner, not for the -a slug", async () => {
    // `ink -a wren` in Lumen's studio: the identity file must say lumen.
    const d = deps();
    const result = await completeStudioForLaunch(studio, 'wren', d);
    expect(result.ran).toBe(true);
    expect(result.owner).toBe('lumen');
    expect(result.missingBefore).toContain('identity');
    expect(d.lookupStudio).toHaveBeenCalledWith(studio);
    expect(d.runInit).toHaveBeenCalledWith(studio, { agent: 'lumen', studioId: STUDIO_ID });
  });

  it('a worktree the server confirms has no row takes the launching slug and registers as ink init would', async () => {
    const d = deps({
      lookupStudio: vi.fn(async (): Promise<LaunchStudioLookup> => ({ status: 'none' })),
    });
    const result = await completeStudioForLaunch(studio, 'wren', d);
    expect(result.owner).toBe('wren');
    expect(d.runInit).toHaveBeenCalledWith(studio, { agent: 'wren' });
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
    expect(d.runInit).toHaveBeenCalledWith(studio, { agent: 'wren', studioSetup: false });
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
    expect(lines[0]).toBe('Studio completed for lumen: identity, hooks (gemini)');
    expect(lines[1]).toContain('studio-id');
    expect(lines[1]).toContain('ink init');
  });

  it('a completed run reports what it wrote, in one line', async () => {
    const result = await completeStudioForLaunch(studio, 'wren', deps());
    expect(describeLaunchStudioResult(result)).toEqual([
      'Studio completed for lumen: identity, hooks (gemini)',
    ]);
    expect(describeLaunchStudioResult({ ran: false })).toEqual([]);
  });
});
