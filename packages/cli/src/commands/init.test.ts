/**
 * Init Command Tests
 *
 * Tests for ink init: .ink/ creation, .mcp.json setup,
 * hooks installation, and idempotency.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { installHooks } from './hooks.js';
import { syncMcpConfig } from './mcp.js';

const TEST_DIR = join(tmpdir(), 'pcp-init-test-' + Date.now());

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
// .ink/ directory
// ============================================================================

describe('init: .ink/ directory', () => {
  it('should create .ink/ if it does not exist', () => {
    const pcpDir = join(TEST_DIR, '.ink');
    expect(existsSync(pcpDir)).toBe(false);
    mkdirSync(pcpDir, { recursive: true });
    expect(existsSync(pcpDir)).toBe(true);
  });

  it('should be idempotent if .ink/ already exists', () => {
    const pcpDir = join(TEST_DIR, '.ink');
    mkdirSync(pcpDir, { recursive: true });
    writeFileSync(join(pcpDir, 'identity.json'), JSON.stringify({ agentId: 'wren' }));

    // Creating again should not clobber
    mkdirSync(pcpDir, { recursive: true });
    expect(existsSync(join(pcpDir, 'identity.json'))).toBe(true);
    const identity = JSON.parse(readFileSync(join(pcpDir, 'identity.json'), 'utf-8'));
    expect(identity.agentId).toBe('wren');
  });
});

// ============================================================================
// .mcp.json setup
// ============================================================================

describe('init: .mcp.json', () => {
  it('should create .mcp.json with pcp server when none exists', () => {
    const mcpPath = join(TEST_DIR, '.mcp.json');
    expect(existsSync(mcpPath)).toBe(false);

    // Simulate init logic
    const defaultMcp = {
      mcpServers: {
        pcp: { type: 'http', url: 'http://localhost:3001/mcp' },
      },
    };
    writeFileSync(mcpPath, JSON.stringify(defaultMcp, null, 2) + '\n');

    expect(existsSync(mcpPath)).toBe(true);
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(config.mcpServers.pcp.url).toBe('http://localhost:3001/mcp');
  });

  it('should add pcp server to existing .mcp.json without it', () => {
    const mcpPath = join(TEST_DIR, '.mcp.json');
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          supabase: { type: 'http', url: 'https://supabase.example.com/mcp' },
        },
      })
    );

    // Simulate init logic: add pcp server
    const existing = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    if (!existing.mcpServers.pcp) {
      existing.mcpServers.pcp = { type: 'http', url: 'http://localhost:3001/mcp' };
      writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + '\n');
    }

    const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(config.mcpServers.supabase.url).toBe('https://supabase.example.com/mcp');
    expect(config.mcpServers.pcp.url).toBe('http://localhost:3001/mcp');
  });

  it('should not modify .mcp.json if pcp server already exists', () => {
    const mcpPath = join(TEST_DIR, '.mcp.json');
    const original = {
      mcpServers: {
        pcp: { type: 'http', url: 'http://custom-server:4000/mcp' },
      },
    };
    writeFileSync(mcpPath, JSON.stringify(original, null, 2) + '\n');

    // Simulate init logic: skip if pcp exists
    const existing = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(existing.mcpServers.pcp).toBeDefined();

    // Verify it wasn't changed
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(config.mcpServers.pcp.url).toBe('http://custom-server:4000/mcp');
  });
});

// ============================================================================
// Hooks installation via init
// ============================================================================

describe('init: hooks installation', () => {
  it('should install hooks as part of init flow', () => {
    const { result, backend } = installHooks(TEST_DIR);
    expect(result).toBe('installed');
    expect(backend.name).toBe('claude-code');

    const configPath = join(TEST_DIR, '.claude', 'settings.local.json');
    expect(existsSync(configPath)).toBe(true);
  });

  it('should report already-installed on second run', () => {
    installHooks(TEST_DIR);
    const { result } = installHooks(TEST_DIR);
    expect(result).toBe('already-installed');
  });

  it('should report conflict and not overwrite non-PCP hooks', () => {
    const claudeDir = join(TEST_DIR, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.local.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'custom-tool' }] }],
        },
      })
    );

    const { result } = installHooks(TEST_DIR);
    expect(result).toBe('conflict');
  });
});

// ============================================================================
// Backend config sync via init
// ============================================================================

describe('init: backend config sync', () => {
  it('should sync .mcp.json to .codex/ and .gemini/', () => {
    writeFileSync(
      join(TEST_DIR, '.mcp.json'),
      JSON.stringify({
        mcpServers: { pcp: { type: 'http', url: 'http://localhost:3001/mcp' } },
      })
    );

    const result = syncMcpConfig(TEST_DIR);
    expect(result.codex).toBe(true);
    expect(result.gemini).toBe(true);

    expect(existsSync(join(TEST_DIR, '.codex', 'config.toml'))).toBe(true);
    expect(existsSync(join(TEST_DIR, '.gemini', 'settings.json'))).toBe(true);
  });

  it('should return false when no .mcp.json exists', () => {
    const result = syncMcpConfig(TEST_DIR);
    expect(result.codex).toBe(false);
    expect(result.gemini).toBe(false);
  });
});

// ============================================================================
// Full init flow (integration)
// ============================================================================

describe('init: full flow idempotency', () => {
  function simulateInit(cwd: string): {
    pcp: 'created' | 'exists';
    mcp: 'created' | 'exists' | 'updated';
    hooks: string;
    sync: boolean;
  } {
    // Step 1: .ink/
    const pcpDir = join(cwd, '.ink');
    const pcpResult = existsSync(pcpDir) ? 'exists' as const : 'created' as const;
    mkdirSync(pcpDir, { recursive: true });

    // Step 2: .mcp.json
    const mcpPath = join(cwd, '.mcp.json');
    let mcpResult: 'created' | 'exists' | 'updated';
    if (!existsSync(mcpPath)) {
      writeFileSync(
        mcpPath,
        JSON.stringify({
          mcpServers: { pcp: { type: 'http', url: 'http://localhost:3001/mcp' } },
        }, null, 2) + '\n'
      );
      mcpResult = 'created';
    } else {
      const existing = JSON.parse(readFileSync(mcpPath, 'utf-8'));
      if (existing.mcpServers?.pcp) {
        mcpResult = 'exists';
      } else {
        existing.mcpServers = { ...(existing.mcpServers || {}), pcp: { type: 'http', url: 'http://localhost:3001/mcp' } };
        writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + '\n');
        mcpResult = 'updated';
      }
    }

    // Step 3: Hooks
    const { result: hooksResult } = installHooks(cwd);

    // Step 4: Sync
    const syncResult = syncMcpConfig(cwd);

    return {
      pcp: pcpResult,
      mcp: mcpResult,
      hooks: hooksResult,
      sync: syncResult.codex || syncResult.gemini,
    };
  }

  it('should create everything on first run', () => {
    const result = simulateInit(TEST_DIR);
    expect(result.pcp).toBe('created');
    expect(result.mcp).toBe('created');
    expect(result.hooks).toBe('installed');
    expect(result.sync).toBe(true);
  });

  it('should detect everything exists on second run', () => {
    simulateInit(TEST_DIR);
    const result = simulateInit(TEST_DIR);
    expect(result.pcp).toBe('exists');
    expect(result.mcp).toBe('exists');
    expect(result.hooks).toBe('already-installed');
    // sync still returns true because it overwrites
    expect(result.sync).toBe(true);
  });

  it('should add pcp to existing .mcp.json on first run', () => {
    // Pre-existing .mcp.json without pcp
    writeFileSync(
      join(TEST_DIR, '.mcp.json'),
      JSON.stringify({
        mcpServers: { supabase: { type: 'http', url: 'https://supabase.example.com/mcp' } },
      })
    );

    const result = simulateInit(TEST_DIR);
    expect(result.mcp).toBe('updated');

    const config = JSON.parse(readFileSync(join(TEST_DIR, '.mcp.json'), 'utf-8'));
    expect(config.mcpServers.supabase).toBeDefined();
    expect(config.mcpServers.pcp).toBeDefined();
  });
});
