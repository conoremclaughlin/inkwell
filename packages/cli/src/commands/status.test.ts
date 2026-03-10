import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { getClaudePermissionsStatus, getMcpConfigStatus } from './status.js';

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (!path) continue;
    rmSync(path, { recursive: true, force: true });
  }
});

describe('status helpers', () => {
  it('reports missing claude permissions config', () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-status-'));
    cleanupPaths.push(root);

    const status = getClaudePermissionsStatus(root);
    expect(status.configExists).toBe(false);
    expect(status.hasPermissions).toBe(false);
    expect(status.hasPcpMcpAllowance).toBe(false);
  });

  it('detects configured claude permissions and MCP PCP allowance', () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-status-'));
    cleanupPaths.push(root);
    const claudeDir = join(root, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.local.json'),
      JSON.stringify({
        permissions: {
          allow: ['Bash(*)', 'mcp__pcp__*'],
          deny: ['Bash(rm -rf *)'],
        },
      })
    );

    const status = getClaudePermissionsStatus(root);
    expect(status.configExists).toBe(true);
    expect(status.parseError).toBe(false);
    expect(status.hasPermissions).toBe(true);
    expect(status.allowCount).toBe(2);
    expect(status.denyCount).toBe(1);
    expect(status.hasPcpMcpAllowance).toBe(true);
  });

  it('reports mcp config with pcp server url', () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-status-'));
    cleanupPaths.push(root);
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          pcp: { type: 'http', url: 'http://localhost:3001/mcp' },
          github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' },
        },
      })
    );

    const status = getMcpConfigStatus(root);
    expect(status.configExists).toBe(true);
    expect(status.parseError).toBe(false);
    expect(status.hasPcpServer).toBe(true);
    expect(status.pcpUrl).toBe('http://localhost:3001/mcp');
  });

  it('reports parse errors in mcp config', () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-status-'));
    cleanupPaths.push(root);
    writeFileSync(join(root, '.mcp.json'), '{bad-json');

    const status = getMcpConfigStatus(root);
    expect(status.configExists).toBe(true);
    expect(status.parseError).toBe(true);
    expect(status.hasPcpServer).toBe(false);
  });
});
