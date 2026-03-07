import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseSkillMcpConfig, discoverSkillMcpServers, buildMergedMcpConfig } from './skill-mcp.js';

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

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'merged-mcp-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
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
});
