import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/tokens.js', () => ({
  getValidAccessToken: vi.fn(),
}));

import * as tokensMod from '../auth/tokens.js';
import { callInkTool } from './ink-mcp.js';

const mockedGetValidAccessToken = vi.mocked(tokensMod.getValidAccessToken);

function mockJsonResponse(payload: Record<string, unknown>): Partial<Response> {
  return {
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

describe('ink-mcp callInkTool', () => {
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

    const result = await callInkTool<{ success: boolean }>('list_sessions', { limit: 1 });

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

    const result = await callInkTool<{ final: boolean }>('bootstrap', { sbSlug: 'lumen' });
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

    await callInkTool('bootstrap', { sbSlug: 'lumen' });

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

    await expect(callInkTool('start_session', { forceNew: true })).rejects.toThrow(
      'Inkwell tool error: start_session unavailable'
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

    await callInkTool('start_session', { forceNew: true }, { callerProfile: 'runtime' });

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers).toMatchObject({
      'x-ink-caller-profile': 'runtime',
    });
  });

  it('reports fetch failures with Inkwell url and network diagnostics', async () => {
    const fetchError = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3999'), {
        code: 'ECONNREFUSED',
        address: '127.0.0.1',
        port: 3999,
      }),
    });
    const fetchSpy = vi.fn().mockRejectedValue(fetchError);
    vi.stubGlobal('fetch', fetchSpy);

    await expect(callInkTool('list_sessions', { limit: 1 })).rejects.toThrow(
      'Inkwell fetch failed for http://localhost:3999/mcp'
    );
    await expect(callInkTool('list_sessions', { limit: 1 })).rejects.toThrow('ECONNREFUSED');
    await expect(callInkTool('list_sessions', { limit: 1 })).rejects.toThrow(
      'Ensure Inkwell server is running and INK_SERVER_URL is correct.'
    );
  });
});

/**
 * One retry on a socket-level reset, for calls the caller marked idempotent
 * (task 38af403e). The measured case: the CLI blocked its loop past the
 * server's keep-alive timeout, the pooled socket was dead when the next
 * request went out, and the launcher declared the service unavailable while
 * a concurrent call succeeded. The shapes here are undici's: a TypeError
 * "fetch failed" whose cause carries the socket error code.
 */
describe('ink-mcp callInkTool retry after a socket reset', () => {
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

  const reset = () =>
    new TypeError('fetch failed', { cause: { code: 'ECONNRESET', errno: -54, syscall: 'read' } });
  const ok = () =>
    mockJsonResponse({
      jsonrpc: '2.0',
      result: { content: [{ text: '{"sessions":[]}' }] },
      id: 1,
    });

  it('an idempotent call reset once is sent again and succeeds', async () => {
    const fetchSpy = vi.fn().mockRejectedValueOnce(reset()).mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchSpy);
    const result = await callInkTool<{ sessions: unknown[] }>(
      'list_sessions',
      { limit: 1 },
      { idempotent: true }
    );
    expect(result).toEqual({ sessions: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('a call not marked idempotent is never sent twice', async () => {
    const fetchSpy = vi.fn().mockRejectedValueOnce(reset()).mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchSpy);
    await expect(callInkTool('send_to_inbox', { content: 'x' })).rejects.toThrow(/ECONNRESET/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a second reset is the failure it always was', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(reset());
    vi.stubGlobal('fetch', fetchSpy);
    await expect(callInkTool('get_studio', { path: '/x' }, { idempotent: true })).rejects.toThrow(
      /ECONNRESET/
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('a timeout or a refused connection is not a reset, and is not retried', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    const refused = new TypeError('fetch failed', {
      cause: { code: 'ECONNREFUSED', errno: -61, syscall: 'connect' },
    });
    for (const failure of [timeout, refused]) {
      const fetchSpy = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(ok());
      vi.stubGlobal('fetch', fetchSpy);
      await expect(
        callInkTool('get_studio', { path: '/x' }, { idempotent: true })
      ).rejects.toThrow();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    }
  });

  it('the other-side-closed message is a reset too', async () => {
    const closed = new TypeError('fetch failed', {
      cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' },
    });
    const fetchSpy = vi.fn().mockRejectedValueOnce(closed).mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchSpy);
    await callInkTool('get_studio', { path: '/x' }, { idempotent: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
