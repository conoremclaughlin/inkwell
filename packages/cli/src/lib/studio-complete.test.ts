/**
 * completeStudio (task c3b34be8): the one routine every creator of a studio
 * worktree runs, and what `ink init` runs to repair a partial one. Pinned
 * here: a fresh linked worktree ends complete by the shared checklist; root
 * sync copies the main worktree's local config and permissions, and its
 * absence generates defaults instead; studio setup writes identity and
 * registers the row, and its absence writes neither; a second run changes
 * nothing; an existing identity is never overwritten; nothing is written
 * through a symlink; the main worktree gets hooks and config but no
 * identity, no registration and no default permissions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { auditStudio, DEFAULT_CLAUDE_ALLOW_RULES } from '@inklabs/shared';
import { completeStudio, type StepResult } from './studio-complete.js';
import { installHooks } from '../commands/hooks.js';

let root: string;
let main: string;
let studio: string;

const STUDIO_ID = '191b7705-85bd-4c76-b622-43f655bf7fd6';

function seedMain(dir: string) {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  mkdirSync(join(dir, '.ink'), { recursive: true });
  writeFileSync(
    join(dir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
        trusted: { command: 'node', args: ['trusted.js'] },
      },
    })
  );
  writeFileSync(join(dir, '.env.local'), 'SUPABASE_URL=http://127.0.0.1:54321\n');
  writeFileSync(
    join(dir, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: { allow: ['Bash(git *)', 'Read(*)'], deny: ['Bash(rm -rf *)'] } })
  );
  writeFileSync(
    join(dir, '.ink', 'identity.json'),
    JSON.stringify({ sbSlug: 'wren', studioId: 'main' })
  );
}

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
const statusOf = (steps: StepResult[], label: string) =>
  steps.find((s) => s.label === label)?.status;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-complete-'));
  main = join(root, 'repo');
  studio = join(root, 'repo--alpha');
  mkdirSync(main);
  mkdirSync(studio);
  seedMain(main);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const baseOptions = () => ({
  sbSlug: 'wren',
  mainRoot: main,
  studioName: 'alpha',
  branch: 'wren/feat/alpha',
  purpose: 'test studio',
  register: vi.fn(async () => STUDIO_ID),
  syncSkills: vi.fn(
    async (): Promise<StepResult> => ({
      label: 'skills sync',
      status: 'skipped',
      detail: 'stubbed',
    })
  ),
});

describe('completeStudio — hook steps say whether they created or repaired', () => {
  it('a hook file that carried the Inkwell hooks under an older ink path reports updated, then exists', async () => {
    installHooks(studio, { backend: 'claude-code' });
    const configPath = join(studio, '.claude', 'settings.local.json');
    const config = readJson(configPath);
    const stale = JSON.parse(
      JSON.stringify(config.hooks).replace(
        /"command":"[^"]*? hooks /g,
        '"command":"/old/checkout/ink hooks '
      )
    ) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...config, hooks: stale }, null, 2));

    const first = await completeStudio(studio, baseOptions());
    expect(statusOf(first.steps, 'hooks (claude-code)')).toBe('updated');
    expect(statusOf(first.steps, 'hooks (codex)')).toBe('created');
    expect(statusOf(first.steps, 'hooks (gemini)')).toBe('created');
    expect(JSON.stringify(readJson(configPath).hooks)).not.toContain('/old/checkout/ink');

    const second = await completeStudio(studio, baseOptions());
    expect(statusOf(second.steps, 'hooks (claude-code)')).toBe('exists');
  });
});

describe('completeStudio — a fresh linked worktree', () => {
  it('ends complete by the checklist, with the main worktree config, its permissions, identity, registration and hooks for all three backends', async () => {
    const opts = baseOptions();
    const report = await completeStudio(studio, opts);

    expect(report.linked).toBe(true);
    expect(report.audit.complete, JSON.stringify(report.audit.missing)).toBe(true);

    // Root sync: the main worktree's local config, byte for byte.
    expect(readJson(join(studio, '.mcp.json'))).toEqual(readJson(join(main, '.mcp.json')));
    expect(readFileSync(join(studio, '.env.local'), 'utf-8')).toBe(
      readFileSync(join(main, '.env.local'), 'utf-8')
    );
    // Permissions come from the main worktree, not the defaults.
    const settings = readJson(join(studio, '.claude', 'settings.local.json'));
    expect(settings.permissions).toEqual({
      allow: ['Bash(git *)', 'Read(*)'],
      deny: ['Bash(rm -rf *)'],
    });
    expect(settings.enableAllProjectMcpServers).toBe(true);
    // Identity names this studio, its branch and its row.
    const identity = readJson(join(studio, '.ink', 'identity.json'));
    expect(identity).toMatchObject({
      sbSlug: 'wren',
      studio: 'alpha',
      branch: 'wren/feat/alpha',
      studioId: STUDIO_ID,
      description: 'test studio',
    });
    expect(opts.register).toHaveBeenCalledTimes(1);
    expect(opts.register.mock.calls[0][0]).toMatchObject({
      sbSlug: 'wren',
      repoRoot: main,
      slug: 'alpha',
      purpose: 'test studio',
    });
    // Hooks for every backend, MCP sections for Codex and Gemini.
    expect(readFileSync(join(studio, '.codex', 'config.toml'), 'utf-8')).toContain(
      '[mcp_servers.inkwell]'
    );
    expect(readFileSync(join(studio, '.codex', 'config.toml'), 'utf-8')).toContain(
      'hooks on-stop --backend codex'
    );
    const gemini = readJson(join(studio, '.gemini', 'settings.json'));
    expect(gemini.mcpServers).toHaveProperty('inkwell');
    expect(JSON.stringify(gemini.hooks)).toContain('hooks on-stop --backend gemini');
    expect(opts.syncSkills).toHaveBeenCalledWith(studio);
  });

  it('a second run changes nothing: every step reports exists and the identity is byte-identical', async () => {
    const opts = baseOptions();
    await completeStudio(studio, opts);
    const before = readFileSync(join(studio, '.ink', 'identity.json'), 'utf-8');
    const settingsBefore = readFileSync(join(studio, '.claude', 'settings.local.json'), 'utf-8');

    const again = await completeStudio(studio, opts);

    expect(again.audit.complete).toBe(true);
    const changed = again.steps.filter((s) => s.status === 'created' || s.status === 'updated');
    expect(changed.map((s) => s.label)).toEqual([]);
    expect(readFileSync(join(studio, '.ink', 'identity.json'), 'utf-8')).toBe(before);
    expect(readFileSync(join(studio, '.claude', 'settings.local.json'), 'utf-8')).toBe(
      settingsBefore
    );
    expect(opts.register).toHaveBeenCalledTimes(1);
  });

  it('without root sync it generates the default .mcp.json and the default permissions, and copies no env file', async () => {
    const opts = { ...baseOptions(), rootSync: false };
    const report = await completeStudio(studio, opts);

    expect(report.audit.complete).toBe(true);
    const mcp = readJson(join(studio, '.mcp.json')) as { mcpServers: Record<string, unknown> };
    expect(mcp.mcpServers).toHaveProperty('inkwell');
    expect(mcp.mcpServers).not.toHaveProperty('trusted');
    expect(existsSync(join(studio, '.env.local'))).toBe(false);
    const settings = readJson(join(studio, '.claude', 'settings.local.json')) as {
      permissions: { allow: string[] };
    };
    expect(settings.permissions.allow).toEqual([...DEFAULT_CLAUDE_ALLOW_RULES]);
    expect(statusOf(report.steps, 'permissions')).toBe('created');
  });

  it('without studio setup it writes no identity and registers nothing, and says so', async () => {
    const opts = { ...baseOptions(), studioSetup: false };
    const report = await completeStudio(studio, opts);

    expect(existsSync(join(studio, '.ink', 'identity.json'))).toBe(false);
    expect(opts.register).not.toHaveBeenCalled();
    expect(statusOf(report.steps, 'identity')).toBe('skipped');
    expect(statusOf(report.steps, 'registration')).toBe('skipped');
    // The checklist is honest about it: this worktree is deliberately untracked.
    expect(report.audit.missing).toEqual(['identity', 'studio-id']);
  });

  it('a known studio id is written without a registration call', async () => {
    const opts = { ...baseOptions(), studioId: STUDIO_ID };
    const report = await completeStudio(studio, opts);
    expect(opts.register).not.toHaveBeenCalled();
    expect(readJson(join(studio, '.ink', 'identity.json')).studioId).toBe(STUDIO_ID);
    expect(statusOf(report.steps, 'registration')).toBe('updated');
  });

  it('an existing identity keeps every field it has; only missing ones are filled', async () => {
    mkdirSync(join(studio, '.ink'), { recursive: true });
    writeFileSync(
      join(studio, '.ink', 'identity.json'),
      JSON.stringify({ sbSlug: 'lumen', studio: 'review', role: 'reviewer', studioId: STUDIO_ID })
    );
    const opts = baseOptions();
    const report = await completeStudio(studio, opts);

    const identity = readJson(join(studio, '.ink', 'identity.json'));
    expect(identity).toMatchObject({
      sbSlug: 'lumen',
      studio: 'review',
      role: 'reviewer',
      studioId: STUDIO_ID,
    });
    expect(identity.branch).toBe('wren/feat/alpha');
    expect(opts.register).not.toHaveBeenCalled();
    expect(statusOf(report.steps, 'identity')).toBe('updated');
  });

  it('when the server cannot register, the run completes what it can and the checklist names the gap', async () => {
    const opts = { ...baseOptions(), register: vi.fn(async () => null) };
    const report = await completeStudio(studio, opts);

    expect(statusOf(report.steps, 'registration')).toBe('skipped');
    expect(report.audit.complete).toBe(false);
    expect(report.audit.missing).toEqual(['studio-id']);
    expect(readJson(join(studio, '.ink', 'identity.json')).studioId).toBeUndefined();
  });

  it('a Codex config the sync cannot repair fails the backend configs step, naming the hand edit, rather than reporting a repair (Myra, #701)', async () => {
    const opts = baseOptions();
    await completeStudio(studio, opts);
    const codexPath = join(studio, '.codex', 'config.toml');
    writeFileSync(
      codexPath,
      `${readFileSync(codexPath, 'utf-8')}\n[mcp_servers.inkwell]\nurl = "http://localhost:9999/stale"\n`
    );

    const again = await completeStudio(studio, opts);

    const step = again.steps.find((s) => s.label === 'backend configs');
    expect(step?.status).toBe('failed');
    expect(step?.detail).toContain("kept outside ink's Codex block, as defined there: inkwell");
    expect(step?.detail).toContain(
      "defines the inkwell server outside ink's managed block, where the sync cannot update it"
    );
    expect(again.audit.missing).toEqual(['codex-mcp']);
  });

  it('names a server it kept outside the Codex block, and the studio stays complete (Myra, #701 73a3b6fd)', async () => {
    const opts = baseOptions();
    await completeStudio(studio, opts);
    const codexPath = join(studio, '.codex', 'config.toml');
    writeFileSync(
      codexPath,
      `${readFileSync(codexPath, 'utf-8')}\n[mcp_servers.trusted]\ncommand = "node"\n`
    );

    const again = await completeStudio(studio, opts);

    const step = again.steps.find((s) => s.label === 'backend configs');
    expect(step?.status).toBe('updated');
    expect(step?.detail).toBe(
      ".codex/, .gemini/; kept outside ink's Codex block, as defined there: trusted"
    );
    expect(again.audit.complete).toBe(true);
  });

  it('never writes identity or settings through a symlink', async () => {
    mkdirSync(join(studio, '.ink'), { recursive: true });
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(join(outside, 'identity.json'), join(studio, '.ink', 'identity.json'));
    symlinkSync(outside, join(studio, '.claude'));
    const opts = baseOptions();
    const report = await completeStudio(studio, opts);

    expect(existsSync(join(outside, 'identity.json'))).toBe(false);
    expect(existsSync(join(outside, 'settings.local.json'))).toBe(false);
    expect(statusOf(report.steps, 'identity')).toBe('failed');
    expect(statusOf(report.steps, 'permissions')).toBe('failed');
    expect(opts.register).not.toHaveBeenCalled();
  });
});

describe('completeStudio — a studio never points its MCP config at its own checkout', () => {
  it("the generated inkmail entry names the main worktree's plugin, or nothing, never the studio's copy", async () => {
    // The studio (possibly a PR under review) ships a channel plugin of its
    // own; the main worktree's .mcp.json has inkwell but no inkmail, and the
    // main worktree has no plugin built.
    mkdirSync(join(studio, 'packages', 'channel-plugin'), { recursive: true });
    writeFileSync(join(studio, 'packages', 'channel-plugin', 'index.ts'), '// untrusted');
    writeFileSync(
      join(main, '.mcp.json'),
      JSON.stringify({
        mcpServers: { inkwell: { type: 'http', url: 'http://localhost:3001/mcp' } },
      })
    );
    await completeStudio(studio, baseOptions());
    const mcp = readJson(join(studio, '.mcp.json')) as { mcpServers: Record<string, unknown> };
    expect(JSON.stringify(mcp)).not.toContain(join(studio, 'packages', 'channel-plugin'));
    expect(mcp.mcpServers.inkmail).toBeUndefined();
  });

  it('with the plugin built in the main worktree, the entry names that copy', async () => {
    mkdirSync(join(studio, 'packages', 'channel-plugin'), { recursive: true });
    writeFileSync(join(studio, 'packages', 'channel-plugin', 'index.ts'), '// untrusted');
    mkdirSync(join(main, 'packages', 'channel-plugin'), { recursive: true });
    writeFileSync(join(main, 'packages', 'channel-plugin', 'index.ts'), '// trusted');
    writeFileSync(
      join(main, '.mcp.json'),
      JSON.stringify({
        mcpServers: { inkwell: { type: 'http', url: 'http://localhost:3001/mcp' } },
      })
    );
    await completeStudio(studio, baseOptions());
    const mcp = readJson(join(studio, '.mcp.json')) as {
      mcpServers: { inkmail?: { args?: string[] } };
    };
    expect(mcp.mcpServers.inkmail?.args?.at(-1)).toBe(
      join(main, 'packages', 'channel-plugin', 'index.ts')
    );
  });
});

describe('completeStudio — the main worktree', () => {
  it('gets hooks and backend config but no identity, no registration and no default permissions', async () => {
    const opts = { ...baseOptions(), mainRoot: null };
    rmSync(join(main, '.claude'), { recursive: true, force: true });
    rmSync(join(main, '.ink'), { recursive: true, force: true });
    const report = await completeStudio(main, opts);

    expect(report.linked).toBe(false);
    expect(report.audit.complete).toBe(true);
    expect(existsSync(join(main, '.ink', 'identity.json'))).toBe(false);
    expect(opts.register).not.toHaveBeenCalled();
    const settings = readJson(join(main, '.claude', 'settings.local.json'));
    expect(settings.permissions).toBeUndefined();
    expect(JSON.stringify(settings.hooks)).toContain('hooks on-stop --backend claude-code');
    expect(readFileSync(join(main, '.codex', 'config.toml'), 'utf-8')).toContain(
      '[mcp_servers.inkwell]'
    );
  });

  it('keeps an existing .mcp.json and adds the inkwell server when it lacks one', async () => {
    rmSync(join(main, '.claude'), { recursive: true, force: true });
    writeFileSync(
      join(main, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'x' } } })
    );
    const report = await completeStudio(main, { ...baseOptions(), mainRoot: null });
    const mcp = readJson(join(main, '.mcp.json')) as { mcpServers: Record<string, unknown> };
    expect(mcp.mcpServers).toHaveProperty('other');
    expect(mcp.mcpServers).toHaveProperty('inkwell');
    expect(statusOf(report.steps, '.mcp.json')).toBe('updated');
  });
});
