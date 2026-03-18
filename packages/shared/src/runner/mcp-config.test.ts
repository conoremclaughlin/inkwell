import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { injectSessionHeaders, buildSessionEnv } from './mcp-config.js';

const testDir = join(tmpdir(), 'sb-mcp-test');

function writeTempConfig(config: object): string {
  mkdirSync(testDir, { recursive: true });
  const path = join(testDir, `test-mcp-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe('injectSessionHeaders', () => {
  it('injects session and studio headers into pcp server config', () => {
    const configPath = writeTempConfig({
      mcpServers: { pcp: { type: 'http', url: 'http://localhost:3001/mcp' } },
    });

    const result = injectSessionHeaders({
      mcpConfigPath: configPath,
      pcpSessionId: 'test-session-id',
      studioId: 'test-studio-id',
    });

    expect(result.modified).toBe(true);
    const config = JSON.parse(readFileSync(result.mcpConfigPath, 'utf-8'));
    expect(config.mcpServers.pcp.headers['x-pcp-session-id']).toBe('${PCP_SESSION_ID}');
    expect(config.mcpServers.pcp.headers['x-pcp-studio-id']).toBe('${PCP_STUDIO_ID}');
    expect(config.mcpServers.pcp.headers).not.toHaveProperty('Authorization');
    result.cleanup();
  });

  it('injects Authorization header when accessToken is provided', () => {
    const configPath = writeTempConfig({
      mcpServers: { pcp: { type: 'http', url: 'http://localhost:3001/mcp' } },
    });

    const result = injectSessionHeaders({
      mcpConfigPath: configPath,
      pcpSessionId: 'test-session-id',
      accessToken: 'test-token-abc',
    });

    expect(result.modified).toBe(true);
    const config = JSON.parse(readFileSync(result.mcpConfigPath, 'utf-8'));
    expect(config.mcpServers.pcp.headers['Authorization']).toBe('Bearer ${PCP_ACCESS_TOKEN}');
    expect(config.mcpServers.pcp.headers['x-pcp-session-id']).toBe('${PCP_SESSION_ID}');
    result.cleanup();
  });

  it('does not overwrite existing Authorization header', () => {
    const configPath = writeTempConfig({
      mcpServers: {
        pcp: {
          type: 'http',
          url: 'http://localhost:3001/mcp',
          headers: { Authorization: 'Bearer existing-token' },
        },
      },
    });

    const result = injectSessionHeaders({
      mcpConfigPath: configPath,
      pcpSessionId: 'test-session-id',
      accessToken: 'new-token',
    });

    expect(result.modified).toBe(true);
    const config = JSON.parse(readFileSync(result.mcpConfigPath, 'utf-8'));
    expect(config.mcpServers.pcp.headers['Authorization']).toBe('Bearer existing-token');
    result.cleanup();
  });

  it('returns original path when no pcp server entry exists', () => {
    const configPath = writeTempConfig({
      mcpServers: { github: { type: 'http', url: 'https://api.github.com' } },
    });

    const result = injectSessionHeaders({
      mcpConfigPath: configPath,
      pcpSessionId: 'test-session-id',
      accessToken: 'test-token',
    });

    expect(result.modified).toBe(false);
    expect(result.mcpConfigPath).toBe(configPath);
    unlinkSync(configPath);
  });

  it('returns original path when headers already present', () => {
    const configPath = writeTempConfig({
      mcpServers: {
        pcp: {
          type: 'http',
          url: 'http://localhost:3001/mcp',
          headers: {
            'x-pcp-session-id': '${PCP_SESSION_ID}',
            Authorization: 'Bearer ${PCP_ACCESS_TOKEN}',
          },
        },
      },
    });

    const result = injectSessionHeaders({
      mcpConfigPath: configPath,
      pcpSessionId: 'test-session-id',
      accessToken: 'test-token',
    });

    expect(result.modified).toBe(false);
    unlinkSync(configPath);
  });
});

describe('buildSessionEnv', () => {
  it('includes PCP_ACCESS_TOKEN and PCP_AUTH_BEARER when accessToken provided', () => {
    const env = buildSessionEnv({
      pcpSessionId: 'sess-123',
      studioId: 'studio-456',
      accessToken: 'tok-789',
    });

    expect(env.PCP_SESSION_ID).toBe('sess-123');
    expect(env.PCP_STUDIO_ID).toBe('studio-456');
    expect(env.PCP_ACCESS_TOKEN).toBe('tok-789');
    expect(env.PCP_AUTH_BEARER).toBe('Bearer tok-789');
  });

  it('omits PCP_ACCESS_TOKEN and PCP_AUTH_BEARER when not provided', () => {
    const env = buildSessionEnv({
      pcpSessionId: 'sess-123',
    });

    expect(env.PCP_SESSION_ID).toBe('sess-123');
    expect(env).not.toHaveProperty('PCP_ACCESS_TOKEN');
    expect(env).not.toHaveProperty('PCP_AUTH_BEARER');
  });
});
