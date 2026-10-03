import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  PLAYWRIGHT_ATTACH_ENV,
  PLAYWRIGHT_ATTACH_FLAGS,
  PLAYWRIGHT_MCP_DEFAULT_ARGS,
  isPlaywrightMcpServer,
  pinIsolatedPlaywright,
  playwrightBrowserAttachments,
} from './playwright-mcp.js';
import { syncMcpConfig } from './mcp-config-sync.js';
import { injectSessionHeaders } from '../runner/mcp-config.js';

/** The entry every studio's `.mcp.json` carries today, copied from the main worktree. */
const STUDIO_ENTRY_BEFORE = {
  type: 'stdio',
  command: 'npx',
  args: ['@playwright/mcp', '--headless'],
};

/** An explicit opt-in to a person's own browser, which no producer may change. */
const ATTACHED_ENTRY = {
  type: 'stdio',
  command: 'npx',
  args: ['@playwright/mcp', '--extension'],
};

/** The default launch: headless, isolated, and pointed at no browser of anyone's. */
function expectDefaultLaunch(entry: {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}) {
  expect(isPlaywrightMcpServer(entry)).toBe(true);
  expect(entry.args).toContain('--headless');
  expect(entry.args).toContain('--isolated');
  expect(playwrightBrowserAttachments(entry)).toEqual([]);
}

describe('isPlaywrightMcpServer', () => {
  it('recognises the npx package, a version tag, and the package binary', () => {
    expect(isPlaywrightMcpServer({ command: 'npx', args: ['@playwright/mcp'] })).toBe(true);
    expect(isPlaywrightMcpServer({ command: 'npx', args: ['-y', '@playwright/mcp@latest'] })).toBe(
      true
    );
    expect(isPlaywrightMcpServer({ command: '/usr/local/bin/playwright-mcp', args: [] })).toBe(
      true
    );
  });

  it('does not claim other servers', () => {
    expect(isPlaywrightMcpServer({ command: 'npx', args: ['tsx', 'index.ts'] })).toBe(false);
    expect(isPlaywrightMcpServer({ command: 'npx', args: ['@playwright/mcp-extra'] })).toBe(false);
    expect(isPlaywrightMcpServer(undefined)).toBe(false);
  });
});

describe('playwrightBrowserAttachments', () => {
  it('is empty for the default launch', () => {
    expect(
      playwrightBrowserAttachments({ command: 'npx', args: [...PLAYWRIGHT_MCP_DEFAULT_ARGS] })
    ).toEqual([]);
  });

  it.each(PLAYWRIGHT_ATTACH_FLAGS.map((flag) => [flag]))('names %s, bare or with =', (flag) => {
    expect(playwrightBrowserAttachments({ args: ['@playwright/mcp', flag, 'x'] })).toEqual([flag]);
    expect(playwrightBrowserAttachments({ args: ['@playwright/mcp', `${flag}=x`] })).toEqual([
      flag,
    ]);
  });

  it.each(PLAYWRIGHT_ATTACH_ENV.map((name) => [name]))('names the environment form %s', (name) => {
    expect(
      playwrightBrowserAttachments({ args: ['@playwright/mcp'], env: { [name]: '1' } })
    ).toEqual([name]);
  });

  it.each([
    ['/Users/someone/Library/Application Support/Google/Chrome/Default'],
    ['/Users/someone/Library/Application Support/Dia/User Data'],
    ['/Users/someone/Library/Application Support/Chromium'],
    ['/home/someone/.config/google-chrome/Profile 1'],
  ])('names a browser profile path (%s) in an argument or an env value', (path) => {
    expect(playwrightBrowserAttachments({ args: ['@playwright/mcp', `--config=${path}`] })).toEqual(
      ['browser profile path']
    );
    expect(playwrightBrowserAttachments({ args: ['@playwright/mcp'], env: { X: path } })).toEqual([
      'browser profile path',
    ]);
  });
});

describe('pinIsolatedPlaywright', () => {
  it("appends the missing flags to today's studio entry, after the arguments already there", () => {
    const { servers, pinned, attached } = pinIsolatedPlaywright({
      playwright: STUDIO_ENTRY_BEFORE,
    });
    expect(servers.playwright.args).toEqual(['@playwright/mcp', '--headless', '--isolated']);
    expect(pinned).toEqual(['playwright']);
    expect(attached).toEqual([]);
  });

  it('adds both flags to a bare launch, under any server name', () => {
    const { servers, pinned } = pinIsolatedPlaywright({
      browser: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    });
    expect(servers.browser.args).toEqual([
      '-y',
      '@playwright/mcp@latest',
      '--headless',
      '--isolated',
    ]);
    expect(pinned).toEqual(['browser']);
  });

  it('leaves an entry already pinned as it is, and does not report it', () => {
    const entry = { command: 'npx', args: [...PLAYWRIGHT_MCP_DEFAULT_ARGS] };
    const { servers, pinned } = pinIsolatedPlaywright({ playwright: entry });
    expect(servers.playwright).toBe(entry);
    expect(pinned).toEqual([]);
  });

  it('leaves an entry that names a browser or profile exactly as written, and reports it', () => {
    const profile = {
      command: 'npx',
      args: ['@playwright/mcp', '--user-data-dir', '/tmp/profile'],
    };
    const { servers, pinned, attached } = pinIsolatedPlaywright({
      playwright: ATTACHED_ENTRY,
      other: profile,
    });
    expect(servers.playwright).toBe(ATTACHED_ENTRY);
    expect(servers.other).toBe(profile);
    expect(pinned).toEqual([]);
    expect(attached).toEqual([
      { name: 'playwright', attachments: ['--extension'] },
      { name: 'other', attachments: ['--user-data-dir'] },
    ]);
  });

  it('does not touch other servers or mutate its input', () => {
    const inkwell = { type: 'http', url: 'http://localhost:3001/mcp' };
    const input = {
      inkwell,
      playwright: { ...STUDIO_ENTRY_BEFORE, args: [...STUDIO_ENTRY_BEFORE.args] },
    };
    const { servers } = pinIsolatedPlaywright(input);
    expect(servers.inkwell).toBe(inkwell);
    expect(input.playwright.args).toEqual(['@playwright/mcp', '--headless']);
  });
});

