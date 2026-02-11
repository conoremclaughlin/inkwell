/**
 * MCP Config Sync Tests
 *
 * Tests for syncMcpConfig extraction and functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { syncMcpConfig } from './mcp.js';

const TEST_DIR = join(tmpdir(), 'pcp-mcp-test-' + Date.now());

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe('syncMcpConfig', () => {
  it('should return false when no .mcp.json exists', () => {
    const result = syncMcpConfig(TEST_DIR);
    expect(result.codex).toBe(false);
    expect(result.gemini).toBe(false);
  });

  it('should return false when .mcp.json has no servers', () => {
    writeFileSync(join(TEST_DIR, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
    const result = syncMcpConfig(TEST_DIR);
    expect(result.codex).toBe(false);
    expect(result.gemini).toBe(false);
  });

  it('should return false for invalid JSON', () => {
    writeFileSync(join(TEST_DIR, '.mcp.json'), 'not json');
    const result = syncMcpConfig(TEST_DIR);
    expect(result.codex).toBe(false);
    expect(result.gemini).toBe(false);
  });

  it('should create .codex/config.toml from .mcp.json', () => {
    writeFileSync(join(TEST_DIR, '.mcp.json'), JSON.stringify({
      mcpServers: {
        pcp: {
          type: 'http',
          url: 'http://localhost:3001/mcp',
        },
      },
    }));

    const result = syncMcpConfig(TEST_DIR);

    expect(result.codex).toBe(true);
    expect(existsSync(join(TEST_DIR, '.codex', 'config.toml'))).toBe(true);

    const toml = readFileSync(join(TEST_DIR, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toContain('[mcp_servers.pcp]');
    expect(toml).toContain('url = "http://localhost:3001/mcp"');
  });

  it('should create .gemini/settings.json from .mcp.json', () => {
    writeFileSync(join(TEST_DIR, '.mcp.json'), JSON.stringify({
      mcpServers: {
        pcp: {
          type: 'http',
          url: 'http://localhost:3001/mcp',
        },
      },
    }));

    const result = syncMcpConfig(TEST_DIR);

    expect(result.gemini).toBe(true);
    expect(existsSync(join(TEST_DIR, '.gemini', 'settings.json'))).toBe(true);

    const settings = JSON.parse(readFileSync(join(TEST_DIR, '.gemini', 'settings.json'), 'utf-8'));
    expect(settings.mcpServers.pcp).toBeDefined();
    expect(settings.mcpServers.pcp.url).toBe('http://localhost:3001/mcp');
  });

  it('should handle servers with command and args', () => {
    writeFileSync(join(TEST_DIR, '.mcp.json'), JSON.stringify({
      mcpServers: {
        supabase: {
          command: 'npx',
          args: ['@supabase/mcp-server', '--project-ref', 'abc123'],
          env: { SUPABASE_KEY: 'test-key' },
        },
      },
    }));

    const result = syncMcpConfig(TEST_DIR);

    expect(result.codex).toBe(true);
    const toml = readFileSync(join(TEST_DIR, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toContain('[mcp_servers.supabase]');
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain('"@supabase/mcp-server"');
  });

  it('should merge into existing gemini settings', () => {
    // Create existing settings
    const geminiDir = join(TEST_DIR, '.gemini');
    mkdirSync(geminiDir, { recursive: true });
    writeFileSync(join(geminiDir, 'settings.json'), JSON.stringify({
      existingKey: 'should-persist',
    }));

    writeFileSync(join(TEST_DIR, '.mcp.json'), JSON.stringify({
      mcpServers: { pcp: { url: 'http://localhost:3001/mcp' } },
    }));

    syncMcpConfig(TEST_DIR);

    const settings = JSON.parse(readFileSync(join(geminiDir, 'settings.json'), 'utf-8'));
    expect(settings.existingKey).toBe('should-persist');
    expect(settings.mcpServers.pcp).toBeDefined();
  });

  it('should add .codex/ and .gemini/ to .gitignore', () => {
    writeFileSync(join(TEST_DIR, '.mcp.json'), JSON.stringify({
      mcpServers: { pcp: { url: 'http://localhost:3001/mcp' } },
    }));

    syncMcpConfig(TEST_DIR);

    const gitignore = readFileSync(join(TEST_DIR, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.codex/');
    expect(gitignore).toContain('.gemini/');
  });

  it('should not duplicate gitignore entries on repeated runs', () => {
    writeFileSync(join(TEST_DIR, '.mcp.json'), JSON.stringify({
      mcpServers: { pcp: { url: 'http://localhost:3001/mcp' } },
    }));

    syncMcpConfig(TEST_DIR);
    syncMcpConfig(TEST_DIR);

    const gitignore = readFileSync(join(TEST_DIR, '.gitignore'), 'utf-8');
    const codexMatches = gitignore.match(/\.codex\//g);
    expect(codexMatches).toHaveLength(1);
  });

  it('should write to a custom target directory', () => {
    const subDir = join(TEST_DIR, 'my-workspace');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, '.mcp.json'), JSON.stringify({
      mcpServers: { pcp: { url: 'http://localhost:3001/mcp' } },
    }));

    const result = syncMcpConfig(subDir);

    expect(result.codex).toBe(true);
    expect(existsSync(join(subDir, '.codex', 'config.toml'))).toBe(true);
    // Should NOT exist in the parent
    expect(existsSync(join(TEST_DIR, '.codex'))).toBe(false);
  });
});
