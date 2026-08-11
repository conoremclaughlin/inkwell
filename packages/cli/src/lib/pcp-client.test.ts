/**
 * PcpClient network resilience tests.
 *
 * Focus: fetchWithTimeout — the client-side deadline that turns a silent
 * network hang (observed get_inbox stalling ~159s on a hotspot blip) into a
 * fast, clearly-labelled error.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fetchWithTimeout, PcpClient } from './pcp-client';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('fetchWithTimeout', () => {
  it('passes an abort signal when the caller supplies none', async () => {
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response('ok');
    });
    global.fetch = spy as unknown as typeof fetch;

    const res = await fetchWithTimeout('http://localhost:3001/mcp', { method: 'POST' });
    expect(await res.text()).toBe('ok');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('does not override a caller-supplied signal', async () => {
    const controller = new AbortController();
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return new Response('ok');
    });
    global.fetch = spy as unknown as typeof fetch;

    await fetchWithTimeout('http://localhost:3001/mcp', { signal: controller.signal });
  });

  it('translates a TimeoutError abort into a clear "timed out" error', async () => {
    global.fetch = vi.fn(async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      });
    }) as unknown as typeof fetch;

    await expect(fetchWithTimeout('http://localhost:3001/mcp', {}, 30_000)).rejects.toThrow(
      /timed out after 30s .*network stalled/
    );
  });

  it('translates a generic AbortError into a "timed out" error', async () => {
    global.fetch = vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }) as unknown as typeof fetch;

    await expect(fetchWithTimeout('http://localhost:3001/token')).rejects.toThrow(/timed out/);
  });

  it('rethrows non-abort errors unchanged', async () => {
    const boom = new Error('ECONNREFUSED');
    global.fetch = vi.fn(async () => {
      throw boom;
    }) as unknown as typeof fetch;

    await expect(fetchWithTimeout('http://localhost:3001/mcp')).rejects.toBe(boom);
  });

  it('reports the configured timeout duration in the message', async () => {
    global.fetch = vi.fn(async () => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;

    await expect(fetchWithTimeout('http://x/mcp', {}, 5_000)).rejects.toThrow(/timed out after 5s/);
  });
});

describe('PcpClient x-ink-context header', () => {
  let dir: string;
  let configPath: string;

  const okJson = (body: unknown) =>
    ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    global.fetch = originalFetch;
  });

  const makeClient = (getContextToken?: () => string | null) => {
    dir = mkdtempSync(join(tmpdir(), 'pcp-client-'));
    configPath = join(dir, 'config.json');
    // Far-future expiry so ensureAccessToken uses the stored token as-is.
    writeFileSync(
      configPath,
      JSON.stringify({ accessToken: 'test-token', tokenExpiresAt: '2099-01-01T00:00:00Z' })
    );
    return new PcpClient('http://localhost:9999', configPath, { getContextToken });
  };

  it('attaches the lazily-built token to tool calls', async () => {
    // Without this header, ink-routed tool calls reach the server with no
    // request identity — workspace derivation for artifact writes fails
    // (the regression Myra hit after wholly-in-ink moved tool calls off the
    // provider's MCP connection).
    const spy = vi.fn(async () =>
      okJson({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } })
    );
    global.fetch = spy as unknown as typeof fetch;

    const client = makeClient(() => 'ctx-token-abc');
    await client.callTool('list_artifacts', {});

    const mcpCall = spy.mock.calls.find((c) => String(c[0]).includes('/mcp'));
    expect(mcpCall).toBeDefined();
    const headers = (mcpCall![1] as { headers: Record<string, string> }).headers;
    expect(headers['x-ink-context']).toBe('ctx-token-abc');
  });

  it('omits the header when no context callback is provided', async () => {
    const spy = vi.fn(async () =>
      okJson({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } })
    );
    global.fetch = spy as unknown as typeof fetch;

    const client = makeClient(undefined);
    await client.callTool('list_artifacts', {});

    const mcpCall = spy.mock.calls.find((c) => String(c[0]).includes('/mcp'));
    const headers = (mcpCall![1] as { headers: Record<string, string> }).headers;
    expect(headers['x-ink-context']).toBeUndefined();
  });
});
