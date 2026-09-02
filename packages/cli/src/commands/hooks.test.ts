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
import {
  handleFailedTakeover,
  getBackendByName,
  installHooks,
  callPcpTool,
  buildIdentityBlock,
  buildMemoriesBlock,
  serverAlreadyInjectedContext,
  hydrateThreadKeyFromServer,
  loadApprovalSet,
  matchesApprovalSet,
  isHeadlessSession,
} from './hooks.js';

const TEST_DIR = join(tmpdir(), 'ink-hooks-test-' + Date.now());

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

    // Commands may be absolute paths (e.g., /path/to/node_modules/.bin/ink hooks ...)
    // or bare `ink hooks ...` depending on whether node_modules/.bin/ink exists

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
      hooks: [{ type: 'command', command: 'ink hooks extra' }],
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
    // SessionStart: startup matcher only (PreCompress/postCompact disabled —
    // Gemini has no post-compression SessionStart event)
    expect(config.hooks.SessionStart).toHaveLength(1);
    expect(config.hooks.SessionStart[0].matcher).toBe('startup');
    expect(config.hooks.SessionStart[0].hooks[0].command).toContain('hooks on-session-start');
    expect(config.hooks.BeforeAgent[0].hooks[0].command).toContain('hooks on-prompt');
    expect(config.hooks.AfterAgent[0].hooks[0].command).toContain('hooks on-stop');
    expect(config.hooks.PreCompress).toBeUndefined();
  });

  it('should preserve existing Gemini settings', () => {
    const configDir = join(TEST_DIR, '.gemini');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ mcpServers: { inkwell: { url: 'http://localhost:3001/mcp' } } })
    );

    installHooks(TEST_DIR, { backend: 'gemini' });

    const config = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf-8'));
    expect(config.mcpServers.inkwell.url).toBe('http://localhost:3001/mcp');
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
    expect(content).toContain('# ink-managed:hooks:start');
    expect(content).toContain('[hooks]');
    expect(content).toMatch(/session_start = ".*hooks on-session-start[^"]*"/);
    expect(content).toMatch(/session_end = ".*hooks on-stop[^"]*"/);
    expect(content).toMatch(/user_prompt = ".*hooks on-prompt[^"]*"/);
    expect(content).toContain('# ink-managed:hooks:end');
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
        '# ink-managed:start mcp_servers',
        '[mcp_servers.inkwell]',
        'url = "http://localhost:3001/mcp"',
        '# ink-managed:end mcp_servers',
        '',
      ].join('\n')
    );

    const { result } = installHooks(TEST_DIR, { backend: 'codex' });
    expect(result).toBe('installed');

    const content = readFileSync(join(configDir, 'config.toml'), 'utf-8');
    expect(content).toContain('# ink-managed:start mcp_servers');
    expect(content).toContain('# ink-managed:hooks:start');
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
      '[mcp_servers.inkwell]\nurl = "http://localhost:3001/mcp"\n'
    );

    installHooks(TEST_DIR, { backend: 'codex' });

    const content = readFileSync(join(configDir, 'config.toml'), 'utf-8');
    expect(content).toContain('[mcp_servers.inkwell]');
    expect(content).toContain('# ink-managed:hooks:start');
  });

  it('should replace PCP section on re-install with force', () => {
    installHooks(TEST_DIR, { backend: 'codex' });

    // Force re-install
    const { result } = installHooks(TEST_DIR, { backend: 'codex', force: true });
    expect(result).toBe('installed');

    // Should have exactly one start marker and one end marker (no duplicates)
    const content = readFileSync(join(TEST_DIR, '.codex', 'config.toml'), 'utf-8');
    const startMarkers = content.match(/# ink-managed:hooks:start/g);
    const endMarkers = content.match(/# ink-managed:hooks:end/g);
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
  getValidDelegatedAccessToken: vi.fn(),
  loadAuth: vi.fn(),
  isTokenExpired: vi.fn(),
  decodeJwtPayload: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
import * as tokensMod from '../auth/tokens.js';
const mockedGetValidAccessToken = vi.mocked(tokensMod.getValidAccessToken);
const mockedGetValidDelegatedAccessToken = vi.mocked(tokensMod.getValidDelegatedAccessToken);

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
    mockedGetValidAccessToken.mockReset();
    mockedGetValidAccessToken.mockResolvedValue('token');
    mockedGetValidDelegatedAccessToken.mockReset();
    mockedGetValidDelegatedAccessToken.mockReturnValue(null);
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

  it('should prefer delegated token and include x-ink-agent-id header when available', async () => {
    mockedGetValidDelegatedAccessToken.mockReturnValue('delegated-jwt-token');
    mockedGetValidAccessToken.mockResolvedValue('fallback-token');

    await callPcpTool('bootstrap', { agentId: 'wren' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers).toHaveProperty('Authorization', 'Bearer delegated-jwt-token');
    expect(options.headers).toHaveProperty('x-ink-agent-id', 'wren');
    expect(mockedGetValidAccessToken).not.toHaveBeenCalled();
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

  // ── INK_SESSION_ID propagation through callPcpTool ──
  // This is the most fragile link: hooks must forward INK_SESSION_ID as
  // x-ink-session-id header so the MCP server can resolve studio scope.

  it('should send x-ink-session-id header when INK_SESSION_ID env is set', async () => {
    mockedGetValidAccessToken.mockResolvedValue('token');
    process.env.INK_SESSION_ID = 'session-xyz-789';

    await callPcpTool('get_session', { sessionId: 'session-xyz-789' });

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers).toHaveProperty('x-ink-session-id', 'session-xyz-789');

    delete process.env.INK_SESSION_ID;
  });

  it('should NOT send x-ink-session-id header when INK_SESSION_ID env is absent', async () => {
    mockedGetValidAccessToken.mockResolvedValue('token');
    delete process.env.INK_SESSION_ID;

    await callPcpTool('bootstrap', { agentId: 'wren' });

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers).not.toHaveProperty('x-ink-session-id');
  });

  it('should trim INK_SESSION_ID whitespace before sending as header', async () => {
    mockedGetValidAccessToken.mockResolvedValue('token');
    process.env.INK_SESSION_ID = '  session-with-spaces  ';

    await callPcpTool('bootstrap', { agentId: 'wren' });

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers).toHaveProperty('x-ink-session-id', 'session-with-spaces');

    delete process.env.INK_SESSION_ID;
  });

  it('should NOT send x-ink-session-id for empty/whitespace-only INK_SESSION_ID', async () => {
    mockedGetValidAccessToken.mockResolvedValue('token');
    process.env.INK_SESSION_ID = '   ';

    await callPcpTool('bootstrap', { agentId: 'wren' });

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers).not.toHaveProperty('x-ink-session-id');

    delete process.env.INK_SESSION_ID;
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
    mockedGetValidDelegatedAccessToken.mockReset();
    mockedGetValidDelegatedAccessToken.mockReturnValue(null);
    mockedGetValidAccessToken.mockReset();
    mockedGetValidAccessToken.mockResolvedValue('token');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.INK_ACCESS_TOKEN;
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
      'Inkwell SSE response contained no data lines'
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
      'Inkwell call failed (406)'
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
      'Inkwell tool error (-32001): Authentication required'
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
      'Inkwell tool error (-32602): Invalid params'
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
      'Inkwell tool error: start_session unavailable'
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
    process.env.INK_ACCESS_TOKEN = 'env-token';
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

  it('retries with base token and skips delegated token after delegated 401', async () => {
    process.env.INK_ACCESS_TOKEN = 'env-token';
    mockedGetValidDelegatedAccessToken.mockReturnValue('delegated-token');
    mockedGetValidAccessToken.mockResolvedValueOnce('fallback-token');

    fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => 'delegated unauthorized',
      })
      .mockResolvedValueOnce(mockJsonResponse(TOOL_RESULT_PAYLOAD));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await callPcpTool('bootstrap', { agentId: 'wren' });
    expect(result).toEqual({ success: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const [, firstOptions] = fetchSpy.mock.calls[0];
    const [, secondOptions] = fetchSpy.mock.calls[1];
    expect(firstOptions.headers).toHaveProperty('Authorization', 'Bearer delegated-token');
    expect(secondOptions.headers).toHaveProperty('Authorization', 'Bearer fallback-token');

    expect(mockedGetValidDelegatedAccessToken).toHaveBeenCalledTimes(1);
    expect(
      mockedGetValidAccessToken.mock.calls.some(
        ([, options]) =>
          (options as { allowEnvToken?: boolean } | undefined)?.allowEnvToken === false
      )
    ).toBe(true);
  });

  it('retries delegated 401 even without injected env token', async () => {
    mockedGetValidDelegatedAccessToken.mockReturnValue('delegated-token');
    mockedGetValidAccessToken.mockResolvedValueOnce('file-token');

    fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => 'delegated unauthorized',
      })
      .mockResolvedValueOnce(mockJsonResponse(TOOL_RESULT_PAYLOAD));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await callPcpTool('bootstrap', { agentId: 'wren' });
    expect(result).toEqual({ success: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
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
      'Inkwell call failed (401)'
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// hydrateThreadKeyFromServer: triggered-session thread key (regression)
//
// Triggered sessions arrive with INK_SESSION_ID pre-set, so start_session is
// skipped and the thread key is never populated locally. These tests pin the
// server-hydration path that keeps activeThreadKey from staying null for
// exactly the PR/spec sessions the feature targets (PR #373 review blocker).
// ============================================================================

describe('hydrateThreadKeyFromServer', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  function mockGetSessionResponse(session: Record<string, unknown>) {
    return mockJsonResponse({
      jsonrpc: '2.0',
      result: { content: [{ text: JSON.stringify({ session }) }] },
      id: 1,
    });
  }

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    mockedGetValidAccessToken.mockReset();
    mockedGetValidAccessToken.mockResolvedValue('token');
    mockedGetValidDelegatedAccessToken.mockReset();
    mockedGetValidDelegatedAccessToken.mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('should hydrate activeThreadKey from get_session for a pre-created session (trigger path)', async () => {
    fetchSpy.mockResolvedValue(
      mockGetSessionResponse({ id: 'sess-triggered', activeThreadKey: 'pr:373' })
    );

    const threadKey = await hydrateThreadKeyFromServer('sess-triggered', undefined, 'me@test.dev');

    expect(threadKey).toBe('pr:373');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.params.name).toBe('get_session');
    expect(body.params.arguments).toMatchObject({ sessionId: 'sess-triggered' });
  });

  it('should fall back to threadKey field when activeThreadKey is absent', async () => {
    fetchSpy.mockResolvedValue(
      mockGetSessionResponse({ id: 'sess-triggered', threadKey: 'spec:cli-session-hooks' })
    );

    const threadKey = await hydrateThreadKeyFromServer('sess-triggered', undefined);

    expect(threadKey).toBe('spec:cli-session-hooks');
  });

  it('should keep the local threadKey without a server call when already hydrated', async () => {
    const threadKey = await hydrateThreadKeyFromServer('sess-1', 'pr:100');

    expect(threadKey).toBe('pr:100');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should return undefined without a server call when no session id is available', async () => {
    const threadKey = await hydrateThreadKeyFromServer(undefined, undefined);

    expect(threadKey).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should return undefined when the session has no thread key', async () => {
    fetchSpy.mockResolvedValue(mockGetSessionResponse({ id: 'sess-plain' }));

    const threadKey = await hydrateThreadKeyFromServer('sess-plain', undefined);

    expect(threadKey).toBeUndefined();
  });

  it('should be non-fatal when the server call fails', async () => {
    fetchSpy.mockRejectedValue(new Error('connection refused'));

    const threadKey = await hydrateThreadKeyFromServer('sess-1', undefined);

    expect(threadKey).toBeUndefined();
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

// ============================================================================
// 2FA approval set — pattern matching for on-tool-approval hook
// ============================================================================

describe('loadApprovalSet', () => {
  it('returns empty array when settings file is missing', () => {
    expect(loadApprovalSet(TEST_DIR)).toEqual([]);
  });

  it('returns permissions.approvalRequired array from settings.local.json', () => {
    const configDir = join(TEST_DIR, '.claude');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'settings.local.json'),
      JSON.stringify({
        permissions: {
          approvalRequired: ['Bash(docker push *)', 'mcp__supabase__apply_migration'],
        },
      })
    );
    expect(loadApprovalSet(TEST_DIR)).toEqual([
      'Bash(docker push *)',
      'mcp__supabase__apply_migration',
    ]);
  });

  it('falls back to top-level approvalRequired for backcompat', () => {
    const configDir = join(TEST_DIR, '.claude');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'settings.local.json'),
      JSON.stringify({
        approvalRequired: ['Bash(docker push *)'],
      })
    );
    expect(loadApprovalSet(TEST_DIR)).toEqual(['Bash(docker push *)']);
  });

  it('returns empty array when approvalRequired key is absent', () => {
    const configDir = join(TEST_DIR, '.claude');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'settings.local.json'),
      JSON.stringify({ permissions: { allow: [] } })
    );
    expect(loadApprovalSet(TEST_DIR)).toEqual([]);
  });

  it('returns empty array when settings.local.json is malformed', () => {
    const configDir = join(TEST_DIR, '.claude');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'settings.local.json'), '{ not json');
    expect(loadApprovalSet(TEST_DIR)).toEqual([]);
  });
});

describe('matchesApprovalSet', () => {
  it('returns false for empty pattern set', () => {
    expect(matchesApprovalSet('Bash', 'ls', [])).toBe(false);
  });

  it('returns false when tool name is not in pattern set', () => {
    expect(matchesApprovalSet('Read', '/tmp/x', ['Bash(docker push *)'])).toBe(false);
  });

  it('matches a bare tool name exactly', () => {
    expect(
      matchesApprovalSet('mcp__supabase__apply_migration', '{}', ['mcp__supabase__apply_migration'])
    ).toBe(true);
  });

  it('does not match a different bare tool name', () => {
    expect(
      matchesApprovalSet('mcp__supabase__execute_sql', '{}', ['mcp__supabase__apply_migration'])
    ).toBe(false);
  });

  it('matches glob pattern "Bash(docker push *)" against a docker push command', () => {
    expect(matchesApprovalSet('Bash', 'docker push registry/app', ['Bash(docker push *)'])).toBe(
      true
    );
  });

  it('does not match "Bash(docker push *)" against a git push command', () => {
    expect(matchesApprovalSet('Bash', 'git push origin main', ['Bash(docker push *)'])).toBe(false);
  });

  it('escapes regex special characters in args pattern', () => {
    // Pattern contains regex-special chars (dots, parens) that must be literal
    expect(
      matchesApprovalSet('Bash', 'curl https://example.com/api', ['Bash(curl https://*)'])
    ).toBe(true);
  });

  it('checks all patterns in the list (first match wins)', () => {
    const patterns = ['Read', 'Bash(rm -rf *)', 'mcp__supabase__apply_migration'];
    expect(matchesApprovalSet('Bash', 'rm -rf /', patterns)).toBe(true);
    expect(matchesApprovalSet('mcp__supabase__apply_migration', '{}', patterns)).toBe(true);
    expect(matchesApprovalSet('Write', 'hello', patterns)).toBe(false);
  });

  it('requires full-match on args pattern (anchored)', () => {
    // Pattern "Bash(ls)" should NOT match "ls -la" because it's anchored
    expect(matchesApprovalSet('Bash', 'ls -la', ['Bash(ls)'])).toBe(false);
    expect(matchesApprovalSet('Bash', 'ls', ['Bash(ls)'])).toBe(true);
  });
});

// =====================================================
// isHeadlessSession — CLI-attached vs headless spawn
// =====================================================

describe('isHeadlessSession', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns false when INK_CONTEXT is not set (interactive session)', () => {
    delete process.env.INK_CONTEXT;
    expect(isHeadlessSession()).toBe(false);
  });

  it('returns true when INK_CONTEXT has cliAttached=false (headless spawn)', () => {
    const token = {
      sessionId: 's1',
      agentId: 'wren',
      studioId: 'x',
      cliAttached: false,
      runtime: 'claude',
    };
    process.env.INK_CONTEXT = Buffer.from(JSON.stringify(token)).toString('base64url');
    expect(isHeadlessSession()).toBe(true);
  });

  it('returns false when INK_CONTEXT has cliAttached=true', () => {
    const token = {
      sessionId: 's1',
      agentId: 'wren',
      studioId: 'x',
      cliAttached: true,
      runtime: 'claude',
    };
    process.env.INK_CONTEXT = Buffer.from(JSON.stringify(token)).toString('base64url');
    expect(isHeadlessSession()).toBe(false);
  });

  it('returns false when INK_CONTEXT is malformed', () => {
    process.env.INK_CONTEXT = 'not-valid-base64url-json!!!';
    expect(isHeadlessSession()).toBe(false);
  });

  it('returns false when INK_CONTEXT is empty string', () => {
    process.env.INK_CONTEXT = '';
    expect(isHeadlessSession()).toBe(false);
  });

  it('returns false when cliAttached is missing from token', () => {
    const token = { sessionId: 's1', agentId: 'wren', studioId: 'x', runtime: 'claude' };
    process.env.INK_CONTEXT = Buffer.from(JSON.stringify(token)).toString('base64url');
    expect(isHeadlessSession()).toBe(false);
  });
});

