import { describe, it, expect, vi } from 'vitest';
import { createHostedMcpClient } from './mcp-client.js';
const payload = (value: unknown) =>
  new Response(
    JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(value) }] } })
  );
const setup = (fetch: typeof globalThis.fetch, extra = {}) =>
  createHostedMcpClient({
    url: 'http://127.0.0.1:49111/mcp',
    context: 'owned-context',
    accessToken: () => 'session-only-token',
    fetch,
    ...extra,
  });
describe('hosted MCP session transport', () => {
  it('binds auth/context and keeps image/failure semantics through the existing parser', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            result: {
              content: [
                { type: 'text', text: '{"success":false,"content":"application data"}' },
                { type: 'image', mimeType: 'image/png', data: 'fake' },
              ],
            },
          })
        )
    );
    expect(
      await setup(fetch).callTool('read', {}, { signal: new AbortController().signal })
    ).toEqual({
      success: false,
      result: { success: false, content: 'application data' },
      content: [{ type: 'image', mimeType: 'image/png', data: 'fake' }],
    });
    expect(fetch.mock.calls[0]).toEqual([
      new URL('http://127.0.0.1:49111/mcp'),
      expect.objectContaining({
        redirect: 'error',
        headers: expect.objectContaining({
          Authorization: 'Bearer session-only-token',
          'x-ink-context': 'owned-context',
        }),
      }),
    ]);
  });
  it('does not retry, redirect or fall back to organic auth on a refusal', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response('not authorized', { status: 401 })
    );
    await expect(
      setup(fetch).callTool('save', {}, { signal: new AbortController().signal })
    ).rejects.toThrow('(401)');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rechecks Stop after asynchronous credential minting before dispatch', async () => {
    const stop = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => payload({ success: true }));
    const client = setup(fetch, {
      accessToken: async () => {
        stop.abort();
        return 'minted';
      },
    });
    await expect(client.callTool('save', {}, { signal: stop.signal })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('caps streamed response bytes and cancels the response body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('x'.repeat(101)));
      },
      cancel,
    });
    const client = setup(async () => new Response(body), { maxResponseBytes: 100 });
    await expect(
      client.callTool('read', {}, { signal: new AbortController().signal })
    ).rejects.toThrow('byte bound');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('accepts SSE framing and assigns request ids independently per session', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          'event: message\ndata: {"result":{"content":[{"type":"text","text":"{\\"success\\":true}"}]}}\n\n'
        )
    );
    const a = setup(fetch),
      b = setup(fetch);
    const signal = new AbortController().signal;
    expect(await a.callTool('read', {}, { signal })).toEqual({ success: true });
    await a.callTool('read', {}, { signal });
    await b.callTool('read', {}, { signal });
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(init!.body as string).id)).toEqual([
      1, 2, 1,
    ]);
  });
});
