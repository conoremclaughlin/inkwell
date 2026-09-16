import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { createBrowserCors, requireCookieCsrfHeader } from './cookie-csrf';

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

async function fixture() {
  const app = express();
  app.use(createBrowserCors());
  app.use(requireCookieCsrfHeader);
  let mutations = 0;
  app.all('*', (req, res) => {
    if (req.method !== 'GET') mutations += 1;
    res.json({ ok: true });
  });
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  return { url: `http://127.0.0.1:${address.port}`, mutations: () => mutations };
}

describe('cookie mutation CSRF boundary', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'rejects unprotected %s even with a bearer',
    async (method) => {
      const test = await fixture();
      const response = await fetch(test.url, {
        method,
        headers: {
          Cookie: 'pcp-admin-refresh=synthetic-refresh',
          Authorization: 'Bearer synthetic-expired',
        },
      });
      expect(response.status).toBe(403);
      expect(test.mutations()).toBe(0);
    }
  );

  it('allows native bearer-only requests and protected cookie requests', async () => {
    const test = await fixture();
    expect(
      (await fetch(test.url, { method: 'POST', headers: { Authorization: 'Bearer synthetic' } }))
        .status
    ).toBe(200);
    expect(
      (
        await fetch(test.url, {
          method: 'POST',
          headers: { Cookie: 'pcp-admin-refresh=synthetic', 'X-Inkwell-CSRF': '1' },
        })
      ).status
    ).toBe(200);
    expect(
      (await fetch(test.url, { headers: { Cookie: 'pcp-admin-refresh=synthetic' } })).status
    ).toBe(200);
    expect(test.mutations()).toBe(2);
  });

  it('does not permit cross-origin browsers to preflight the custom header', async () => {
    const test = await fixture();
    for (const origin of [
      'https://attacker.example',
      'http://localhost:3002.attacker.example',
      'http://localhost:4002', // Alternate dashboards use their same-origin proxy, not this CORS grant.
      'null',
    ]) {
      const response = await fetch(test.url, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'X-Inkwell-CSRF',
        },
      });
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
    const trusted = await fetch(test.url, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3002',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'X-Inkwell-CSRF',
      },
    });
    expect(trusted.headers.get('access-control-allow-origin')).toBe('http://localhost:3002');
    expect(trusted.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'x-inkwell-csrf'
    );
    expect(test.mutations()).toBe(0);
  });
});
