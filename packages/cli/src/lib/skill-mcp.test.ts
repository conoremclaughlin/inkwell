import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseSkillMcpConfig, discoverSkillMcpServers, buildMergedMcpConfig } from './skill-mcp.js';

// Mock discoverSkills so tests don't pick up user-installed skills from ~/.pcp/skills/
vi.mock('../repl/skills.js', () => ({
  discoverSkills: (cwd: string) => {
    // Only scan cwd/.pcp/skills/ (workspace tier) — skip managed/bundled/extra tiers
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
    // Isolate PCP_SESSION_ID and PCP_STUDIO_ID — some tests depend on them being absent
    savedPcpSessionId = process.env.PCP_SESSION_ID;
    savedPcpStudioId = process.env.PCP_STUDIO_ID;
    delete process.env.PCP_SESSION_ID;
    delete process.env.PCP_STUDIO_ID;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedPcpSessionId !== undefined) {
      process.env.PCP_SESSION_ID = savedPcpSessionId;
    } else {
      delete process.env.PCP_SESSION_ID;
    }
    if (savedPcpStudioId !== undefined) {
      process.env.PCP_STUDIO_ID = savedPcpStudioId;
    } else {
      delete process.env.PCP_STUDIO_ID;
    }
  });

  it('returns project .mcp.json when no skill servers exist', () => {
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          pcp: { type: 'http', url: 'http://localhost:3001/mcp' },
        },
      })
    );

    const { mcpConfigPath, cleanup } = buildMergedMcpConfig(tmpDir);
    try {
      // Returns original path, not a temp file
      expect(mcpConfigPath).toBe(join(tmpDir, '.mcp.json'));
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
    // Create a skill with MCP config in .pcp/skills/
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
          pcp: { type: 'http', url: 'http://localhost:3001/mcp' },
        },
      })
    );

    const { mcpConfigPath, cleanup } = buildMergedMcpConfig(tmpDir);
    try {
      expect(mcpConfigPath).not.toBeNull();
      // Should be a temp file, not the original
      expect(mcpConfigPath).not.toBe(join(tmpDir, '.mcp.json'));

      const merged = JSON.parse(readFileSync(mcpConfigPath!, 'utf-8'));
      expect(merged.mcpServers.pcp).toBeDefined();
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
  name: pcp
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
          pcp: { type: 'http', url: 'http://localhost:3001/mcp' },
        },
      })
    );

    const { mcpConfigPath, cleanup } = buildMergedMcpConfig(tmpDir);
    try {
      const merged = JSON.parse(readFileSync(mcpConfigPath!, 'utf-8'));
      // Original pcp config preserved, not overridden by skill
      expect(merged.mcpServers.pcp.type).toBe('http');
      expect(merged.mcpServers.pcp.url).toBe('http://localhost:3001/mcp');
    } finally {
      cleanup();
    }
  });

  // ─── PCP Session Header Injection ───

  it('injects x-pcp-session-id header when PCP_SESSION_ID is set', () => {
    process.env.PCP_SESSION_ID = 'abc-123-def';
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          pcp: { type: 'http', url: 'http://localhost:3001/mcp' },
        },
      })
    );

    const { mcpConfigPath, cleanup } = buildMergedMcpConfig(tmpDir);
    try {
      expect(mcpConfigPath).not.toBeNull();
      // Should be a temp file (modified), not the original
      expect(mcpConfigPath).not.toBe(join(tmpDir, '.mcp.json'));

      const merged = JSON.parse(readFileSync(mcpConfigPath!, 'utf-8'));
      expect(merged.mcpServers.pcp.headers).toBeDefined();
      expect(merged.mcpServers.pcp.headers['x-pcp-session-id']).toBe('${PCP_SESSION_ID}');
      // Original config preserved
      expect(merged.mcpServers.pcp.url).toBe('http://localhost:3001/mcp');
    } finally {
      cleanup();
    }
  });

  it('does not inject header when PCP_SESSION_ID is not set', () => {
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          pcp: { type: 'http', url: 'http://localhost:3001/mcp' },
        },
      })
    );

    const { mcpConfigPath, cleanup } = buildMergedMcpConfig(tmpDir);
    try {
      // Returns original — no modifications
      expect(mcpConfigPath).toBe(join(tmpDir, '.mcp.json'));
    } finally {
      cleanup();
    }
  });

  it('respects existing user-configured x-pcp-session-id header', () => {
    process.env.PCP_SESSION_ID = 'should-not-override';
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          pcp: {
            type: 'http',
            url: 'http://localhost:3001/mcp',
            headers: { 'x-pcp-session-id': 'user-configured-value' },
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
    process.env.PCP_SESSION_ID = 'abc-123';
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          pcp: {
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
      expect(merged.mcpServers.pcp.headers.Authorization).toBe('Bearer existing-token');
      expect(merged.mcpServers.pcp.headers['x-pcp-session-id']).toBe('${PCP_SESSION_ID}');
    } finally {
      cleanup();
    }
  });

  it('injects header via explicit options even without env var', () => {
    // Simulates the CLI passing pcpSessionId directly (before setting spawn env)
    delete process.env.PCP_SESSION_ID;
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          pcp: { type: 'http', url: 'http://localhost:3001/mcp' },
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
      expect(merged.mcpServers.pcp.headers['x-pcp-session-id']).toBe('${PCP_SESSION_ID}');
      expect(merged.mcpServers.pcp.headers['x-pcp-studio-id']).toBe('${PCP_STUDIO_ID}');
    } finally {
      cleanup();
    }
  });

  it('does not inject header when no PCP server entry exists', () => {
    process.env.PCP_SESSION_ID = 'abc-123';
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
