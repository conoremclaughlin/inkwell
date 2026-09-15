import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/tokens.js', () => ({
  getValidAccessToken: vi.fn(),
}));

import * as tokensMod from '../auth/tokens.js';
import { callPcpTool } from './pcp-mcp.js';

const mockedGetValidAccessToken = vi.mocked(tokensMod.getValidAccessToken);

function mockJsonResponse(payload: Record<string, unknown>): Partial<Response> {
  return {
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

describe('pcp-mcp callPcpTool', () => {
  const originalServerUrl = process.env.INK_SERVER_URL;

  beforeEach(() => {
    process.env.INK_SERVER_URL = 'http://localhost:3999';
    mockedGetValidAccessToken.mockResolvedValue(null);
  });

  afterEach(() => {
    process.env.INK_SERVER_URL = originalServerUrl;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('calls the MCP JSON-RPC endpoint (/mcp), not legacy /api/mcp/call', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      mockJsonResponse({
        jsonrpc: '2.0',
        result: { content: [{ text: '{"success":true}' }] },
        id: 1,
      })
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await callPcpTool<{ success: boolean }>('list_sessions', { limit: 1 });

    expect(result).toEqual({ success: true });
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:3999/mcp');
    expect(String(url)).not.toContain('/api/mcp/call');

    const body = JSON.parse(options.body as string) as {
      method: string;
      params: { name: string; arguments: Record<string, unknown> };
    };
    expect(body.method).toBe('tools/call');
    expect(body.params.name).toBe('list_sessions');
    expect(body.params.arguments).toEqual({ limit: 1 });
  });

  it('parses streamable SSE payloads using the final data line', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      text: async () =>
        [
          'event: message',
          'data: {"jsonrpc":"2.0","result":{"content":[{"text":"{\\"partial\\":true}"}]},"id":1}',
          '',
          'event: message',
          'data: {"jsonrpc":"2.0","result":{"content":[{"text":"{\\"final\\":true}"}]},"id":1}',
          '',
        ].join('\n'),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await callPcpTool<{ final: boolean }>('bootstrap', { sbSlug: 'lumen' });
    expect(result).toEqual({ final: true });
  });

  it('attaches auth token when available', async () => {
    mockedGetValidAccessToken.mockResolvedValue('jwt-token');
    const fetchSpy = vi.fn().mockResolvedValue(
      mockJsonResponse({
        jsonrpc: '2.0',
        result: { content: [{ text: '{"ok":true}' }] },
        id: 1,
      })
    );
    vi.stubGlobal('fetch', fetchSpy);

    await callPcpTool('bootstrap', { sbSlug: 'lumen' });

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers).toMatchObject({
      Authorization: 'Bearer jwt-token',
      Accept: 'application/json, text/event-stream',
    });
  });

  it('throws when MCP tool response is marked as isError', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
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

    await expect(callPcpTool('start_session', { forceNew: true })).rejects.toThrow(
      'PCP tool error: start_session unavailable'
    );
  });

  it('sets caller profile header when provided', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      mockJsonResponse({
        jsonrpc: '2.0',
        result: { content: [{ text: '{"ok":true}' }] },
        id: 1,
      })
    );
    vi.stubGlobal('fetch', fetchSpy);

    await callPcpTool('start_session', { forceNew: true }, { callerProfile: 'runtime' });

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers).toMatchObject({
      'x-ink-caller-profile': 'runtime',
    });
  });

  it('reports fetch failures with PCP url and network diagnostics', async () => {
    const fetchError = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3999'), {
        code: 'ECONNREFUSED',
        address: '127.0.0.1',
        port: 3999,
      }),
    });
    const fetchSpy = vi.fn().mockRejectedValue(fetchError);
    vi.stubGlobal('fetch', fetchSpy);

    await expect(callPcpTool('list_sessions', { limit: 1 })).rejects.toThrow(
      'PCP fetch failed for http://localhost:3999/mcp'
    );
    await expect(callPcpTool('list_sessions', { limit: 1 })).rejects.toThrow('ECONNREFUSED');
    await expect(callPcpTool('list_sessions', { limit: 1 })).rejects.toThrow(
      'Ensure PCP server is running and INK_SERVER_URL is correct.'
    );
  });
});
