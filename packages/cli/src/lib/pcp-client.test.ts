/**
 * PcpClient network resilience tests.
 *
 * Focus: fetchWithTimeout — the client-side deadline that turns a silent
 * network hang (observed get_inbox stalling ~159s on a hotspot blip) into a
 * fast, clearly-labelled error.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithTimeout } from './pcp-client';

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
