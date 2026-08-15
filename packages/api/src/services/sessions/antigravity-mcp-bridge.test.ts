/**
 * Antigravity MCP bridge integration tests.
 *
 * These spawn the real bridge as a real child process against a real HTTP
 * server, because that is the only configuration that proves anything: the
 * bridge exists precisely because `agy` spawns it as a bare `node` child, and
 * a mocked version would not exercise the stdio framing, the env inheritance,
 * or the Streamable HTTP handling that make up its entire job.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { createServer, type Server, type IncomingMessage } from 'http';
import { join } from 'path';
import { once } from 'events';

const BRIDGE = join(__dirname, 'antigravity-mcp-bridge.mjs');

interface Captured {
  headers: IncomingMessage['headers'];
  body: string;
}

/** How the stub should answer the next request. */
type Responder = (body: string) => {
  status?: number;
  contentType?: string;
  payload?: string;
  sessionIdHeader?: string;
};

let server: Server;
let baseUrl: string;
let captured: Captured[] = [];
let responder: Responder;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      captured.push({ headers: req.headers, body });
      const r = responder(body);
      const headers: Record<string, string> = {
        'Content-Type': r.contentType ?? 'application/json',
      };
      if (r.sessionIdHeader) headers['mcp-session-id'] = r.sessionIdHeader;
      res.writeHead(r.status ?? 200, headers);
      res.end(r.payload ?? '');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}/mcp`;
});

afterAll(async () => {
  server.close();
  await once(server, 'close');
});

/**
 * Feed lines to a fresh bridge process and collect what it writes to stdout.
 * Resolves once `expected` lines have arrived or the process exits.
 */
async function runBridge(
  lines: object[],
  env: Record<string, string>,
  expected: number
): Promise<Record<string, unknown>[]> {
  captured = [];
  const proc = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, INK_MCP_URL: baseUrl, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const out: Record<string, unknown>[] = [];
  let buf = '';

  const done = new Promise<void>((resolve) => {
    if (expected === 0) return void setTimeout(resolve, 250);
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        out.push(JSON.parse(line));
        if (out.length >= expected) resolve();
      }
    });
    proc.on('close', () => resolve());
  });

  for (const line of lines) proc.stdin.write(`${JSON.stringify(line)}\n`);
  await done;
  proc.stdin.end();
  proc.kill();
  return out;
}

describe('credential injection', () => {
  it('turns INK_ACCESS_TOKEN into an Authorization header', async () => {
    responder = () => ({ payload: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) });

    await runBridge(
      [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }],
      {
        INK_ACCESS_TOKEN: 'tok-abc',
      },
      1
    );

    expect(captured[0].headers.authorization).toBe('Bearer tok-abc');
  });

  it('forwards the context token and legacy scope headers', async () => {
    responder = () => ({ payload: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) });

    await runBridge(
      [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }],
      {
        INK_CONTEXT: 'ctx-token',
        INK_SESSION_ID: 'sess-1',
        INK_STUDIO_ID: 'studio-1',
        AGENT_ID: 'aster',
      },
      1
    );

    expect(captured[0].headers['x-ink-context']).toBe('ctx-token');
    expect(captured[0].headers['x-ink-session-id']).toBe('sess-1');
    expect(captured[0].headers['x-ink-studio-id']).toBe('studio-1');
    expect(captured[0].headers['x-ink-agent-id']).toBe('aster');
  });

  it('sends no Authorization header when no token is in the environment', async () => {
    // A spawn without credentials must fail as unauthenticated, not silently
    // reach the server as some other identity.
    responder = () => ({ payload: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) });

    await runBridge(
      [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }],
      {
        INK_ACCESS_TOKEN: '',
      },
      1
    );

    expect(captured[0].headers.authorization).toBeUndefined();
  });
});

describe('Streamable HTTP handling', () => {
  it('captures mcp-session-id from initialize and echoes it on later requests', async () => {
    responder = (body) =>
      body.includes('initialize')
        ? {
            sessionIdHeader: 'mcp-sess-77',
            payload: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
          }
        : { payload: JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} }) };

    await runBridge(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ],
      { INK_ACCESS_TOKEN: 'tok' },
      2
    );

    expect(captured[0].headers['mcp-session-id']).toBeUndefined();
    expect(captured[1].headers['mcp-session-id']).toBe('mcp-sess-77');
  });

  it('unwraps a JSON-RPC payload delivered as SSE', async () => {
    responder = () => ({
      contentType: 'text/event-stream',
      payload: `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 9, result: { via: 'sse' } })}\n\n`,
    });

    const out = await runBridge([{ jsonrpc: '2.0', id: 9, method: 'tools/list' }], {}, 1);

    expect(out[0]).toEqual({ jsonrpc: '2.0', id: 9, result: { via: 'sse' } });
  });

  it('advertises that it accepts both response encodings', async () => {
    responder = () => ({ payload: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) });
    await runBridge([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }], {}, 1);
    expect(captured[0].headers.accept).toContain('application/json');
    expect(captured[0].headers.accept).toContain('text/event-stream');
  });
});

describe('protocol edge cases', () => {
  it("answers agy's non-standard server/discover locally", async () => {
    // The Ink MCP server would reject this method, and a rejection reads to
    // agy as a dead server — so it must never reach HTTP at all.
    responder = () => ({ status: 400, payload: 'should not be called' });

    const out = await runBridge([{ jsonrpc: '2.0', id: 1, method: 'server/discover' }], {}, 1);

    expect(captured).toHaveLength(0);
    expect(out[0]).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('returns a JSON-RPC error carrying the original id when the server fails', async () => {
    responder = () => ({ status: 500, payload: '' });

    const out = await runBridge([{ jsonrpc: '2.0', id: 42, method: 'tools/call' }], {}, 1);

    expect(out[0].id).toBe(42);
    expect((out[0].error as { message: string }).message).toContain('Ink MCP bridge');
  });

  it('writes nothing back for a notification', async () => {
    // A notification has no id, so there is no envelope to answer on.
    // Inventing one would desynchronise the stream.
    responder = () => ({ status: 202, payload: '' });

    const out = await runBridge([{ jsonrpc: '2.0', method: 'notifications/initialized' }], {}, 0);

    expect(captured).toHaveLength(1);
    expect(out).toEqual([]);
  });

  it('survives a non-JSON stdin line instead of dying mid-session', async () => {
    responder = () => ({ payload: JSON.stringify({ jsonrpc: '2.0', id: 5, result: { ok: 1 } }) });

    const proc = spawn(process.execPath, [BRIDGE], {
      env: { ...process.env, INK_MCP_URL: baseUrl },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    captured = [];

    const out: Record<string, unknown>[] = [];
    const done = new Promise<void>((resolve) => {
      proc.stdout.on('data', (c) => {
        for (const line of c.toString().split('\n')) {
          if (line.trim()) {
            out.push(JSON.parse(line));
            resolve();
          }
        }
      });
    });

    proc.stdin.write('this is not json\n');
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' })}\n`);
    await done;
    proc.kill();

    expect(out[0]).toMatchObject({ id: 5 });
  });
});