// ============================================================================
// buildMemoriesBlock: bootstrap returns `knowledgeSummary`, not `recentMemories`
// ============================================================================

describe('buildMemoriesBlock', () => {
  it('renders the knowledgeSummary bootstrap actually returns', () => {
    const result = buildMemoriesBlock({
      knowledgeSummary: '## project:inkwell\n- [critical] Never squash merge.',
    });

    expect(result).toContain('Never squash merge.');
  });

  it('does not depend on `recentMemories`, which bootstrap never sends', () => {
    // The whole bug: both hooks read this key, got undefined, and silently
    // injected an empty memory block into every session they touched.
    const result = buildMemoriesBlock({
      knowledgeSummary: 'KNOWN-FACT',
      activeSessions: [],
    });

    expect(result).not.toBe('');
    expect(result).toContain('KNOWN-FACT');
  });

  it('keeps working against an older server that still sends an array', () => {
    const result = buildMemoriesBlock({
      recentMemories: [
        { content: 'legacy-one', salience: 'critical' },
        { content: 'legacy-two', salience: 'high' },
      ],
    });

    expect(result).toContain('[critical] legacy-one');
    expect(result).toContain('[high] legacy-two');
  });

  it('does not truncate a long array to five entries', () => {
    const result = buildMemoriesBlock({
      recentMemories: Array.from({ length: 9 }, (_, i) => ({
        content: `mem-${i}`,
        salience: 'critical',
      })),
    });

    expect(result).toContain('mem-8');
  });

  it('returns empty when there is genuinely nothing to say', () => {
    expect(buildMemoriesBlock({})).toBe('');
    expect(buildMemoriesBlock({ knowledgeSummary: '   ' })).toBe('');
  });
});