// ============================================================================
// Every producer in this package, fed the entry studios carry today
// ============================================================================

describe('the configs this package generates launch Playwright isolated and headless', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'playwright-mcp-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeMcpJson(servers: Record<string, unknown>): string {
    const path = join(root, '.mcp.json');
    writeFileSync(path, JSON.stringify({ mcpServers: servers }));
    return path;
  }

  /** The `args` array of `[mcp_servers.<name>]` in a generated Codex config. */
  function codexArgs(name: string): string[] {
    const toml = readFileSync(join(root, '.codex', 'config.toml'), 'utf-8');
    const section = toml.split(`[mcp_servers.${name}]`)[1]?.split(/\n\[/)[0] ?? '';
    const line = section.split('\n').find((l) => l.startsWith('args = '));
    return line ? (JSON.parse(line.slice('args = '.length)) as string[]) : [];
  }

  function geminiEntry(name: string) {
    const settings = JSON.parse(readFileSync(join(root, '.gemini', 'settings.json'), 'utf-8'));
    return settings.mcpServers[name];
  }

  it('Codex: .codex/config.toml', () => {
    writeMcpJson({ playwright: STUDIO_ENTRY_BEFORE });
    expect(syncMcpConfig(root).codex).toBe(true);
    expectDefaultLaunch({ command: 'npx', args: codexArgs('playwright') });
    expect(codexArgs('playwright')).toEqual([...PLAYWRIGHT_MCP_DEFAULT_ARGS]);
  });

  it('Gemini: .gemini/settings.json', () => {
    writeMcpJson({ playwright: STUDIO_ENTRY_BEFORE });
    expect(syncMcpConfig(root).gemini).toBe(true);
    expectDefaultLaunch(geminiEntry('playwright'));
    expect(geminiEntry('playwright').args).toEqual([...PLAYWRIGHT_MCP_DEFAULT_ARGS]);
  });

  it('Codex and Gemini keep an explicit browser opt-in as written', () => {
    writeMcpJson({ playwright: ATTACHED_ENTRY });
    syncMcpConfig(root);
    expect(codexArgs('playwright')).toEqual(ATTACHED_ENTRY.args);
    expect(geminiEntry('playwright').args).toEqual(ATTACHED_ENTRY.args);
  });

  it("a server-spawned session's MCP config (injectSessionHeaders)", () => {
    const source = writeMcpJson({
      inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
      playwright: STUDIO_ENTRY_BEFORE,
    });
    const result = injectSessionHeaders({
      mcpConfigPath: source,
      inkSessionId: 'session-1',
      outputDir: join(root, 'out'),
    });
    try {
      expect(result.modified).toBe(true);
      const config = JSON.parse(readFileSync(result.mcpConfigPath, 'utf-8'));
      expectDefaultLaunch(config.mcpServers.playwright);
      expect(config.mcpServers.playwright.args).toEqual([...PLAYWRIGHT_MCP_DEFAULT_ARGS]);
      // The source file is the studio's own; the session gets a copy.
      expect(JSON.parse(readFileSync(source, 'utf-8')).mcpServers.playwright.args).toEqual(
        STUDIO_ENTRY_BEFORE.args
      );
    } finally {
      result.cleanup();
    }
  });

  it('a session config is pinned even when the file has no inkwell server to decorate', () => {
    const source = writeMcpJson({ playwright: STUDIO_ENTRY_BEFORE });
    const result = injectSessionHeaders({ mcpConfigPath: source, outputDir: join(root, 'out') });
    try {
      expect(result.modified).toBe(true);
      const config = JSON.parse(readFileSync(result.mcpConfigPath, 'utf-8'));
      expectDefaultLaunch(config.mcpServers.playwright);
    } finally {
      result.cleanup();
    }
  });

  it('a session config keeps an explicit browser opt-in as written', () => {
    const source = writeMcpJson({
      inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
      playwright: ATTACHED_ENTRY,
    });
    const result = injectSessionHeaders({
      mcpConfigPath: source,
      inkSessionId: 'session-1',
      outputDir: join(root, 'out'),
    });
    try {
      const config = JSON.parse(readFileSync(result.mcpConfigPath, 'utf-8'));
      expect(config.mcpServers.playwright.args).toEqual(ATTACHED_ENTRY.args);
    } finally {
      result.cleanup();
    }
  });
});
