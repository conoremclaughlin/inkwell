/**
 * Every Playwright MCP config the CLI produces launches the server headless
 * and isolated, and never names a browser or profile of anyone's (task
 * cd2fe361; the rationale is in @inklabs/shared studio/playwright-mcp.ts).
 *
 * Each producer is fed what it meets today: the bundled skill as the
 * template, a studio `.mcp.json` copied from the main worktree with
 * `['@playwright/mcp', '--headless']`, and skill copies synced before the
 * pin. If any producer gains `--extension`, `--user-data-dir`,
 * `--cdp-endpoint` or a Chrome or Dia profile path, `expectDefaultLaunch`
 * fails. An explicit opt-in already in a file is kept as written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  PLAYWRIGHT_MCP_DEFAULT_ARGS,
  isPlaywrightMcpServer,
  playwrightBrowserAttachments,
} from '@inklabs/shared';
import { buildMergedMcpConfig, parseSkillMcpConfig, discoverSkillMcpServers } from './skill-mcp.js';
import { completeStudio, type StepResult } from './studio-complete.js';
import { injectMcpServers } from '../commands/skills.js';
import { buildGeminiSettings } from '../backends/gemini.js';

// The CLI's own Inkwell checkout is the last inkmail plugin candidate (task
// 5cabaeeb); none here, so a tmp repo resolves only what a test put on disk.
vi.mock('./ink-checkout.js', () => ({ inkCliMainWorktree: () => null }));

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLED_SKILL = join(
  here,
  '..',
  '..',
  '..',
  'api',
  'src',
  'skills',
  'builtin',
  'playwright-mcp'
);

const STUDIO_ENTRY_BEFORE = {
  type: 'stdio',
  command: 'npx',
  args: ['@playwright/mcp', '--headless'],
};
const ATTACHED_ENTRY = {
  type: 'stdio',
  command: 'npx',
  args: ['@playwright/mcp', '--cdp-endpoint', 'http://127.0.0.1:9222'],
};

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

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf-8'));

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'playwright-producers-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the bundled playwright-mcp skill (the template every sync copies)', () => {
  it('launches the default: npx @playwright/mcp --headless --isolated', async () => {
    const mcp = parseSkillMcpConfig(BUNDLED_SKILL);
    expect(mcp).not.toBeNull();
    expect(mcp!.name).toBe('playwright');
    expectDefaultLaunch(mcp!);
    expect(mcp!.args).toEqual([...PLAYWRIGHT_MCP_DEFAULT_ARGS]);
  });
});

describe('buildMergedMcpConfig (sessions the CLI launches)', () => {
  it("pins the studio's own Playwright entry", async () => {
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
          playwright: STUDIO_ENTRY_BEFORE,
        },
      })
    );
    const { mcpConfigPath, cleanup } = await buildMergedMcpConfig(root, {
      inkSessionId: 's-1',
      tempDir: root,
      skillServers: discoverSkillMcpServers(root),
    });
    try {
      expectDefaultLaunch(readJson(mcpConfigPath!).mcpServers.playwright);
      expect(readJson(join(root, '.mcp.json')).mcpServers.playwright.args).toEqual(
        STUDIO_ENTRY_BEFORE.args
      );
    } finally {
      await cleanup();
    }
  });

  it('pins a Playwright server merged from a skill copy synced before the pin', async () => {
    const skillDir = join(root, '.ink', 'skills', 'playwright-mcp');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: playwright-mcp
description: Browser automation
mcp:
  name: playwright
  command: npx
  args: ["@playwright/mcp", "--headless"]
  env: {}
---

# Playwright
`
    );
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: { inkwell: { type: 'http', url: 'http://localhost:3001/mcp' } },
      })
    );
    const { mcpConfigPath, cleanup } = await buildMergedMcpConfig(root, {
      tempDir: root,
      skillServers: discoverSkillMcpServers(root),
    });
    try {
      expectDefaultLaunch(readJson(mcpConfigPath!).mcpServers.playwright);
    } finally {
      await cleanup();
    }
  });

  it('keeps an explicit browser opt-in as written', async () => {
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
          playwright: ATTACHED_ENTRY,
        },
      })
    );
    const { mcpConfigPath, cleanup } = await buildMergedMcpConfig(root, {
      inkSessionId: 's-1',
      tempDir: root,
      skillServers: discoverSkillMcpServers(root),
    });
    try {
      expect(readJson(mcpConfigPath!).mcpServers.playwright.args).toEqual(ATTACHED_ENTRY.args);
    } finally {
      await cleanup();
    }
  });
});

describe('ink gemini (the settings file the CLI hands Gemini)', () => {
  it("pins the studio's Playwright entry", async () => {
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { playwright: STUDIO_ENTRY_BEFORE } })
    );
    const settings = await buildGeminiSettings(root, root, 'context-token');
    try {
      expect(settings).not.toBeNull();
      expectDefaultLaunch(readJson(settings!.path).mcpServers.playwright);
    } finally {
      await settings?.cleanup();
    }
  });
});

describe('ink skills sync (writes a missing server into .mcp.json)', () => {
  it('writes the Playwright server pinned, even from a skill served with the old arguments', async () => {
    const mcpPath = join(root, '.mcp.json');
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }));
    const { added } = injectMcpServers(mcpPath, [
      {
        name: 'playwright-mcp',
        type: 'cli',
        description: 'Playwright MCP',
        mcp: {
          name: 'playwright',
          command: 'npx',
          args: ['@playwright/mcp', '--headless'],
          env: {},
        },
      },
    ]);
    expect(added).toEqual(['playwright']);
    expectDefaultLaunch(readJson(mcpPath).mcpServers.playwright);
  });

  it('leaves an existing entry alone, as it always has', async () => {
    const mcpPath = join(root, '.mcp.json');
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { playwright: STUDIO_ENTRY_BEFORE } }));
    const { existed } = injectMcpServers(mcpPath, [
      {
        name: 'playwright-mcp',
        type: 'cli',
        description: 'Playwright MCP',
        mcp: {
          name: 'playwright',
          command: 'npx',
          args: [...PLAYWRIGHT_MCP_DEFAULT_ARGS],
          env: {},
        },
      },
    ]);
    expect(existed).toEqual(['playwright']);
    expect(readJson(mcpPath).mcpServers.playwright.args).toEqual(STUDIO_ENTRY_BEFORE.args);
  });
});

describe('completeStudio root sync (a new studio copies the main worktree .mcp.json)', () => {
  const stubs = () => ({
    sbSlug: 'wren',
    permissionProfile: 'builder' as const,
    studioName: 'alpha',
    register: vi.fn(async () => '191b7705-85bd-4c76-b622-43f655bf7fd6'),
    syncSkills: vi.fn(
      async (): Promise<StepResult> => ({
        label: 'skills sync',
        status: 'skipped',
        detail: 'stubbed',
      })
    ),
  });

  function seed(mainEntry: object) {
    const main = join(root, 'repo');
    const studio = join(root, 'repo--alpha');
    mkdirSync(main);
    mkdirSync(studio);
    writeFileSync(
      join(main, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
          playwright: mainEntry,
        },
      })
    );
    return { main, studio };
  }

  it("pins the studio's fresh copy, every backend's config with it, and leaves the main worktree's file alone", async () => {
    const { main, studio } = seed(STUDIO_ENTRY_BEFORE);
    await completeStudio(studio, { ...stubs(), mainRoot: main });
    expectDefaultLaunch(readJson(join(studio, '.mcp.json')).mcpServers.playwright);
    expectDefaultLaunch(readJson(join(studio, '.gemini', 'settings.json')).mcpServers.playwright);
    expect(readFileSync(join(studio, '.codex', 'config.toml'), 'utf-8')).toContain(
      'args = ["@playwright/mcp", "--headless", "--isolated"]'
    );
    expect(readJson(join(main, '.mcp.json')).mcpServers.playwright.args).toEqual(
      STUDIO_ENTRY_BEFORE.args
    );
  });

  it("does not rewrite a studio's existing .mcp.json, even when the same run copies another file", async () => {
    const { main, studio } = seed(STUDIO_ENTRY_BEFORE);
    // Root sync copies .env.local in this run, so the pin is reached and
    // must still leave the studio's own .mcp.json alone.
    writeFileSync(join(main, '.env.local'), 'EXAMPLE=1\n');
    const existing = {
      mcpServers: {
        inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
        playwright: STUDIO_ENTRY_BEFORE,
      },
    };
    writeFileSync(join(studio, '.mcp.json'), JSON.stringify(existing));
    await completeStudio(studio, { ...stubs(), mainRoot: main });
    expect(readJson(join(studio, '.mcp.json'))).toEqual(existing);
  });

  it('copies an explicit browser opt-in as written', async () => {
    const { main, studio } = seed(ATTACHED_ENTRY);
    await completeStudio(studio, { ...stubs(), mainRoot: main });
    expect(readJson(join(studio, '.mcp.json')).mcpServers.playwright.args).toEqual(
      ATTACHED_ENTRY.args
    );
  });
});
