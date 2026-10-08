/**
 * A body the JSON parser can't read, through a real Express stack in
 * production mode: the shared express.json(), a route with its own parser
 * (as /token has), the boundary, and the saved-logins router. The body is
 * fake. The control shows the leak this guards: without the boundary,
 * Express's default handler prints the parser's error, and with it the body.
 */
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../data/composer', () => ({
  getDataComposer: vi.fn(() => {
    throw new Error('A body that does not parse must not reach the store');
  }),
}));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { jsonBodyErrors } from './json-body-errors';
import { vaultRouter } from './admin-vault';
import { logger } from '../utils/logger';

const FAKE = 'FAKE782pw';

function app(withBoundary: boolean) {
  const built = express();
  built.set('env', 'production');
  built.post('/token', express.json(), (_req, res) => {
    res.json({ ok: true });
  });
  built.use(express.json());
  if (withBoundary) built.use(jsonBodyErrors);
  built.use('/api/admin/vault', vaultRouter);
  built.get('/boom', () => {
    throw new Error('not a body error');
  });
  return built;
}

async function send(withBoundary: boolean, url: string, body: string, method = 'POST') {
  const server = app(withBoundary).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : body,
    });
    const text = await response.text();
    // Express's default handler logs on the next tick.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { status: response.status, text };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

let printed: unknown[][];
beforeEach(() => {
  printed = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    printed.push(args);
  });
  vi.mocked(logger.warn).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('a body the parser can’t read', () => {
  it('without the boundary, its text reaches stderr (the control)', async () => {
    const res = await send(false, '/api/admin/vault/logins', `{"password":${FAKE}}`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(printed)).toContain(FAKE);
  });

  it('answers 400 with no detail, and nothing prints or logs its text', async () => {
    const res = await send(true, '/api/admin/vault/logins', `{"password":${FAKE}}`);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text)).toEqual({
      error: 'The request body could not be read',
      code: 'entity.parse.failed',
    });
    expect(printed).toEqual([]);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('Request body rejected', {
      type: 'entity.parse.failed',
      status: 400,
      method: 'POST',
      path: '/api/admin/vault/logins',
    });
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(FAKE);
  });

  it('covers a route’s own parser registered before it', async () => {
    const res = await send(true, '/token', `{"refresh_token":${FAKE}}`);
    expect(res.status).toBe(400);
    expect(res.text).not.toContain(FAKE);
    expect(JSON.stringify(printed)).not.toContain(FAKE);
  });

  it('a body too large is answered the same way', async () => {
    const res = await send(
      true,
      '/api/admin/vault/logins',
      JSON.stringify({ name: 'x'.repeat(200_000) })
    );
    expect(res.status).toBe(413);
    expect(JSON.parse(res.text)).toMatchObject({ code: 'entity.too.large' });
    expect(printed).toEqual([]);
  });

  it('leaves every other error to the handlers after it', async () => {
    const res = await send(true, '/boom', '', 'GET');
    expect(res.status).toBe(500);
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it('is mounted right after the server’s shared parser', async () => {
    const server = await readFile(path.join(__dirname, '../mcp/server.ts'), 'utf8');
    const line = '    app.use(express.json());\n';
    const shared = server.indexOf(line);
    expect(shared).toBeGreaterThan(0);
    // The only shared parser: a second one later would need its own boundary.
    expect(server.indexOf('app.use(express.json());', shared + line.length)).toBe(-1);
    const after = server.slice(shared).split('\n').slice(1, 4).join('\n');
    expect(after).toContain('    app.use(jsonBodyErrors);');
  });
});
