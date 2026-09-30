import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildGeminiSettings, GeminiAdapter, GEMINI_NO_HOME_REFUSAL } from './gemini.js';
import type { EffectiveConfigCheck } from './types.js';

/**
 * GeminiAdapter.checkEffectiveConfig over settings files in a temp root: a
 * home, a studio cwd and the adapter's own system file. Values are synthetic,
 * and no gemini binary runs.
 */
let root: string;
let home: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gemini-effective-config-'));
  home = join(root, 'home');
  cwd = join(root, 'studio');
  mkdirSync(home);
  mkdirSync(cwd);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function settings(dir: string, mcpServers: Record<string, unknown>): void {
  mkdirSync(join(dir, '.gemini'), { recursive: true });
  writeFileSync(join(dir, '.gemini', 'settings.json'), JSON.stringify({ mcpServers }));
}

const check = (overrides: Partial<EffectiveConfigCheck> = {}): EffectiveConfigCheck => ({
  binary: '/synthetic/bin/gemini',
  probeEnv: { HOME: home, PATH: '/synthetic/bin' },
  adapterEnv: {},
  sessionEnvNames: ['INK_ACCESS_TOKEN', 'INK_DELEGATION_SECRET', 'INK_CONTEXT'],
  cwd,
  signal: new AbortController().signal,
  timeoutMs: 10_000,
  inkwellMcpUrl: 'http://localhost:3001/mcp',
  ...overrides,
});

const adapter = new GeminiAdapter();

describe('GeminiAdapter.checkEffectiveConfig', () => {
  it('admits a spawn with no settings files', async () => {
    expect(await adapter.checkEffectiveConfig(check())).toBeUndefined();
  });

  it("refuses a routing header baked into the user's settings, naming the file", async () => {
    settings(home, {
      inkwell: { httpUrl: 'http://localhost:3001/mcp', headers: { 'X-Ink-Session-Id': 's' } },
    });
    const reason = await adapter.checkEffectiveConfig(check());
    expect(reason).toContain(join(home, '.gemini', 'settings.json'));
    expect(reason).toContain('X-Ink-Session-Id');
  });

  it('reads the user settings from GEMINI_CLI_HOME over HOME, as 0.54.0 does', async () => {
    const cliHome = join(root, 'cli-home');
    mkdirSync(cliHome);
    // A decoy under HOME, which Gemini ignores when GEMINI_CLI_HOME is set.
    settings(home, {
      inkwell: { httpUrl: 'http://localhost:3001/mcp', headers: { 'x-ink-context': 's' } },
    });
    settings(cliHome, {});
    expect(
      await adapter.checkEffectiveConfig(check({ adapterEnv: { GEMINI_CLI_HOME: cliHome } }))
    ).toBeUndefined();
    settings(cliHome, {
      inkwell: { httpUrl: 'http://localhost:3001/mcp', headers: { 'x-ink-context': 's' } },
    });
    expect(
      await adapter.checkEffectiveConfig(check({ adapterEnv: { GEMINI_CLI_HOME: cliHome } }))
    ).toContain(join(cliHome, '.gemini', 'settings.json'));
  });

  it('refuses when the spawn env names no home', async () => {
    expect(
      await adapter.checkEffectiveConfig(check({ probeEnv: { PATH: '/synthetic/bin' } }))
    ).toBe(GEMINI_NO_HOME_REFUSAL);
  });

  it('refuses a workspace server other than Inkwell drawing a session var', async () => {
    settings(cwd, {
      other: { httpUrl: 'https://mcp.example.com/', headers: { A: '${INK_DELEGATION_SECRET}' } },
    });
    expect(await adapter.checkEffectiveConfig(check())).toContain('other than Inkwell');
  });

  it("admits the adapter's own system file, per-spawn routing headers and all", async () => {
    // The real file the adapter writes for a named session.
    const system = await buildGeminiSettings(
      join(root, 'tmp'),
      cwd,
      'synthetic-context-token',
      'synthetic-session',
      'synthetic-studio',
      true
    );
    try {
      expect(
        await adapter.checkEffectiveConfig(
          check({ adapterEnv: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: system!.path } })
        )
      ).toBeUndefined();
    } finally {
      await system?.cleanup();
    }
  });

  it('refuses a server copied into the system file that draws the session token', async () => {
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          other: {
            type: 'http',
            url: 'https://mcp.example.com/',
            headers: { A: 'Bearer $INK_ACCESS_TOKEN' },
          },
        },
      })
    );
    const system = await buildGeminiSettings(join(root, 'tmp'), cwd, 'synthetic-context-token');
    try {
      expect(
        await adapter.checkEffectiveConfig(
          check({ adapterEnv: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: system!.path } })
        )
      ).toContain('other than Inkwell');
    } finally {
      await system?.cleanup();
    }
  });

  // Myra's two pins on 72ffb53e (6ca84f50), through the real system file.
  it.each<[string, Record<string, unknown>]>([
    [
      'a stdio server drawing the token through args',
      { other: { command: '/synthetic/tool', args: ['--token', '$INK_ACCESS_TOKEN'] } },
    ],
    [
      'an inkwell entry pointing elsewhere, whose own bearer then counts as foreign',
      { inkwell: { type: 'http', url: 'https://inkwell.example.com/mcp' } },
    ],
  ])('refuses %s, copied from .mcp.json into the system file', async (_label, mcpServers) => {
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers }));
    const system = await buildGeminiSettings(join(root, 'tmp'), cwd, 'synthetic-context-token');
    try {
      expect(
        await adapter.checkEffectiveConfig(
          check({ adapterEnv: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: system!.path } })
        )
      ).toContain('other than Inkwell');
    } finally {
      await system?.cleanup();
    }
  });
});
