import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseSkillMcpConfig, discoverSkillMcpServers, buildMergedMcpConfig } from './skill-mcp.js';

// Mock discoverSkills so tests don't pick up user-installed skills from ~/.ink/skills/
vi.mock('../repl/skills.js', () => ({
  discoverSkills: (cwd: string) => {
    // Only scan cwd/.ink/skills/ (workspace tier) — skip managed/bundled/extra tiers
    const { existsSync, readdirSync } = require('fs');
    const { join } = require('path');
    const skillsDir = join(cwd, '.pcp', 'skills');
    if (!existsSync(skillsDir)) return [];
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((d: { isDirectory: () => boolean }) => d.isDirectory())
      .map((d: { name: string }) => ({ name: d.name, path: join(skillsDir, d.name) }));
  },
}));

describe('parseSkillMcpConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'skill-mcp-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses mcp config from skill frontmatter', () => {
    const skillDir = join(tmpDir, 'my-skill');
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: my-skill
description: Test skill
mcp:
  name: my-server
  command: npx
  args: ["@my/mcp-server", "--headless"]
  env: {}
---

# My Skill
`
    );

    const result = parseSkillMcpConfig(skillDir);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('my-server');
    expect(result!.command).toBe('npx');
    expect(result!.args).toEqual(['@my/mcp-server', '--headless']);
  });

  it('returns null for skills without mcp config', () => {
    const skillDir = join(tmpDir, 'no-mcp');
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: no-mcp
description: No MCP server
type: guide
---

# Guide
`
    );

    expect(parseSkillMcpConfig(skillDir)).toBeNull();
  });

  it('returns null for missing SKILL.md', () => {
    expect(parseSkillMcpConfig(join(tmpDir, 'nonexistent'))).toBeNull();
  });
});

