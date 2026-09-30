/**
 * InkClient network resilience tests.
 *
 * Focus: fetchWithTimeout — the client-side deadline that turns a silent
 * network hang (observed get_inbox stalling ~159s on a hotspot blip) into a
 * fast, clearly-labelled error.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fetchWithTimeout, InkClient } from './ink-client';
import { captureToolImages, takeCapturedImages } from '../repl/tool-images.js';
import { isSemanticFailure, localToolLedgerLine } from '../repl/auto-evict.js';
import { isErrorPayload } from '@inklabs/shared/runtime';

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

describe('InkClient x-ink-context header', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'ink-client-'));
    configPath = join(dir, 'config.json');
    // Far-future expiry so ensureAccessToken uses the stored token as-is.
    writeFileSync(
      configPath,
      JSON.stringify({ accessToken: 'test-token', tokenExpiresAt: '2099-01-01T00:00:00Z' })
    );
    return new InkClient('http://localhost:9999', configPath, { getContextToken });
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

/**
 * A failed tool call must fail.
 *
 * The server reports argument-validation failures as `isError: true` with a
 * bare message instead of the usual JSON envelope. The client used to return
 * that as `{ text }`, which is shaped exactly like a successful result — so
 * `ink attach` read a payload with no `sessions` key and reported no sessions,
 * the session-start hook's lifecycle stamp vanished, and chat's /eject dropped
 * its memory write. All three looked like working features (Lumen, PR #511
 * review).
 */