// ============================================================================
// serverAlreadyInjectedContext: the runner/hook handshake
// ============================================================================

describe('serverAlreadyInjectedContext', () => {
  it('is true only for the exact flag the runners set', () => {
    expect(serverAlreadyInjectedContext({ INK_CONSTITUTION_INJECTED: '1' })).toBe(true);
  });

  it('is false when absent, so a CLI session still loads its own constitution', () => {
    expect(serverAlreadyInjectedContext({})).toBe(false);
  });

  it('does not treat other truthy-looking values as set', () => {
    expect(serverAlreadyInjectedContext({ INK_CONSTITUTION_INJECTED: '0' })).toBe(false);
    expect(serverAlreadyInjectedContext({ INK_CONSTITUTION_INJECTED: 'true' })).toBe(false);
    expect(serverAlreadyInjectedContext({ INK_CONSTITUTION_INJECTED: '' })).toBe(false);
  });
});

/**
 * Round 7 (PR #563, Lumen): the round-6 blocking branch compared against
 * 'claude' while the backend is NAMED 'claude-code' — it never fired, and
 * only a behavioural test would have caught it. So: behavioural tests, on
 * the capability flag, both directions.
 */
describe('handleFailedTakeover', () => {
  it('the REAL claude-code capability blocks — not an inline stand-in', () => {
    // Round 7 meta-lesson: the first behavioural tests used inline capability
    // objects, so flipping the real constant's flag kept everything green —
    // the same unbound-wiring shape as the name-comparison bug they were
    // written to prevent. This one goes through the actual registry.
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });
    expect(() =>
      handleFailedTakeover(getBackendByName('claude-code'), {
        agentId: 'wren',
        writePendingTakeover: vi.fn(),
        exit: exit as never,
      })
    ).toThrow('exit:2');
    expect(getBackendByName('codex').blocksOnFailedTakeover).toBe(false);
    expect(getBackendByName('gemini').blocksOnFailedTakeover).toBe(false);
  });

  it('BLOCKS the prompt on a blocking-capable backend, writing no marker', () => {
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });
    const writePendingTakeover = vi.fn();

    expect(() =>
      handleFailedTakeover(
        { name: 'claude-code', blocksOnFailedTakeover: true },
        { agentId: 'wren', writePendingTakeover, exit: exit as never }
      )
    ).toThrow('exit:2');
    expect(writePendingTakeover).not.toHaveBeenCalled();
  });

  it('writes the durable marker on a non-blocking backend — no in-process timer', () => {
    // Round 8 (Lumen): this hook process is short-lived; an unref()'d timer
    // dies with it. The durable artefact is the marker the channel plugin
    // converts into a claim on its poll loop.
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });
    const writePendingTakeover = vi.fn();

    handleFailedTakeover(
      { name: 'codex', blocksOnFailedTakeover: false },
      { agentId: 'wren', writePendingTakeover, exit: exit as never }
    );

    expect(exit).not.toHaveBeenCalled();
    expect(writePendingTakeover).toHaveBeenCalledTimes(1);
  });

  it('a marker write failure is swallowed — the prompt itself must not break', () => {
    expect(() =>
      handleFailedTakeover(
        { name: 'gemini', blocksOnFailedTakeover: false },
        {
          agentId: 'wren',
          writePendingTakeover: () => {
            throw new Error('disk full');
          },
        }
      )
    ).not.toThrow();
  });
});

