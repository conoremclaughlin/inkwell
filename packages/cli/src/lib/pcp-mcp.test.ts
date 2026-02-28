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
  const originalServerUrl = process.env.PCP_SERVER_URL;

  beforeEach(() => {
    process.env.PCP_SERVER_URL = 'http://localhost:3999';
    mockedGetValidAccessToken.mockResolvedValue(null);
  });

  afterEach(() => {
    process.env.PCP_SERVER_URL = originalServerUrl;
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

    const result = await callPcpTool<{ final: boolean }>('bootstrap', { agentId: 'lumen' });
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

    await callPcpTool('bootstrap', { agentId: 'lumen' });

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers).toMatchObject({
      Authorization: 'Bearer jwt-token',
      Accept: 'application/json, text/event-stream',
    });
  });
});
