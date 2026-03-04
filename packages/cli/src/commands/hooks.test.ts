/**
 * Hooks Tests
 *
 * Tests for installHooks (Claude Code, Codex, Gemini),
 * idempotency, conflict detection, and uninstall.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { installHooks, callPcpTool, buildIdentityBlock } from './hooks.js';

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
    expect(config.hooks.PreCompact[0].hooks[0].command).toContain('hooks pre-compact');

    // SessionStart — compact matcher
    const compactEntry = config.hooks.SessionStart.find(
      (e: Record<string, unknown>) => e.matcher === 'compact'
    );
    expect(compactEntry.hooks[0].command).toContain('hooks post-compact');

    // SessionStart — startup matcher
    const startupEntry = config.hooks.SessionStart.find(
      (e: Record<string, unknown>) => e.matcher === 'startup'
    );
    expect(startupEntry.hooks[0].command).toContain('hooks on-session-start');

    // UserPromptSubmit
    expect(config.hooks.UserPromptSubmit[0].hooks[0].command).toContain('hooks on-prompt');

    // Stop
    expect(config.hooks.Stop[0].hooks[0].command).toContain('hooks on-stop');
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
    expect(config.hooks.Stop[0].hooks[0].command).toContain('hooks on-stop');
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
    expect(config.hooks.SessionStart[0].hooks[0].command).toContain('hooks on-session-start');
    expect(config.hooks.BeforeAgent[0].hooks[0].command).toContain('hooks on-prompt');
    expect(config.hooks.AfterAgent[0].hooks[0].command).toContain('hooks on-stop');
    expect(config.hooks.PreCompress[0].hooks[0].command).toContain('hooks pre-compact');
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
      JSON.stringify({ hooks: { SessionStart: [{ command: 'other-tool start' }] } })
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
    expect(content).toContain('# pcp-managed:hooks:start');
    expect(content).toContain('[hooks]');
    expect(content).toMatch(/session_start = ".*hooks on-session-start[^"]*"/);
    expect(content).toMatch(/session_end = ".*hooks on-stop[^"]*"/);
    expect(content).toMatch(/user_prompt = ".*hooks on-prompt[^"]*"/);
    expect(content).toContain('# pcp-managed:hooks:end');
  });

  it('should return already-installed when PCP hooks are already present', () => {
    installHooks(TEST_DIR, { backend: 'codex' });
    const { result } = installHooks(TEST_DIR, { backend: 'codex' });
    expect(result).toBe('already-installed');
  });

  it('does not confuse MCP managed markers with hook installation', () => {
    const configDir = join(TEST_DIR, '.codex');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.toml'),
      [
        '# pcp-managed:start mcp_servers',
        '[mcp_servers.pcp]',
        'url = "http://localhost:3001/mcp"',
        '# pcp-managed:end mcp_servers',
        '',
      ].join('\n')
    );

    const { result } = installHooks(TEST_DIR, { backend: 'codex' });
    expect(result).toBe('installed');

    const content = readFileSync(join(configDir, 'config.toml'), 'utf-8');
    expect(content).toContain('# pcp-managed:start mcp_servers');
    expect(content).toContain('# pcp-managed:hooks:start');
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
    expect(content).toContain('# pcp-managed:hooks:start');
  });

  it('should replace PCP section on re-install with force', () => {
    installHooks(TEST_DIR, { backend: 'codex' });

    // Force re-install
    const { result } = installHooks(TEST_DIR, { backend: 'codex', force: true });
    expect(result).toBe('installed');

    // Should have exactly one start marker and one end marker (no duplicates)
    const content = readFileSync(join(TEST_DIR, '.codex', 'config.toml'), 'utf-8');
    const startMarkers = content.match(/# pcp-managed:hooks:start/g);
    const endMarkers = content.match(/# pcp-managed:hooks:end/g);
    expect(startMarkers).toHaveLength(1);
    expect(endMarkers).toHaveLength(1);
    expect(content).toMatch(/session_start = ".*hooks on-session-start[^"]*"/);
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

// ============================================================================
// callPcpTool auth header regression
// ============================================================================

vi.mock('../auth/tokens.js', () => ({
  getValidAccessToken: vi.fn(),
  loadAuth: vi.fn(),
  isTokenExpired: vi.fn(),
  decodeJwtPayload: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
import * as tokensMod from '../auth/tokens.js';
const mockedGetValidAccessToken = vi.mocked(tokensMod.getValidAccessToken);

// ============================================================================
// Helpers for mock fetch responses
// ============================================================================

/** Build a mock Response that returns JSON (application/json) */
function mockJsonResponse(payload: Record<string, unknown>): Partial<Response> {
  return {
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

/** Build a mock Response that returns SSE (text/event-stream) */
function mockSseResponse(payload: Record<string, unknown>): Partial<Response> {
  const sseBody = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
  return {
    ok: true,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    text: async () => sseBody,
  };
}

const TOOL_RESULT_PAYLOAD = {
  jsonrpc: '2.0',
  result: { content: [{ text: '{"success":true}' }] },
  id: 1,
};

// ============================================================================
// callPcpTool: auth header
// ============================================================================

describe('callPcpTool: auth header', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(TOOL_RESULT_PAYLOAD));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('should send Authorization header when CLI token is available', async () => {
    mockedGetValidAccessToken.mockResolvedValue('test-jwt-token');

    await callPcpTool('bootstrap', { agentId: 'wren' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers).toHaveProperty('Authorization', 'Bearer test-jwt-token');
  });

  it('should omit Authorization header when no token is available', async () => {
    mockedGetValidAccessToken.mockResolvedValue(null);

    await callPcpTool('bootstrap', { agentId: 'wren' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers).not.toHaveProperty('Authorization');
  });

  it('should send correct JSON-RPC payload', async () => {
    mockedGetValidAccessToken.mockResolvedValue('token');

    await callPcpTool('get_inbox', { agentId: 'wren', status: 'unread' });

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toContain('/mcp');
    const body = JSON.parse(options.body);
    expect(body.method).toBe('tools/call');
    expect(body.params.name).toBe('get_inbox');
    expect(body.params.arguments).toEqual({ agentId: 'wren', status: 'unread' });
  });

  it('should send spec-compliant Accept header (both JSON and SSE)', async () => {
    mockedGetValidAccessToken.mockResolvedValue('token');

    await callPcpTool('bootstrap', { agentId: 'wren' });

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers.Accept).toBe('application/json, text/event-stream');
  });
});

// ============================================================================
// callPcpTool: Streamable HTTP response format handling
// ============================================================================

describe('callPcpTool: Streamable HTTP response formats', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockedGetValidAccessToken.mockResolvedValue('token');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.PCP_ACCESS_TOKEN;
  });

  it('should parse application/json response (enableJsonResponse mode)', async () => {
    fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(TOOL_RESULT_PAYLOAD));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await callPcpTool('bootstrap', { agentId: 'wren' });
    expect(result).toEqual({ success: true });
  });

  it('should parse text/event-stream SSE response (default Streamable HTTP)', async () => {
    fetchSpy = vi.fn().mockResolvedValue(mockSseResponse(TOOL_RESULT_PAYLOAD));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await callPcpTool('bootstrap', { agentId: 'wren' });
    expect(result).toEqual({ success: true });
  });

  it('should handle SSE response with multiple events (uses last data line)', async () => {
    const sseBody = [
      'event: message',
      'data: {"jsonrpc":"2.0","result":{"content":[{"text":"partial"}]},"id":1}',
      '',
      'event: message',
      'data: {"jsonrpc":"2.0","result":{"content":[{"text":"{\\"final\\":true}"}]},"id":1}',
      '',
    ].join('\n');
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      text: async () => sseBody,
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await callPcpTool('bootstrap', { agentId: 'wren' });
    expect(result).toEqual({ final: true });
  });

  it('should throw on SSE response with no data lines', async () => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      text: async () => 'event: message\n\n',
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(callPcpTool('bootstrap', { agentId: 'wren' })).rejects.toThrow(
      'PCP SSE response contained no data lines'
    );
  });

  it('should throw on non-OK HTTP status', async () => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 406,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => '{"error":"Not Acceptable"}',
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(callPcpTool('bootstrap', { agentId: 'wren' })).rejects.toThrow(
      'PCP call failed (406)'
    );
  });

  it('should throw on JSON-RPC error in JSON response', async () => {
    fetchSpy = vi.fn().mockResolvedValue(
      mockJsonResponse({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Authentication required' },
        id: null,
      })
    );
    vi.stubGlobal('fetch', fetchSpy);

    await expect(callPcpTool('bootstrap', { agentId: 'wren' })).rejects.toThrow(
      'PCP tool error (-32001): Authentication required'
    );
  });

  it('should throw on JSON-RPC error in SSE response', async () => {
    fetchSpy = vi.fn().mockResolvedValue(
      mockSseResponse({
        jsonrpc: '2.0',
        error: { code: -32602, message: 'Invalid params' },
        id: 1,
      })
    );
    vi.stubGlobal('fetch', fetchSpy);

    await expect(callPcpTool('bootstrap', { agentId: 'wren' })).rejects.toThrow(
      'PCP tool error (-32602): Invalid params'
    );
  });

  it('should throw on MCP tool-level isError responses', async () => {
    fetchSpy = vi.fn().mockResolvedValue(
      mockJsonResponse({
        jsonrpc: '2.0',
        result: {
          isError: true,
          content: [{ text: '{"success":false,"error":"start_session unavailable"}' }],
        },
        id: 1,
      })
    );
    vi.stubGlobal('fetch', fetchSpy);

    await expect(callPcpTool('start_session', { agentId: 'wren' })).rejects.toThrow(
      'PCP tool error: start_session unavailable'
    );
  });

  it('should handle content-type with charset suffix', async () => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
      json: async () => TOOL_RESULT_PAYLOAD,
      text: async () => JSON.stringify(TOOL_RESULT_PAYLOAD),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await callPcpTool('bootstrap', { agentId: 'wren' });
    expect(result).toEqual({ success: true });
  });

  it('should return raw text when MCP content is not valid JSON', async () => {
    fetchSpy = vi.fn().mockResolvedValue(
      mockJsonResponse({
        jsonrpc: '2.0',
        result: { content: [{ text: 'plain text result' }] },
        id: 1,
      })
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await callPcpTool('bootstrap', { agentId: 'wren' });
    expect(result).toEqual({ text: 'plain text result' });
  });

  it('retries with local auth fallback when injected env token is rejected (401)', async () => {
    process.env.PCP_ACCESS_TOKEN = 'env-token';
    mockedGetValidAccessToken
      .mockResolvedValueOnce('env-token')
      .mockResolvedValueOnce('fallback-token');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const firstResponseTextSpy = vi.fn().mockResolvedValue('unauthorized');

    fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: firstResponseTextSpy,
      })
      .mockResolvedValueOnce(mockJsonResponse(TOOL_RESULT_PAYLOAD));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await callPcpTool('bootstrap', { agentId: 'wren' });
    expect(result).toEqual({ success: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const [, firstOptions] = fetchSpy.mock.calls[0];
    const [, secondOptions] = fetchSpy.mock.calls[1];
    expect(firstOptions.headers).toHaveProperty('Authorization', 'Bearer env-token');
    expect(secondOptions.headers).toHaveProperty('Authorization', 'Bearer fallback-token');
    expect(
      mockedGetValidAccessToken.mock.calls.some(
        ([, options]) =>
          (options as { allowEnvToken?: boolean } | undefined)?.allowEnvToken === false
      )
    ).toBe(true);
    expect(firstResponseTextSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('does not retry on 401 when no env token is injected', async () => {
    mockedGetValidAccessToken.mockResolvedValue('file-token');
    fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => 'unauthorized',
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(callPcpTool('bootstrap', { agentId: 'wren' })).rejects.toThrow(
      'PCP call failed (401)'
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// buildIdentityBlock: identity file rendering (regression)
// ============================================================================

describe('buildIdentityBlock', () => {
  it('should render identity files from bootstrap response', () => {
    const bootstrap = {
      identityFiles: {
        self: '# IDENTITY.md - Wren\n\nI am Wren.',
        soul: '# SOUL.md\n\nI exist.',
        values: '# VALUES.md\n\nBe helpful.',
        process: '# PROCESS.md\n\nHow we work.',
        user: '# USER.md\n\nAbout the human.',
        heartbeat: '# HEARTBEAT.md\n\nSession management.',
      },
    };

    const result = buildIdentityBlock(bootstrap);

    // All identity files should be present
    expect(result).toContain('# IDENTITY.md - Wren');
    expect(result).toContain('# SOUL.md');
    expect(result).toContain('# VALUES.md');
    expect(result).toContain('# PROCESS.md');
    expect(result).toContain('# USER.md');
    expect(result).toContain('# HEARTBEAT.md');
  });

  it('should render files in correct order: self, soul, values, process, user, heartbeat', () => {
    const bootstrap = {
      identityFiles: {
        heartbeat: 'HEARTBEAT',
        user: 'USER',
        self: 'SELF',
        values: 'VALUES',
        soul: 'SOUL',
        process: 'PROCESS',
      },
    };

    const result = buildIdentityBlock(bootstrap);
    const selfIdx = result.indexOf('SELF');
    const soulIdx = result.indexOf('SOUL');
    const valuesIdx = result.indexOf('VALUES');
    const processIdx = result.indexOf('PROCESS');
    const userIdx = result.indexOf('USER');
    const heartbeatIdx = result.indexOf('HEARTBEAT');

    expect(selfIdx).toBeLessThan(soulIdx);
    expect(soulIdx).toBeLessThan(valuesIdx);
    expect(valuesIdx).toBeLessThan(processIdx);
    expect(processIdx).toBeLessThan(userIdx);
    expect(userIdx).toBeLessThan(heartbeatIdx);
  });

  it('should return empty string when identityFiles is missing', () => {
    expect(buildIdentityBlock({})).toBe('');
    expect(buildIdentityBlock({ someOtherField: 'data' })).toBe('');
  });

  it('should return empty string for null/undefined input', () => {
    expect(buildIdentityBlock(null as unknown as Record<string, unknown>)).toBe('');
    expect(buildIdentityBlock(undefined as unknown as Record<string, unknown>)).toBe('');
  });

  it('should handle partial identity files (some missing)', () => {
    const bootstrap = {
      identityFiles: {
        self: '# IDENTITY.md\n\nI am here.',
        soul: '# SOUL.md\n\nI exist.',
        // values, process, user, heartbeat missing
      },
    };

    const result = buildIdentityBlock(bootstrap);
    expect(result).toContain('# IDENTITY.md');
    expect(result).toContain('# SOUL.md');
    expect(result).not.toContain('VALUES');
  });

  it('should NOT render when passed bootstrap.identity (old broken field path)', () => {
    // Regression: the old code used bootstrap.identity which doesn't exist
    // on the bootstrap response. This ensures we catch if someone reverts
    // to the broken field path.
    const bootstrap = {
      identity: { name: 'Wren', role: 'dev' },
      identityFiles: {
        self: '# IDENTITY.md\n\nReal content',
      },
    };

    // buildIdentityBlock receives the full bootstrap object,
    // and should read identityFiles, not identity
    const result = buildIdentityBlock(bootstrap);
    expect(result).toContain('# IDENTITY.md');
    expect(result).not.toContain('"name"');
    expect(result).not.toContain('JSON');
  });

  it('should separate files with horizontal rules', () => {
    const bootstrap = {
      identityFiles: {
        self: 'SELF',
        soul: 'SOUL',
      },
    };

    const result = buildIdentityBlock(bootstrap);
    expect(result).toContain('---');
  });
});