/**
 * Round 10 (Lumen): the stop must identify the epoch it is ending. The
 * prompt claim's response carries the fresh epoch; the on-prompt hook
 * persists it (own session only), and the on-stop hook sends it with the
 * stop event and clears only its own record. The handlers are not exported,
 * so the threading is pinned in source order; the record helpers themselves
 * are behaviorally tested in lib/takeover-watcher.test.ts.
 */
describe('CLI turn-epoch round-trip (round 10)', () => {
  const loadSource = async () => {
    const { readFileSync } = await import('fs');
    const { dirname, join } = await import('path');
    const { fileURLToPath } = await import('url');
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'hooks.ts'), 'utf-8');
  };

  it('a successful non-headless takeover persists the claimed epoch', async () => {
    const source = await loadSource();
    const success = source.indexOf('} else if (takeoverOk && !isHeadlessSpawn) {');
    const write = source.indexOf('writeCliTurnEpoch(cwd, {', success);
    const nextFn = source.indexOf('async function', success);
    expect(success).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(success);
    expect(nextFn === -1 || write < nextFn).toBe(true);
  });

  it('the stop sends its OWN session record and clears it — foreign records untouched', async () => {
    const source = await loadSource();
    const stop = source.indexOf('async function onStopHandler(');
    const read = source.indexOf('readCliTurnEpoch(cwd)', stop);
    const scoped = source.indexOf(
      'const stopEpoch = adjudicatedEpoch ?? (recordIsOurs ? epochRecord?.turnEpoch : undefined);',
      stop
    );
    const sent = source.indexOf('turnEpoch: stopEpoch', stop);
    const cleared = source.indexOf('clearCliTurnEpoch(cwd, stopSessionId, {', stop);
    // Round 19: the record must match OUR wrapper generation, and the clear
    // is compare-and-delete on the exact record we sent.
    const genGuard = source.indexOf(
      '(epochRecord.wrapperGeneration ?? undefined) === (stopGeneration ?? undefined)',
      stop
    );
    expect(genGuard).toBeGreaterThan(stop);
    expect(stop).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(stop);
    expect(scoped).toBeGreaterThan(stop);
    expect(sent).toBeGreaterThan(scoped);
    expect(cleared).toBeGreaterThan(sent);
  });

  it('updateRuntimeGenerationState forwards the stop epoch in the request body', async () => {
    const source = await loadSource();
    const fn = source.indexOf('async function updateRuntimeGenerationState(');
    const body = source.indexOf('...(opts?.turnEpoch ? { turnEpoch: opts.turnEpoch } : {})', fn);
    const parsed = source.indexOf("typeof body?.turnEpoch === 'string'", fn);
    expect(fn).toBeGreaterThan(-1);
    expect(body).toBeGreaterThan(fn);
    // ...and surfaces the claimed epoch from a 2xx response.
    expect(parsed).toBeGreaterThan(fn);
  });
});

