import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { createHttpRateLimiter } from './http-rate-limit';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        })
    )
  );
});

async function listen(app: express.Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  return `http://127.0.0.1:${address.port}`;
}

describe('HTTP ingress limits', () => {
  it('limits aggregate work across routes, not separately per attacker-selected URL', async () => {
    const app = express();
    app.use(createHttpRateLimiter(2));
    const visited: string[] = [];
    app.all('*', (req, res) => {
      visited.push(req.path);
      res.json({ ok: true });
    });
    const url = await listen(app);
    expect((await fetch(`${url}/mcp`, { method: 'POST' })).status).toBe(200);
    expect((await fetch(`${url}/api/hooks/lifecycle`, { method: 'POST' })).status).toBe(200);
    const limited = await fetch(`${url}/api/sessions/synthetic-session/events`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect(visited).toEqual(['/mcp', '/api/hooks/lifecycle']);
  });

  it('keeps authentication throttling separate from lifecycle requests', async () => {
    const app = express();
    app.use(createHttpRateLimiter(10));
    app.use(['/token', '/authorize'], createHttpRateLimiter(1));
    app.all('*', (_req, res) => res.json({ ok: true }));
    const url = await listen(app);
    expect((await fetch(`${url}/token`, { method: 'POST' })).status).toBe(200);
    expect((await fetch(`${url}/authorize`)).status).toBe(429);
    expect((await fetch(`${url}/api/hooks/lifecycle`, { method: 'POST' })).status).toBe(200);
  });
});
