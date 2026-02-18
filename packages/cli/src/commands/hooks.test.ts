/**
 * Hooks Tests
 *
 * Tests for installHooks (Claude Code, Codex, Gemini),
 * idempotency, conflict detection, and uninstall.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { installHooks } from './hooks.js';

const TEST_DIR = join(tmpdir(), 'pcp-hooks-test-' + Date.now());

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

// ============================================================================
// Claude Code Backend
// ============================================================================

describe('installHooks: Claude Code', () => {
  it('should detect Claude Code when .claude/ exists', () => {
    mkdirSync(join(TEST_DIR, '.claude'), { recursive: true });
    const { backend } = installHooks(TEST_DIR);
    expect(backend.name).toBe('claude-code');
  });

  it('should default to Claude Code when no backend dirs exist', () => {
    const { backend } = installHooks(TEST_DIR);
    expect(backend.name).toBe('claude-code');
  });

  it('should install hooks into .claude/settings.local.json', () => {
    const { result } = installHooks(TEST_DIR);
    expect(result).toBe('installed');

    const configPath = join(TEST_DIR, '.claude', 'settings.local.json');
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.hooks).toBeDefined();
    expect(config.hooks.PreCompact).toBeDefined();
    expect(config.hooks.SessionStart).toBeDefined();
    expect(config.hooks.UserPromptSubmit).toBeDefined();
    expect(config.hooks.Stop).toBeDefined();
  });

  it('should write correct hook commands', () => {
    installHooks(TEST_DIR);
    const configPath = join(TEST_DIR, '.claude', 'settings.local.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));

    // Commands may be absolute paths (e.g., /path/to/node_modules/.bin/sb hooks ...)
    // or bare `sb hooks ...` depending on whether node_modules/.bin/sb exists

    // PreCompact
    expect(config.hooks.PreCompact[0].hooks[0].command).toContain('sb hooks pre-compact');

    // SessionStart — compact matcher
    const compactEntry = config.hooks.SessionStart.find(
      (e: Record<string, unknown>) => e.matcher === 'compact'
    );
    expect(compactEntry.hooks[0].command).toContain('sb hooks post-compact');

    // SessionStart — startup matcher
    const startupEntry = config.hooks.SessionStart.find(
      (e: Record<string, unknown>) => e.matcher === 'startup'
    );
    expect(startupEntry.hooks[0].command).toContain('sb hooks on-session-start');

    // UserPromptSubmit
    expect(config.hooks.UserPromptSubmit[0].hooks[0].command).toContain('sb hooks on-prompt');

    // Stop
    expect(config.hooks.Stop[0].hooks[0].command).toContain('sb hooks on-stop');
  });

  it('should preserve existing non-hooks settings', () => {
    const configDir = join(TEST_DIR, '.claude');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Bash(git:*)'] } })
    );

    installHooks(TEST_DIR);

    const config = JSON.parse(readFileSync(join(configDir, 'settings.local.json'), 'utf-8'));
    expect(config.permissions.allow).toContain('Bash(git:*)');
    expect(config.hooks).toBeDefined();
  });

  it('should return already-installed when PCP hooks match exactly', () => {
    // First install
    const first = installHooks(TEST_DIR);
    expect(first.result).toBe('installed');

    // Second install — should detect idempotency
    const second = installHooks(TEST_DIR);
    expect(second.result).toBe('already-installed');
  });

  it('should return conflict when non-PCP hooks exist', () => {
    const configDir = join(TEST_DIR, '.claude');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'settings.local.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [{ type: 'command', command: 'custom-tool cleanup' }],
            },
          ],
        },
      })
    );

    const { result } = installHooks(TEST_DIR);
    expect(result).toBe('conflict');
  });

  it('should overwrite conflict when force is true', () => {
    const configDir = join(TEST_DIR, '.claude');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'settings.local.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [{ type: 'command', command: 'custom-tool cleanup' }],
            },
          ],
        },
      })
    );

    const { result } = installHooks(TEST_DIR, { force: true });
    expect(result).toBe('installed');

    const config = JSON.parse(readFileSync(join(configDir, 'settings.local.json'), 'utf-8'));
    // Should now have PCP hooks, not the custom one
    expect(config.hooks.Stop[0].hooks[0].command).toContain('sb hooks on-stop');
  });

  it('should allow re-install over existing PCP hooks without force', () => {
    // Install PCP hooks
    installHooks(TEST_DIR);

    // Manually tweak the hooks slightly (simulate a version mismatch)
    const configPath = join(TEST_DIR, '.claude', 'settings.local.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    // Add a new PCP-style hook entry
    config.hooks.Stop.push({
      hooks: [{ type: 'command', command: 'sb hooks extra' }],
    });
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Re-install should work (only PCP hooks present, so no conflict)
    const { result } = installHooks(TEST_DIR);
    // It won't match exactly, but all hooks are PCP, so it overwrites
    expect(result).toBe('installed');
  });
});

// ============================================================================
// Gemini Backend
// ============================================================================

describe('installHooks: Gemini', () => {
  it('should detect Gemini when .gemini/ exists', () => {
    mkdirSync(join(TEST_DIR, '.gemini'), { recursive: true });
    const { backend } = installHooks(TEST_DIR);
    expect(backend.name).toBe('gemini');
  });

  it('should install hooks into .gemini/settings.json', () => {
    const { result } = installHooks(TEST_DIR, { backend: 'gemini' });
    expect(result).toBe('installed');

    const configPath = join(TEST_DIR, '.gemini', 'settings.json');
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.hooks.session_start[0].command).toContain('sb hooks on-session-start');
    expect(config.hooks.session_end[0].command).toContain('sb hooks on-stop');
  });

  it('should preserve existing Gemini settings', () => {
    const configDir = join(TEST_DIR, '.gemini');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ mcpServers: { pcp: { url: 'http://localhost:3001/mcp' } } })
    );

    installHooks(TEST_DIR, { backend: 'gemini' });

    const config = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf-8'));
    expect(config.mcpServers.pcp.url).toBe('http://localhost:3001/mcp');
    expect(config.hooks).toBeDefined();
  });

  it('should return already-installed on repeat', () => {
    installHooks(TEST_DIR, { backend: 'gemini' });
    const { result } = installHooks(TEST_DIR, { backend: 'gemini' });
    expect(result).toBe('already-installed');
  });

  it('should return conflict when non-PCP hooks exist', () => {
    const configDir = join(TEST_DIR, '.gemini');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ hooks: { session_start: [{ command: 'other-tool start' }] } })
    );

    const { result } = installHooks(TEST_DIR, { backend: 'gemini' });
    expect(result).toBe('conflict');
  });
});

// ============================================================================
// Codex Backend
// ============================================================================

describe('installHooks: Codex', () => {
  it('should detect Codex when .codex/ exists', () => {
    mkdirSync(join(TEST_DIR, '.codex'), { recursive: true });
    // .claude/ takes priority, so only put .codex/
    const { backend } = installHooks(TEST_DIR);
    expect(backend.name).toBe('codex');
  });

  it('should install hooks into .codex/config.toml', () => {
    const { result } = installHooks(TEST_DIR, { backend: 'codex' });
    expect(result).toBe('installed');

    const configPath = join(TEST_DIR, '.codex', 'config.toml');
    expect(existsSync(configPath)).toBe(true);

    const content = readFileSync(configPath, 'utf-8');
    expect(content).toContain('# pcp-managed');
    expect(content).toContain('[hooks]');
    expect(content).toMatch(/session_start = ".*sb hooks on-session-start"/);
    expect(content).toMatch(/session_end = ".*sb hooks on-stop"/);
    expect(content).toContain('# end pcp-managed');
  });

  it('should return already-installed when PCP marker exists', () => {
    installHooks(TEST_DIR, { backend: 'codex' });
    const { result } = installHooks(TEST_DIR, { backend: 'codex' });
    expect(result).toBe('already-installed');
  });

  it('should return conflict when non-PCP [hooks] exists', () => {
    const configDir = join(TEST_DIR, '.codex');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.toml'), '[hooks]\nsession_start = "other-tool start"\n');

    const { result } = installHooks(TEST_DIR, { backend: 'codex' });
    expect(result).toBe('conflict');
  });

  it('should preserve existing TOML content outside hooks', () => {
    const configDir = join(TEST_DIR, '.codex');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.toml'),
      '[mcp_servers.pcp]\nurl = "http://localhost:3001/mcp"\n'
    );

    installHooks(TEST_DIR, { backend: 'codex' });

    const content = readFileSync(join(configDir, 'config.toml'), 'utf-8');
    expect(content).toContain('[mcp_servers.pcp]');
    expect(content).toContain('# pcp-managed');
  });

  it('should replace PCP section on re-install with force', () => {
    installHooks(TEST_DIR, { backend: 'codex' });

    // Force re-install
    const { result } = installHooks(TEST_DIR, { backend: 'codex', force: true });
    expect(result).toBe('installed');

    // Should have exactly one start marker and one end marker (no duplicates)
    const content = readFileSync(join(TEST_DIR, '.codex', 'config.toml'), 'utf-8');
    const startMarkers = content.match(/# pcp-managed\n/g);
    const endMarkers = content.match(/# end pcp-managed/g);
    expect(startMarkers).toHaveLength(1);
    expect(endMarkers).toHaveLength(1);
    expect(content).toMatch(/session_start = ".*sb hooks on-session-start"/);
  });
});

// ============================================================================
// Backend override
// ============================================================================

describe('installHooks: backend override', () => {
  it('should use explicit backend even when .claude/ exists', () => {
    mkdirSync(join(TEST_DIR, '.claude'), { recursive: true });
    const { backend } = installHooks(TEST_DIR, { backend: 'gemini' });
    expect(backend.name).toBe('gemini');
  });

  it('should accept claude-code as backend name', () => {
    const { backend } = installHooks(TEST_DIR, { backend: 'claude-code' });
    expect(backend.name).toBe('claude-code');
  });

  it('should accept claude as backend name alias', () => {
    const { backend } = installHooks(TEST_DIR, { backend: 'claude' });
    expect(backend.name).toBe('claude-code');
  });
});

// ============================================================================
// Backend detection priority
// ============================================================================

describe('installHooks: detection priority', () => {
  it('should prefer .claude/ over .codex/', () => {
    mkdirSync(join(TEST_DIR, '.claude'), { recursive: true });
    mkdirSync(join(TEST_DIR, '.codex'), { recursive: true });
    const { backend } = installHooks(TEST_DIR);
    expect(backend.name).toBe('claude-code');
  });

  it('should prefer .gemini/ over .codex/', () => {
    mkdirSync(join(TEST_DIR, '.gemini'), { recursive: true });
    mkdirSync(join(TEST_DIR, '.codex'), { recursive: true });
    const { backend } = installHooks(TEST_DIR);
    expect(backend.name).toBe('gemini');
  });
});