/**
 * Round 11 (Lumen): the prompt names its studio and treats a NOT-HELD lease
 * report as an unacknowledged takeover (no retry — the lease is gone, not
 * flaky); a lost epoch record is loud and the stop admits it instead of
 * downgrading to legacy unfenced behavior.
 */
describe('lease acknowledgement and fail-closed degradation (round 11)', () => {
  const loadSource = async () => {
    const { readFileSync } = await import('fs');
    const { dirname, join } = await import('path');
    const { fileURLToPath } = await import('url');
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'hooks.ts'), 'utf-8');
  };

  it('the prompt carries the studio for the exact-CAS held report', async () => {
    const source = await loadSource();
    const prompt = source.indexOf('async function onPromptHandler(');
    const resolved = source.indexOf(
      'const { studioId: promptStudioId } = getIdentitySessionContext(cwd);',
      prompt
    );
    const sent = source.indexOf('studioId: promptStudioId', resolved);
    expect(prompt).toBeGreaterThan(-1);
    expect(resolved).toBeGreaterThan(prompt);
    expect(sent).toBeGreaterThan(resolved);
  });

  it('a NOT-HELD lease report is ok:false with NO retry — inside the update loop', async () => {
    const source = await loadSource();
    const fn = source.indexOf('async function updateRuntimeGenerationState(');
    const check = source.indexOf('if (body?.studioLeaseHeld === false) {', fn);
    const refuse = source.indexOf('return { ok: false };', check);
    const okReturn = source.indexOf('ok: true,', check);
    expect(fn).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(fn);
    // The refusal comes BEFORE the success return — a 2xx alone never wins.
    expect(refuse).toBeGreaterThan(check);
    expect(refuse).toBeLessThan(okReturn);
  });

  it('a lost epoch record is loud at prompt, and the stop admits it (fail closed downstream)', async () => {
    const source = await loadSource();
    const record = source.indexOf('const recorded = writeCliTurnEpoch(cwd, {');
    const loud = source.indexOf("hookLog('on_prompt_epoch_record_failed'", record);
    expect(record).toBeGreaterThan(-1);
    expect(loud).toBeGreaterThan(record);

    const stop = source.indexOf('async function onStopHandler(');
    const admit = source.indexOf('turnEpochMissing: true,', stop);
    // Round 20: the missing admission is SCOPED to our own generation.
    const admitScope = source.indexOf('fenceAttempts: abandonedAttempts', stop);
    expect(admitScope).toBeGreaterThan(stop);
    expect(admit).toBeGreaterThan(stop);
  });
});

