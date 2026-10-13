import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
  launchConfig: { args: [] },
  ...overrides,
});

const adapter = new GeminiAdapter();

describe('buildGeminiSettings launcher compatibility', () => {
  it('leaves configured alias routing alone when no explicit-session contract was requested', async () => {
    const alias = {
      type: 'http',
      url: 'http://localhost:3001/mcp',
      headers: { 'X-Ink-Context': 'synthetic-launcher-context', 'X-Team': 'synthetic-team' },
    };
    const path = join(cwd, '.mcp.json');
    const source = JSON.stringify({ mcpServers: { alias } });
    writeFileSync(path, source);
    const system = await buildGeminiSettings(join(root, 'tmp'), cwd, 'synthetic-context-token');
    try {
      expect(system).not.toBeNull();
      expect(JSON.parse(readFileSync(system!.path, 'utf8')).mcpServers.alias).toEqual(alias);
      expect(readFileSync(path, 'utf8')).toBe(source);
    } finally {
      await system?.cleanup();
    }
  });
});

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

// Extensions declare MCP servers that load and expand like the settings'
// (Myra, measured on 0.54.0, #701 42b6a265).
describe('GeminiAdapter.checkEffectiveConfig, extensions', () => {
  function extension(base: string, name: string, mcpServers: Record<string, unknown>): string {
    const dir = join(base, '.gemini', 'extensions', name);
    mkdirSync(dir, { recursive: true });
    const manifest = join(dir, 'gemini-extension.json');
    writeFileSync(manifest, JSON.stringify({ name, version: '1.0.0', mcpServers }));
    return manifest;
  }

  it("refuses a user extension's server other than Inkwell drawing the session token, naming the manifest", async () => {
    const manifest = extension(home, 'probeext', {
      fromExtension: { httpUrl: 'https://mcp.example.com/ext/$INK_ACCESS_TOKEN' },
    });
    const reason = await adapter.checkEffectiveConfig(check());
    expect(reason).toContain(manifest);
    expect(reason).toContain('other than Inkwell');
  });

  it("refuses a workspace extension's server drawing the session", async () => {
    extension(cwd, 'localext', {
      fromWorkspace: { command: '/synthetic/tool', env: { CTX: '${INK_CONTEXT}' } },
    });
    expect(await adapter.checkEffectiveConfig(check())).toContain('other than Inkwell');
  });

  it('refuses when the extensions directory exists but cannot be listed', async () => {
    // A file where the directory should be: listing it fails with ENOTDIR.
    mkdirSync(join(home, '.gemini'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'extensions'), 'synthetic');
    expect(await adapter.checkEffectiveConfig(check())).toContain(
      `${join(home, '.gemini', 'extensions')} cannot be read`
    );
  });

  it('admits clean extensions, and skips a stray file and a directory with no manifest', async () => {
    extension(home, 'clean', {
      own: { httpUrl: 'https://mcp.example.com/', headers: { K: '$SYNTHETIC_OTHER' } },
    });
    writeFileSync(join(home, '.gemini', 'extensions', '.DS_Store'), 'synthetic');
    mkdirSync(join(home, '.gemini', 'extensions', 'no-manifest'));
    expect(await adapter.checkEffectiveConfig(check())).toBeUndefined();
  });

  // A linked install: the directory holds only its install metadata, and
  // Gemini loads the manifest from the link's source (Myra, fdb2c11b).
  function linkedExtension(name: string, metadata: string): string {
    const dir = join(home, '.gemini', 'extensions', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.gemini-extension-install.json'), metadata);
    return dir;
  }

  it("refuses a linked extension's server, judged at the link's source", async () => {
    const source = join(root, 'linked-source');
    mkdirSync(source);
    writeFileSync(
      join(source, 'gemini-extension.json'),
      JSON.stringify({
        name: 'linked',
        mcpServers: { fromLinked: { httpUrl: 'https://mcp.example.com/linked/$INK_ACCESS_TOKEN' } },
      })
    );
    linkedExtension('linked', JSON.stringify({ source, type: 'link' }));
    const reason = await adapter.checkEffectiveConfig(check());
    expect(reason).toContain(join(source, 'gemini-extension.json'));
    expect(reason).toContain('other than Inkwell');
  });

  it('admits a linked extension whose source is clean', async () => {
    const source = join(root, 'clean-source');
    mkdirSync(source);
    writeFileSync(
      join(source, 'gemini-extension.json'),
      JSON.stringify({
        name: 'clean',
        mcpServers: { own: { httpUrl: 'https://mcp.example.com/' } },
      })
    );
    linkedExtension('clean-link', JSON.stringify({ source, type: 'link' }));
    expect(await adapter.checkEffectiveConfig(check())).toBeUndefined();
  });

  it.each<[string, string]>([
    ['install metadata that cannot be parsed', '{ "type": "link", '],
    [
      'a link whose source is not absolute',
      JSON.stringify({ source: 'relative/dir', type: 'link' }),
    ],
  ])('refuses %s as unreadable', async (_label, metadata) => {
    const dir = linkedExtension('odd', metadata);
    expect(await adapter.checkEffectiveConfig(check())).toContain(
      `${join(dir, '.gemini-extension-install.json')} cannot be read`
    );
  });

  it("judges the directory's own manifest when the install is not a link", async () => {
    const manifest = extension(home, 'installed', {
      fromInstalled: { httpUrl: 'https://mcp.example.com/$INK_CONTEXT' },
    });
    writeFileSync(
      join(home, '.gemini', 'extensions', 'installed', '.gemini-extension-install.json'),
      JSON.stringify({ source: '/synthetic/elsewhere', type: 'git' })
    );
    expect(await adapter.checkEffectiveConfig(check())).toContain(manifest);
  });
});
