import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ClaudeAdapter } from './claude.js';

// Keep user-installed skills out of the merged MCP config.
vi.mock('../repl/skills.js', () => ({
  discoverSkills: () => [],
}));

// Disable the `claude --help` partial-messages probe — no subprocesses in unit tests.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(() => {
      throw new Error('probe disabled in tests');
    }),
  };
});

function mcpConfigFrom(args: string[]): Record<string, unknown> {
  const idx = args.indexOf('--mcp-config');
  expect(idx).toBeGreaterThan(-1);
  return JSON.parse(readFileSync(args[idx + 1]!, 'utf-8')).mcpServers;
}

describe('ClaudeAdapter prepare — tool routing', () => {
  let tmpDir: string;
  let savedCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-adapter-'));
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
          github: { type: 'http', url: 'https://api.github.com/mcp' },
          inkmail: { command: 'npx', args: ['tsx', 'plugin.ts'] },
        },
      })
    );
    savedCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ink-owned routing ('local') withholds tool servers and pins the config strictly", () => {
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      agentId: 'myra',
      prompt: 'hello',
      promptParts: ['hello'],
      passthroughArgs: [],
      toolRouting: 'local',
    });
    try {
      // Without strict mode claude merges user/project-scope MCP configs on
      // its own and the withheld servers leak back in.
      expect(prepared.args).toContain('--strict-mcp-config');
      const servers = mcpConfigFrom(prepared.args);
      expect(Object.keys(servers)).toEqual(['inkmail']);
      // Channel loading still references the surviving inkmail entry.
      expect(prepared.args).toContain('--dangerously-load-development-channels');
    } finally {
      prepared.cleanup();
    }
  });

  it('provider-owned routing (undefined/backend) passes the full config, no strict flag', () => {
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      agentId: 'wren',
      prompt: 'hello',
      promptParts: ['hello'],
      passthroughArgs: [],
    });
    try {
      expect(prepared.args).not.toContain('--strict-mcp-config');
      const servers = mcpConfigFrom(prepared.args);
      expect(Object.keys(servers).sort()).toEqual(['github', 'inkmail', 'inkwell']);
    } finally {
      prepared.cleanup();
    }
  });
});