describe('stop-time marker adjudication (round 21)', () => {
  it('the stop RECLAIMS a standing own marker before closing, and fences a refused attempt', async () => {
    const { readFileSync } = await import('fs');
    const { dirname, join } = await import('path');
    const { fileURLToPath } = await import('url');
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'hooks.ts'), 'utf-8');
    const stop = source.indexOf('async function onStopHandler(');
    // The adjudication: read own marker → reclaim with its birth time and
    // attempt token → claimed epoch closes the turn; refused attempt joins
    // the fence. This is what closes the short-turn escape — fs.watch is
    // lossy and this hook CAN await.
    const adjudicate = source.indexOf(
      'const ownMarkerPath = pendingTakeoverMarkerPath(cwd, stopGeneration);',
      stop
    );
    const reclaim = source.indexOf('reclaimOf: rawMarker.at', adjudicate);
    const attempt = source.indexOf('attemptId: rawMarker.attemptId', adjudicate);
    const use = source.indexOf('adjudicatedEpoch = reclaim.turnEpoch', adjudicate);
    const fence = source.indexOf('abandonedAttempts.push(rawMarker.attemptId)', adjudicate);
    expect(adjudicate).toBeGreaterThan(stop);
    expect(reclaim).toBeGreaterThan(adjudicate);
    expect(attempt).toBeGreaterThan(adjudicate);
    expect(use).toBeGreaterThan(adjudicate);
    expect(fence).toBeGreaterThan(adjudicate);
    // No blind early unlink remains before the adjudication.
    const early = source.slice(stop, adjudicate);
    expect(early.includes('rmSync(pendingTakeoverMarkerPath')).toBe(false);
  });

  it('the marker carries a fresh attempt token', async () => {
    const { readFileSync } = await import('fs');
    const { dirname, join } = await import('path');
    const { fileURLToPath } = await import('url');
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'hooks.ts'), 'utf-8');
    const marker = source.indexOf(
      'const markerPath = pendingTakeoverMarkerPath(cwd, process.env.INK_RUNTIME_LINK_ID);'
    );
    const token = source.indexOf('attemptId: randomUUID()', marker);
    expect(marker).toBeGreaterThan(-1);
    expect(token).toBeGreaterThan(marker);
  });

  it('a 409 reclaim refusal never retries', async () => {
    const { readFileSync } = await import('fs');
    const { dirname, join } = await import('path');
    const { fileURLToPath } = await import('url');
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'hooks.ts'), 'utf-8');
    const fn = source.indexOf('async function updateRuntimeGenerationState(');
    const refuse = source.indexOf('if (resp.status === 409) {', fn);
    const okBranch = source.indexOf('if (resp.ok) {', fn);
    expect(refuse).toBeGreaterThan(fn);
    expect(refuse).toBeLessThan(okBranch);
  });
});