describe('InkClient surfaces failed tool calls', () => {
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

  const makeClient = () => {
    dir = mkdtempSync(join(tmpdir(), 'ink-client-err-'));
    configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({ accessToken: 'test-token', tokenExpiresAt: '2099-01-01T00:00:00Z' })
    );
    return new InkClient('http://localhost:9999', configPath);
  };

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    global.fetch = originalFetch;
  });

  it('throws when a call is rejected for an unrecognized argument', async () => {
    global.fetch = vi.fn(async () =>
      okJson({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [
            {
              type: 'text',
              text: "MCP error -32602: Input validation error: Invalid arguments for tool list_sessions: Unrecognized key(s) in object: 'status'",
            },
          ],
          isError: true,
        },
      })
    ) as unknown as typeof fetch;

    await expect(makeClient().callTool('list_sessions', { status: 'active' })).rejects.toThrow(
      /Unrecognized key/
    );
  });

  it('leaves a structured {success:false} body alone — callers inspect it', async () => {
    // These are handled failures, not protocol failures. Throwing here would
    // break every caller that reads `success` and branches on it.
    global.fetch = vi.fn(async () =>
      okJson({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [
            { type: 'text', text: JSON.stringify({ success: false, error: 'User not found' }) },
          ],
          isError: true,
        },
      })
    ) as unknown as typeof fetch;

    const result = (await makeClient().callTool('create_reminder', { title: 'x' })) as Record<
      string,
      unknown
    >;
    expect(result.success).toBe(false);
    expect(result.error).toBe('User not found');
  });

  it('surfaces error text even when a non-text content block comes first', async () => {
    global.fetch = vi.fn(async () =>
      okJson({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [
            { type: 'image', data: 'not-used-by-the-client', mimeType: 'image/png' },
            { type: 'text', text: 'handler exploded after rendering diagnostics' },
          ],
          isError: true,
        },
      })
    ) as unknown as typeof fetch;

    await expect(makeClient().callTool('some_tool', {})).rejects.toThrow(
      /handler exploded after rendering diagnostics/
    );
  });

  it('throws a generic error when a failed result contains no text', async () => {
    global.fetch = vi.fn(async () =>
      okJson({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [{ type: 'image', data: 'not-used-by-the-client', mimeType: 'image/png' }],
          isError: true,
        },
      })
    ) as unknown as typeof fetch;

    await expect(makeClient().callTool('some_tool', {})).rejects.toThrow(
      /failed without a text error message/
    );
  });

  describe('keeps image blocks that arrive beside text (PR #708)', () => {
    // A real 1x1 PNG, so the capture step downstream can measure it.
    const PNG_1X1 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const image = { type: 'image', data: PNG_1X1, mimeType: 'image/png' };
    const respond = (content: unknown[]) => {
      global.fetch = vi.fn(async () =>
        okJson({ jsonrpc: '2.0', id: 1, result: { content } })
      ) as unknown as typeof fetch;
    };

    it('beside a JSON payload: the payload unwrapped as before, the image on content', async () => {
      respond([{ type: 'text', text: JSON.stringify({ success: true, name: 'chart' }) }, image]);
      const result = (await makeClient().callTool('render_chart', {})) as Record<string, unknown>;
      expect(result.success).toBe(true);
      expect(result.name).toBe('chart');
      expect(result.content).toEqual([image]);
    });

    it('beside plain text', async () => {
      respond([{ type: 'text', text: 'here is the chart' }, image]);
      const result = (await makeClient().callTool('render_chart', {})) as Record<string, unknown>;
      expect(result).toEqual({ text: 'here is the chart', content: [image] });
    });

    it('beside a JSON value that is not an object', async () => {
      respond([{ type: 'text', text: '[1,2]' }, image]);
      const result = (await makeClient().callTool('render_chart', {})) as Record<string, unknown>;
      expect(result).toEqual({ result: [1, 2], content: [image] });
    });

    // Lumen, PR #708 round 2: a payload's own `content` is application data,
    // and merging images into it erased a string or object and blended them
    // into an array. Every shape is kept whole under `result`.
    it.each([
      ['a string', 'synthetic-caption-marker'],
      ['an object', { caption: 'synthetic-caption-marker' }],
      ['an array', ['synthetic-caption-marker']],
      ['null', null],
    ])(
      'beside a payload whose own content is %s: the payload is kept whole',
      async (_label, own) => {
        const payload = { success: true, content: own };
        respond([{ type: 'text', text: JSON.stringify(payload) }, image]);
        const result = (await makeClient().callTool('render_chart', {})) as Record<string, unknown>;
        // `success` is also copied up beside it (round 3, below).
        expect(result).toEqual({ success: true, result: payload, content: [image] });
      }
    );

    // Lumen, PR #708 round 3: nested under `result`, a failed call's flags were
    // invisible to every failure predicate, and the ledger recorded a receipt.
    // Checked with the production predicates, never a restatement of them.
    describe("a wrapped payload's failure flags stay where the failure predicates read them", () => {
      const call = async (payload: Record<string, unknown>) => {
        respond([{ type: 'text', text: JSON.stringify(payload) }, image]);
        const result = await makeClient().callTool('render_chart', {});
        return { result, captured: await captureToolImages(result, captureOpts()) };
      };
      let cacheDir: string;
      const captureOpts = () => ({
        cacheDir: async () => cacheDir,
        delivery: () => ({ deliverable: true }) as const,
      });
      beforeEach(() => {
        cacheDir = mkdtempSync(join(tmpdir(), 'ink-client-flags-'));
      });
      afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));

      // The predicates first: they are the contract. The shape is how it holds.
      it('success: false reads as a failure, and the ledger says so', async () => {
        const payload = { success: false, error: 'render failed', content: 'diagnostic' };
        const { result, captured } = await call(payload);
        expect(isSemanticFailure(captured)).toBe(true);
        expect(localToolLedgerLine('render_chart', captured, JSON.stringify(captured))).toMatch(
          /^Local tool failed \(render_chart\)/
        );
        expect(result).toEqual({ success: false, result: payload, content: [image] });
      });

      it('isError: true reads as a declared error', async () => {
        const payload = { isError: true, content: { detail: 'diagnostic' } };
        const { result, captured } = await call(payload);
        expect(isErrorPayload(captured)).toBe(true);
        expect(isSemanticFailure(captured)).toBe(true);
        expect(result).toEqual({ isError: true, result: payload, content: [image] });
      });

      it('success: true is carried as it is, and is no failure', async () => {
        const payload = { success: true, content: 'caption' };
        const { result, captured } = await call(payload);
        expect(result).toEqual({ success: true, result: payload, content: [image] });
        expect(isSemanticFailure(captured)).toBe(false);
        expect(isErrorPayload(captured)).toBe(false);
      });

      it('a payload with no flags gains none', async () => {
        const payload = { content: 'caption', note: 'no flags here' };
        const { result } = await call(payload);
        expect(result).toEqual({ result: payload, content: [image] });
      });
    });

    it('the kept payload survives capture: its data stays, only the image bytes go', async () => {
      const payload = { success: true, content: 'synthetic-caption-marker' };
      respond([{ type: 'text', text: JSON.stringify(payload) }, image]);
      const parsed = await makeClient().callTool('render_chart', {});
      const cacheDir = mkdtempSync(join(tmpdir(), 'ink-client-capture-'));
      try {
        const captured = await captureToolImages(parsed, {
          cacheDir: async () => cacheDir,
          delivery: () => ({ deliverable: true }),
        });
        const serialized = JSON.stringify(captured);
        expect(serialized).toContain('synthetic-caption-marker');
        expect(serialized).not.toContain(PNG_1X1.slice(0, 32));
        expect(takeCapturedImages(captured)).toHaveLength(1);
      } finally {
        rmSync(cacheDir, { recursive: true, force: true });
      }
    });

    it('with no image, the payload is exactly what it always was', async () => {
      respond([{ type: 'text', text: JSON.stringify({ success: true }) }]);
      const result = await makeClient().callTool('render_chart', {});
      expect(result).toEqual({ success: true });
    });

    it('and the chat runtime then captures it instead of relaying base64', async () => {
      respond([{ type: 'text', text: JSON.stringify({ success: true }) }, image]);
      const parsed = await makeClient().callTool('render_chart', {});
      const cacheDir = mkdtempSync(join(tmpdir(), 'ink-client-capture-'));
      try {
        const captured = await captureToolImages(parsed, {
          cacheDir: async () => cacheDir,
          delivery: () => ({ deliverable: true }),
        });
        expect(takeCapturedImages(captured)).toHaveLength(1);
        expect(JSON.stringify(captured)).not.toContain(PNG_1X1.slice(0, 32));
      } finally {
        rmSync(cacheDir, { recursive: true, force: true });
      }
    });
  });

  it('still returns plain non-JSON text when the call did not fail', async () => {
    global.fetch = vi.fn(async () =>
      okJson({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'plain prose, not JSON' }] },
      })
    ) as unknown as typeof fetch;

    const result = (await makeClient().callTool('some_tool', {})) as Record<string, unknown>;
    expect(result.text).toBe('plain prose, not JSON');
  });
});
