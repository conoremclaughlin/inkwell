/**
 * MCP Config Sync Tests
 *
 * Tests for syncMcpConfig extraction and functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { syncMcpConfig, parseEnvFile } from './mcp.js';

const TEST_DIR = join(tmpdir(), 'ink-mcp-test-' + Date.now());

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
    writeFileSync(
      join(TEST_DIR, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: {
            type: 'http',
            url: 'http://localhost:3001/mcp',
          },
        },
      })
    );

    const result = syncMcpConfig(TEST_DIR);

    expect(result.codex).toBe(true);
    expect(existsSync(join(TEST_DIR, '.codex', 'config.toml'))).toBe(true);

    const toml = readFileSync(join(TEST_DIR, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toContain('# ink-managed:start mcp_servers');
    expect(toml).toContain('[mcp_servers.inkwell]');
    expect(toml).toContain('url = "http://localhost:3001/mcp"');
    expect(toml).toContain('# ink-managed:end mcp_servers');
  });

  it('should create .gemini/settings.json from .mcp.json', () => {
    writeFileSync(
      join(TEST_DIR, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: {
            type: 'http',
            url: 'http://localhost:3001/mcp',
          },
        },
      })
    );

    const result = syncMcpConfig(TEST_DIR);

    expect(result.gemini).toBe(true);
    expect(existsSync(join(TEST_DIR, '.gemini', 'settings.json'))).toBe(true);

    const settings = JSON.parse(readFileSync(join(TEST_DIR, '.gemini', 'settings.json'), 'utf-8'));
    expect(settings.mcpServers.inkwell).toBeDefined();
    expect(settings.mcpServers.inkwell.url).toBe('http://localhost:3001/mcp');
    expect(settings.mcpServers.inkwell.type).toBe('http');
  });

  it('should handle servers with command and args', () => {
    writeFileSync(
      join(TEST_DIR, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          supabase: {
            command: 'npx',
            args: ['@supabase/mcp-server', '--project-ref', 'abc123'],
            env: { SUPABASE_KEY: 'test-key' },
          },
        },
      })
    );

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
    writeFileSync(
      join(geminiDir, 'settings.json'),
      JSON.stringify({
        existingKey: 'should-persist',
      })
    );

    writeFileSync(
      join(TEST_DIR, '.mcp.json'),
      JSON.stringify({
        mcpServers: { inkwell: { url: 'http://localhost:3001/mcp' } },
      })
    );

    syncMcpConfig(TEST_DIR);

    const settings = JSON.parse(readFileSync(join(geminiDir, 'settings.json'), 'utf-8'));
    expect(settings.existingKey).toBe('should-persist');
    expect(settings.mcpServers.inkwell).toBeDefined();
  });

  it('should add .codex/ and .gemini/ to .gitignore', () => {
    writeFileSync(
      join(TEST_DIR, '.mcp.json'),
      JSON.stringify({
        mcpServers: { inkwell: { url: 'http://localhost:3001/mcp' } },
      })
    );

    syncMcpConfig(TEST_DIR);

    const gitignore = readFileSync(join(TEST_DIR, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.codex/');
    expect(gitignore).toContain('.gemini/');
  });

  it('should not duplicate gitignore entries on repeated runs', () => {
    writeFileSync(
      join(TEST_DIR, '.mcp.json'),
      JSON.stringify({
        mcpServers: { inkwell: { url: 'http://localhost:3001/mcp' } },
      })
    );

    syncMcpConfig(TEST_DIR);
    syncMcpConfig(TEST_DIR);

    const gitignore = readFileSync(join(TEST_DIR, '.gitignore'), 'utf-8');
    const codexMatches = gitignore.match(/\.codex\//g);
    expect(codexMatches).toHaveLength(1);
  });

  it('should convert Bearer ${ENV_VAR} headers to Codex bearer_token_env_var', () => {
    writeFileSync(
      join(TEST_DIR, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          github: {
            type: 'http',
            url: 'https://api.githubcopilot.com/mcp/',
            headers: {
              Authorization: 'Bearer ${GITHUB_TOKEN}',
            },
          },
        },
      })
    );

    syncMcpConfig(TEST_DIR);

    const toml = readFileSync(join(TEST_DIR, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toContain('bearer_token_env_var = "GITHUB_TOKEN"');
    expect(toml).not.toContain('http_headers');
  });

  it('should use http_headers for non-bearer auth in Codex', () => {
    writeFileSync(
      join(TEST_DIR, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          custom: {
            url: 'https://example.com/mcp',
            headers: {
              'X-Api-Key': 'some-key',
            },
          },
        },
      })
    );

    syncMcpConfig(TEST_DIR);

    const toml = readFileSync(join(TEST_DIR, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toContain('http_headers = { "X-Api-Key" = "some-key" }');
    expect(toml).not.toContain('bearer_token_env_var');
  });

  it('should write to a custom target directory', () => {
    const subDir = join(TEST_DIR, 'my-workspace');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { inkwell: { url: 'http://localhost:3001/mcp' } },
      })
    );

    const result = syncMcpConfig(subDir);

    expect(result.codex).toBe(true);
    expect(existsSync(join(subDir, '.codex', 'config.toml'))).toBe(true);
    // Should NOT exist in the parent
    expect(existsSync(join(TEST_DIR, '.codex'))).toBe(false);
  });

  it('should emit env block for stdio servers in Codex TOML', () => {
    writeFileSync(
      join(TEST_DIR, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          supabase: {
            command: 'npx',
            args: ['@supabase/mcp-server'],
            env: { SUPABASE_KEY: 'test-key' },
          },
        },
      })
    );

    syncMcpConfig(TEST_DIR);

    const toml = readFileSync(join(TEST_DIR, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toContain('env = {');
    expect(toml).toContain('"SUPABASE_KEY" = "test-key"');
  });

  it('should NOT emit env for streamable_http servers in Codex TOML', () => {
    writeFileSync(
      join(TEST_DIR, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          github: {
            type: 'http',
            url: 'https://api.githubcopilot.com/mcp/',
            headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' },
          },
        },
      })
    );
    writeFileSync(join(TEST_DIR, '.env.local'), 'GITHUB_TOKEN=ghp_test123\n');

    syncMcpConfig(TEST_DIR);

    const toml = readFileSync(join(TEST_DIR, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toContain('bearer_token_env_var = "GITHUB_TOKEN"');
    // env block must NOT appear for url-based (streamable_http) servers
    expect(toml).not.toContain('env = {');
  });

  it('should inject .env.local vars into Gemini env', () => {
    writeFileSync(
      join(TEST_DIR, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          github: {
            type: 'http',
            url: 'https://api.githubcopilot.com/mcp/',
            headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' },
          },
        },
      })
    );
    writeFileSync(join(TEST_DIR, '.env.local'), 'GITHUB_TOKEN=ghp_test123\n');

    syncMcpConfig(TEST_DIR);

    const settings = JSON.parse(readFileSync(join(TEST_DIR, '.gemini', 'settings.json'), 'utf-8'));
    expect(settings.mcpServers.github.env).toBeDefined();
    expect(settings.mcpServers.github.env.GITHUB_TOKEN).toBe('ghp_test123');
  });

  it('should not overwrite existing env vars with .env.local', () => {
    writeFileSync(
      join(TEST_DIR, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          myserver: {
            url: 'https://example.com/${API_KEY}',
            env: { API_KEY: 'explicit-value' },
          },
        },
      })
    );
    writeFileSync(join(TEST_DIR, '.env.local'), 'API_KEY=env-local-value\n');

    syncMcpConfig(TEST_DIR);

    const settings = JSON.parse(readFileSync(join(TEST_DIR, '.gemini', 'settings.json'), 'utf-8'));
    expect(settings.mcpServers.myserver.env.API_KEY).toBe('explicit-value');
  });

  it('should not inject vars that are not referenced in config', () => {
    writeFileSync(
      join(TEST_DIR, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: { url: 'http://localhost:3001/mcp' },
        },
      })
    );
    writeFileSync(join(TEST_DIR, '.env.local'), 'SECRET_KEY=should-not-appear\n');

    syncMcpConfig(TEST_DIR);

    const settings = JSON.parse(readFileSync(join(TEST_DIR, '.gemini', 'settings.json'), 'utf-8'));
    expect(settings.mcpServers.inkwell.env).toBeUndefined();
  });

  it('should work fine without .env.local present', () => {
    writeFileSync(
      join(TEST_DIR, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          github: {
            url: 'https://api.githubcopilot.com/mcp/',
            headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' },
          },
        },
      })
    );
    // No .env.local

    const result = syncMcpConfig(TEST_DIR);
    expect(result.codex).toBe(true);
    expect(result.gemini).toBe(true);

    // Should still generate configs, just without injected env
    const settings = JSON.parse(readFileSync(join(TEST_DIR, '.gemini', 'settings.json'), 'utf-8'));
    expect(settings.mcpServers.github.env).toBeUndefined();
  });

  it('should support syncing from external source .mcp.json and .env.local', () => {
    const sourceDir = join(TEST_DIR, 'source');
    const targetDir = join(TEST_DIR, 'target');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });

    writeFileSync(
      join(sourceDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          github: {
            url: 'https://api.githubcopilot.com/mcp/',
            headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' },
          },
        },
      })
    );
    writeFileSync(join(sourceDir, '.env.local'), 'GITHUB_TOKEN=source-token\n');

    const result = syncMcpConfig(targetDir, {
      sourceMcpPath: join(sourceDir, '.mcp.json'),
      sourceEnvPath: join(sourceDir, '.env.local'),
    });
    expect(result.codex).toBe(true);
    expect(result.gemini).toBe(true);

    const toml = readFileSync(join(targetDir, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toContain('bearer_token_env_var = "GITHUB_TOKEN"');
    // env block should NOT appear for url-based servers in Codex TOML
    expect(toml).not.toContain('env = {');
  });

  it('should preserve existing hooks while replacing managed MCP block', () => {
    mkdirSync(join(TEST_DIR, '.codex'), { recursive: true });
    writeFileSync(
      join(TEST_DIR, '.codex', 'config.toml'),
      [
        '[hooks]',
        'enabled = true',
        '',
        '# ink-managed:start mcp_servers',
        '[mcp_servers.old]',
        'url = "http://old"',
        '# ink-managed:end mcp_servers',
        '',
      ].join('\n')
    );

    writeFileSync(
      join(TEST_DIR, '.mcp.json'),
      JSON.stringify({
        mcpServers: { inkwell: { url: 'http://localhost:3001/mcp' } },
      })
    );

    syncMcpConfig(TEST_DIR);

    const toml = readFileSync(join(TEST_DIR, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toContain('[hooks]');
    expect(toml).toContain('enabled = true');
    expect(toml).toContain('[mcp_servers.inkwell]');
    expect(toml).not.toContain('[mcp_servers.old]');
  });

  it('should preserve non-MCP config when upgrading from legacy generated format', () => {
    mkdirSync(join(TEST_DIR, '.codex'), { recursive: true });
    writeFileSync(
      join(TEST_DIR, '.codex', 'config.toml'),
      [
        '[hooks]',
        'enabled = true',
        '',
        '# Generated by `ink mcp sync` from .mcp.json',
        '# Re-run `ink mcp sync` after changing .mcp.json',
        '',
        '[mcp_servers.old]',
        'url = "http://old"',
        '',
      ].join('\n')
    );

    writeFileSync(
      join(TEST_DIR, '.mcp.json'),
      JSON.stringify({
        mcpServers: { fresh: { url: 'http://localhost:3001/mcp' } },
      })
    );

    syncMcpConfig(TEST_DIR);

    const toml = readFileSync(join(TEST_DIR, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toContain('[hooks]');
    expect(toml).toContain('enabled = true');
    expect(toml).toContain('[mcp_servers.fresh]');
    expect(toml).not.toContain('[mcp_servers.old]');
  });
});

describe('parseEnvFile', () => {
  it('should parse simple key=value pairs', () => {
    const envPath = join(TEST_DIR, '.env.test');
    writeFileSync(envPath, 'FOO=bar\nBAZ=qux\n');
    const result = parseEnvFile(envPath);
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('should skip comments and empty lines', () => {
    const envPath = join(TEST_DIR, '.env.test');
    writeFileSync(envPath, '# Comment\n\nFOO=bar\n# Another comment\n');
    const result = parseEnvFile(envPath);
    expect(result).toEqual({ FOO: 'bar' });
  });

  it('should handle quoted values', () => {
    const envPath = join(TEST_DIR, '.env.test');
    writeFileSync(envPath, 'FOO="bar baz"\nQUX=\'hello world\'\n');
    const result = parseEnvFile(envPath);
    expect(result).toEqual({ FOO: 'bar baz', QUX: 'hello world' });
  });

  it('should strip inline comments from unquoted values', () => {
    const envPath = join(TEST_DIR, '.env.test');
    writeFileSync(envPath, 'TOKEN=abc123 # my token\n');
    const result = parseEnvFile(envPath);
    expect(result).toEqual({ TOKEN: 'abc123' });
  });

  it('should return empty object for non-existent file', () => {
    const result = parseEnvFile(join(TEST_DIR, 'nonexistent'));
    expect(result).toEqual({});
  });
});