describe('acknowledged stops and lease-bounded adjudication (round 22)', () => {
  const loadSource = async () => {
    const { readFileSync } = await import('fs');
    const { dirname, join } = await import('path');
    const { fileURLToPath } = await import('url');
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'hooks.ts'), 'utf-8');
  };

  it('the adjudicating reclaim names the STUDIO — the lease boundary applies at stop too', async () => {
    const source = await loadSource();
    const stop = source.indexOf('async function onStopHandler(');
    const studio = source.indexOf('studioId: stopStudioId', stop);
    expect(studio).toBeGreaterThan(stop);
  });

  it('local evidence is deleted only after the stop is ACKNOWLEDGED', async () => {
    const source = await loadSource();
    const stop = source.indexOf('async function onStopHandler(');
    const result = source.indexOf('const stopResult = await updateRuntimeGenerationState', stop);
    const ackBranch = source.indexOf('if (stopResult.ok) {', result);
    const unlink = source.indexOf('rmSync(ownMarkerPath, { force: true });', ackBranch);
    const persist = source.indexOf('writeCliTurnEpoch(cwd, {', ackBranch);
    expect(result).toBeGreaterThan(stop);
    expect(ackBranch).toBeGreaterThan(result);
    // The unlink lives INSIDE the acknowledged branch...
    expect(unlink).toBeGreaterThan(ackBranch);
    // ...and an unacknowledged stop PERSISTS the committed epoch instead.
    expect(persist).toBeGreaterThan(ackBranch);
    // No unlink of the own marker anywhere before the stop result exists.
    expect(source.slice(stop, result).includes('rmSync(ownMarkerPath')).toBe(false);
  });
});

describe('wrapper generation binding (round 18)', () => {
  it('the marker and epoch record both carry INK_RUNTIME_LINK_ID', async () => {
    const { readFileSync } = await import('fs');
    const { dirname, join } = await import('path');
    const { fileURLToPath } = await import('url');
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'hooks.ts'), 'utf-8');

    const marker = source.indexOf(
      'const markerPath = pendingTakeoverMarkerPath(cwd, process.env.INK_RUNTIME_LINK_ID);'
    );
    const markerGen = source.indexOf('wrapperGeneration: process.env.INK_RUNTIME_LINK_ID', marker);
    expect(marker).toBeGreaterThan(-1);
    expect(markerGen).toBeGreaterThan(marker);

    const record = source.indexOf('const recorded = writeCliTurnEpoch(cwd, {');
    const recordGen = source.indexOf('wrapperGeneration: process.env.INK_RUNTIME_LINK_ID', record);
    expect(record).toBeGreaterThan(-1);
    expect(recordGen).toBeGreaterThan(record);
  });
});