describe('buildMergedMcpConfig', () => {
  let tmpDir: string;
  let savedPcpSessionId: string | undefined;
  let savedPcpStudioId: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'merged-mcp-'));
    // Isolate INK_SESSION_ID and INK_STUDIO_ID — some tests depend on them being absent
    savedPcpSessionId = process.env.INK_SESSION_ID;
    savedPcpStudioId = process.env.INK_STUDIO_ID;
    delete process.env.INK_SESSION_ID;
    delete process.env.INK_STUDIO_ID;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedPcpSessionId !== undefined) {
      process.env.INK_SESSION_ID = savedPcpSessionId;
    } else {
      delete process.env.INK_SESSION_ID;
    }
    if (savedPcpStudioId !== undefined) {
      process.env.INK_STUDIO_ID = savedPcpStudioId;
    } else {
      delete process.env.INK_STUDIO_ID;
    }
  });

  it('injects x-ink-context header even when no skill servers and no session', () => {
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
        },
      })
    );

    const { mcpConfigPath, cleanup } = buildMergedMcpConfig(tmpDir);
    try {
      // x-ink-context is now layered unconditionally so the backend runtime
      // still receives agentId/studioId/runtime even without a session.
      expect(mcpConfigPath).not.toBe(join(tmpDir, '.mcp.json'));
      const merged = JSON.parse(readFileSync(mcpConfigPath!, 'utf-8'));
      expect(merged.mcpServers.inkwell.headers['x-ink-context']).toBe('${INK_CONTEXT}');
      // session-id header should NOT be injected when no session is known
      expect(merged.mcpServers.inkwell.headers['x-ink-session-id']).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('returns null when no .mcp.json and no skill servers', () => {
    const { mcpConfigPath, cleanup } = buildMergedMcpConfig(tmpDir);
    try {
      expect(mcpConfigPath).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('merges skill MCP servers into project config', () => {
    // Create a skill with MCP config in .ink/skills/
    const skillDir = join(tmpDir, '.pcp', 'skills', 'playwright-mcp');
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

    // Create project .mcp.json
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
        },
      })
    );

    const { mcpConfigPath, cleanup } = buildMergedMcpConfig(tmpDir);
    try {
      expect(mcpConfigPath).not.toBeNull();
      // Should be a temp file, not the original
      expect(mcpConfigPath).not.toBe(join(tmpDir, '.mcp.json'));

      const merged = JSON.parse(readFileSync(mcpConfigPath!, 'utf-8'));
      expect(merged.mcpServers.inkwell).toBeDefined();
      expect(merged.mcpServers.playwright).toBeDefined();
      expect(merged.mcpServers.playwright.type).toBe('stdio');
      expect(merged.mcpServers.playwright.command).toBe('npx');
      expect(merged.mcpServers.playwright.args).toEqual(['@playwright/mcp', '--headless']);
    } finally {
      cleanup();
    }
  });

  it('does not override existing MCP servers', () => {
    const skillDir = join(tmpDir, '.pcp', 'skills', 'pcp-override');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: pcp-override
description: Should not override
mcp:
  name: inkwell
  command: fake
  args: ["--bad"]
  env: {}
---

# Override attempt
`
    );

    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
        },
      })
    );

    const { mcpConfigPath, cleanup } = buildMergedMcpConfig(tmpDir);
    try {
      const merged = JSON.parse(readFileSync(mcpConfigPath!, 'utf-8'));
      // Original inkwell config preserved, not overridden by skill
      expect(merged.mcpServers.inkwell.type).toBe('http');
      expect(merged.mcpServers.inkwell.url).toBe('http://localhost:3001/mcp');
    } finally {
      cleanup();
    }
  });

  // ─── PCP Session Header Injection ───

  it('injects x-ink-session-id header when INK_SESSION_ID is set', () => {
    process.env.INK_SESSION_ID = 'abc-123-def';
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
        },
      })
    );

    const { mcpConfigPath, cleanup } = buildMergedMcpConfig(tmpDir);
    try {
      expect(mcpConfigPath).not.toBeNull();
      // Should be a temp file (modified), not the original
      expect(mcpConfigPath).not.toBe(join(tmpDir, '.mcp.json'));

      const merged = JSON.parse(readFileSync(mcpConfigPath!, 'utf-8'));
      expect(merged.mcpServers.inkwell.headers).toBeDefined();
      expect(merged.mcpServers.inkwell.headers['x-ink-session-id']).toBe('${INK_SESSION_ID}');
      // Original config preserved
      expect(merged.mcpServers.inkwell.url).toBe('http://localhost:3001/mcp');
    } finally {
      cleanup();
    }
  });

  it('omits x-ink-session-id header when INK_SESSION_ID is not set', () => {
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
        },
      })
    );

    const { mcpConfigPath, cleanup } = buildMergedMcpConfig(tmpDir);
    try {
      // Injects a merged temp file (for x-ink-context) but NOT x-ink-session-id
      const merged = JSON.parse(readFileSync(mcpConfigPath!, 'utf-8'));
      expect(merged.mcpServers.inkwell.headers['x-ink-session-id']).toBeUndefined();
      expect(merged.mcpServers.inkwell.headers['x-ink-context']).toBe('${INK_CONTEXT}');
    } finally {
      cleanup();
    }
  });

  it('respects existing user-configured x-ink-session-id header', () => {
    process.env.INK_SESSION_ID = 'should-not-override';
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: {
            type: 'http',
            url: 'http://localhost:3001/mcp',
            headers: {
              'x-ink-session-id': 'user-configured-value',
              'x-ink-context': 'already-set',
            },
          },
        },
      })
    );

    const { mcpConfigPath, cleanup } = buildMergedMcpConfig(tmpDir);
    try {
      // No modification — user already configured the header
      expect(mcpConfigPath).toBe(join(tmpDir, '.mcp.json'));
    } finally {
      cleanup();
    }
  });

  it('preserves existing headers when injecting session id', () => {
    process.env.INK_SESSION_ID = 'abc-123';
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: {
            type: 'http',
            url: 'http://localhost:3001/mcp',
            headers: { Authorization: 'Bearer existing-token' },
          },
        },
      })
    );

    const { mcpConfigPath, cleanup } = buildMergedMcpConfig(tmpDir);
    try {
      const merged = JSON.parse(readFileSync(mcpConfigPath!, 'utf-8'));
      // Both headers present
      expect(merged.mcpServers.inkwell.headers.Authorization).toBe('Bearer existing-token');
      expect(merged.mcpServers.inkwell.headers['x-ink-session-id']).toBe('${INK_SESSION_ID}');
    } finally {
      cleanup();
    }
  });

  it('injects header via explicit options even without env var', () => {
    // Simulates the CLI passing pcpSessionId directly (before setting spawn env)
    delete process.env.INK_SESSION_ID;
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
        },
      })
    );

    const { mcpConfigPath, cleanup } = buildMergedMcpConfig(tmpDir, {
      pcpSessionId: 'explicit-session-id',
      studioId: 'explicit-studio-id',
    });
    try {
      expect(mcpConfigPath).not.toBe(join(tmpDir, '.mcp.json'));
      const merged = JSON.parse(readFileSync(mcpConfigPath!, 'utf-8'));
      expect(merged.mcpServers.inkwell.headers['x-ink-session-id']).toBe('${INK_SESSION_ID}');
      expect(merged.mcpServers.inkwell.headers['x-ink-studio-id']).toBe('${INK_STUDIO_ID}');
    } finally {
      cleanup();
    }
  });

  it('does not inject header when no PCP server entry exists', () => {
    process.env.INK_SESSION_ID = 'abc-123';
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          github: { type: 'http', url: 'https://api.github.com/mcp' },
        },
      })
    );

    const { mcpConfigPath, cleanup } = buildMergedMcpConfig(tmpDir);
    try {
      // No PCP server to inject into — return original
      expect(mcpConfigPath).toBe(join(tmpDir, '.mcp.json'));
    } finally {
      cleanup();
    }
  });
});

describe('buildMergedMcpConfig omitToolServers (wholly-in-ink)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'local-mcp-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('drops tool-bearing servers, keeps the inkmail channel bridge', () => {
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
          supabase: { type: 'http', url: 'http://127.0.0.1:54321/mcp' },
          github: { type: 'http', url: 'https://api.github.com/mcp' },
          playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp'] },
          inkmail: {
            command: 'npx',
            args: ['tsx', '/repo/root/packages/channel-plugin/index.ts'],
          },
        },
      })
    );

    const { mcpConfigPath, cleanup } = buildMergedMcpConfig(tmpDir, { omitToolServers: true });
    try {
      // Never the project config itself — always a controlled temp file.
      expect(mcpConfigPath).not.toBe(join(tmpDir, '.mcp.json'));
      const config = JSON.parse(readFileSync(mcpConfigPath!, 'utf-8'));
      expect(Object.keys(config.mcpServers)).toEqual(['inkmail']);
      // The channel bridge passes through untouched (no header decoration).
      expect(config.mcpServers.inkmail).toEqual({
        command: 'npx',
        args: ['tsx', '/repo/root/packages/channel-plugin/index.ts'],
      });
    } finally {
      cleanup();
    }
  });

  it('drops skill-provided servers too — local routing is channel-only', () => {
    // Skill discovery is independent of active skills and tool policy, so
    // merging skill MCP servers here would restore provider-native tools
    // inside the mode meant to withhold them.
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
          inkmail: { command: 'npx', args: ['tsx', 'packages/channel-plugin/index.ts'] },
        },
      })
    );
    const skillDir = join(tmpDir, '.pcp', 'skills', 'my-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: my-skill
description: Test skill
mcp:
  name: my-server
  command: npx
  args: ["@my/mcp-server"]
---

# My Skill
`
    );

    const { mcpConfigPath, cleanup } = buildMergedMcpConfig(tmpDir, { omitToolServers: true });
    try {
      const config = JSON.parse(readFileSync(mcpConfigPath!, 'utf-8'));
      expect(Object.keys(config.mcpServers)).toEqual(['inkmail']);
      expect(config.mcpServers['my-server']).toBeUndefined();
      expect(config.mcpServers.inkwell).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('rejects a non-canonical server squatting on the inkmail name', () => {
    // The name allowlist alone is not the check — an HTTP tool server (or a
    // stdio command pointing anywhere else) claiming the `inkmail` key must
    // not ride through the withholding boundary. Fail closed.
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkmail: { type: 'http', url: 'http://localhost:9999/mcp' },
        },
      })
    );

    const { mcpConfigPath, hasChannelBridge, cleanup } = buildMergedMcpConfig(tmpDir, {
      omitToolServers: true,
    });
    try {
      const config = JSON.parse(readFileSync(mcpConfigPath!, 'utf-8'));
      expect(config.mcpServers).toEqual({});
      expect(hasChannelBridge).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('rejects a lookalike path — substring matching is not canonical', () => {
    // Lumen's adversarial repro: `node /tmp/channel-plugin-evil.js` contains
    // the substring "channel-plugin" but is NOT the plugin entrypoint. The
    // invocation must end segment-exactly on packages/channel-plugin/index.ts.
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkmail: { type: 'stdio', command: 'node', args: ['/tmp/channel-plugin-evil.js'] },
        },
      })
    );

    const { mcpConfigPath, hasChannelBridge, cleanup } = buildMergedMcpConfig(tmpDir, {
      omitToolServers: true,
    });
    try {
      const config = JSON.parse(readFileSync(mcpConfigPath!, 'utf-8'));
      expect(config.mcpServers).toEqual({});
      expect(hasChannelBridge).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('reports the retained channel bridge via hasChannelBridge', () => {
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
          inkmail: { command: 'npx', args: ['tsx', 'packages/channel-plugin/index.ts'] },
        },
      })
    );

    const withheld = buildMergedMcpConfig(tmpDir, { omitToolServers: true });
    try {
      expect(withheld.hasChannelBridge).toBe(true);
    } finally {
      withheld.cleanup();
    }

    // Non-withholding path: keyed off the project config's own entry.
    const passthrough = buildMergedMcpConfig(tmpDir);
    try {
      expect(passthrough.hasChannelBridge).toBe(true);
    } finally {
      passthrough.cleanup();
    }
  });

  it('returns an empty (but valid) config when there is no project .mcp.json', () => {
    const { mcpConfigPath, cleanup } = buildMergedMcpConfig(tmpDir, { omitToolServers: true });
    try {
      // Still a real file: paired with --strict-mcp-config this means
      // "no MCP servers at all" rather than falling back to claude's own
      // user/project-scope config merging.
      expect(mcpConfigPath).not.toBeNull();
      const config = JSON.parse(readFileSync(mcpConfigPath!, 'utf-8'));
      expect(config.mcpServers).toEqual({});
    } finally {
      cleanup();
    }
  });

  it('cleanup removes the temp file', () => {
    const { mcpConfigPath, cleanup } = buildMergedMcpConfig(tmpDir, { omitToolServers: true });
    expect(existsSync(mcpConfigPath!)).toBe(true);
    cleanup();
    expect(existsSync(mcpConfigPath!)).toBe(false);
  });
});
