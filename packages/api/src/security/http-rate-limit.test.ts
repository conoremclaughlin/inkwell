import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { httpRateLimitEnvSchema } from '../config/http-rate-limit';
import { createHttpRateLimiters, isDirectLoopbackRequest } from './http-rate-limit';

const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
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

function createLimiters(overrides: Record<string, string> = {}) {
  return createHttpRateLimiters(
    httpRateLimitEnvSchema.parse({
      INK_RATE_LIMIT_EXEMPT_LOOPBACK: 'false',
      ...overrides,
    })
  );
}

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
    app.use(createLimiters({ INK_HTTP_RATE_LIMIT_MAX: '2' }).ingress);
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
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(limited.headers.get('ratelimit')).toContain('limit=2');
    expect(limited.headers.get('x-ratelimit-limit')).toBeNull();
    expect(visited).toEqual(['/mcp', '/api/hooks/lifecycle']);
  });

  it('keeps authentication throttling separate from lifecycle requests', async () => {
    const app = express();
    const limiters = createLimiters({
      INK_HTTP_RATE_LIMIT_MAX: '10',
      INK_OAUTH_RATE_LIMIT_MAX: '1',
    });
    app.use(limiters.ingress);
    app.use(['/token', '/authorize'], limiters.oauth);
    app.all('*', (_req, res) => res.json({ ok: true }));
    const url = await listen(app);
    expect((await fetch(`${url}/token`, { method: 'POST' })).status).toBe(200);
    expect((await fetch(`${url}/authorize`)).status).toBe(429);
    expect((await fetch(`${url}/api/hooks/lifecycle`, { method: 'POST' })).status).toBe(200);
  });

  it('still charges OAuth-rejected attempts against the aggregate budget', async () => {
    const app = express();
    const limiters = createLimiters({
      INK_HTTP_RATE_LIMIT_MAX: '2',
      INK_OAUTH_RATE_LIMIT_MAX: '1',
    });
    app.use(limiters.ingress);
    app.use('/token', limiters.oauth);
    app.all('*', (_req, res) => res.json({ ok: true }));
    const url = await listen(app);
    expect((await fetch(`${url}/token`)).status).toBe(200);
    expect((await fetch(`${url}/token`)).status).toBe(429);
    expect((await fetch(`${url}/api/hooks/lifecycle`)).status).toBe(429);
  });

  it('uses the configured OAuth window and resets its counter when that window expires', async () => {
    // Fake Date only; the owned HTTP server keeps its real I/O/timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const app = express();
    const limiters = createLimiters({
      INK_HTTP_RATE_LIMIT_MAX: '10',
      INK_HTTP_RATE_LIMIT_WINDOW_MS: '120000',
      INK_OAUTH_RATE_LIMIT_MAX: '1',
      INK_OAUTH_RATE_LIMIT_WINDOW_MS: '1000',
    });
    app.use(limiters.ingress);
    app.use('/token', limiters.oauth);
    app.all('*', (_req, res) => res.json({ ok: true }));
    const url = await listen(app);
    expect((await fetch(`${url}/ordinary`)).headers.get('ratelimit-policy')).toBe('10;w=120');
    expect((await fetch(`${url}/token`)).headers.get('ratelimit-policy')).toBe('1;w=1');
    const rejected = await fetch(`${url}/token`);
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get('retry-after')).toBe('1');
    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
    expect((await fetch(`${url}/token`)).status).toBe(200);
  });

  it('exempts direct localhost calls from both configured budgets without exempting auth', async () => {
    const app = express();
    const limiters = createLimiters({
      INK_HTTP_RATE_LIMIT_MAX: '1',
      INK_OAUTH_RATE_LIMIT_MAX: '1',
      INK_RATE_LIMIT_EXEMPT_LOOPBACK: 'true',
    });
    app.use(limiters.ingress);
    app.use('/token', limiters.oauth);
    app.get('/protected', (_req, res) => res.status(401).json({ error: 'Unauthorized' }));
    app.all('*', (_req, res) => res.json({ ok: true }));
    const url = await listen(app);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await fetch(`${url}/mcp`)).status).toBe(200);
      expect((await fetch(`${url}/token`)).status).toBe(200);
      expect((await fetch(`${url}/protected`)).status).toBe(401);
    }
  });

  it('does not exempt a local Cloudflare/proxy hop or split its bucket using claimed client IPs', async () => {
    const app = express();
    // Deliberately permissive only in this owned test app: the limiter must
    // remain socket-keyed even if an unrelated caller changes Express trust.
    app.set('trust proxy', true);
    app.use(
      createLimiters({
        INK_HTTP_RATE_LIMIT_MAX: '1',
        INK_RATE_LIMIT_EXEMPT_LOOPBACK: 'true',
      }).ingress
    );
    app.all('*', (_req, res) => res.json({ ok: true }));
    const url = await listen(app);
    expect(
      (
        await fetch(url, {
          headers: { 'X-Forwarded-For': '192.0.2.10', 'CF-Connecting-IP': '192.0.2.10' },
        })
      ).status
    ).toBe(200);
    expect(
      (
        await fetch(url, {
          headers: { 'X-Forwarded-For': '127.0.0.1', 'CF-Connecting-IP': '127.0.0.1' },
        })
      ).status
    ).toBe(429);
    // A direct native call still has its exemption after the proxy bucket fills.
    expect((await fetch(url)).status).toBe(200);
  });

  it('still limits forwarded OAuth requests with the localhost exemption enabled', async () => {
    const app = express();
    const limiters = createLimiters({
      INK_HTTP_RATE_LIMIT_MAX: '10',
      INK_OAUTH_RATE_LIMIT_MAX: '1',
      INK_RATE_LIMIT_EXEMPT_LOOPBACK: 'true',
    });
    app.use(limiters.ingress);
    app.use(['/token', '/authorize'], limiters.oauth);
    app.all('*', (_req, res) => res.json({ ok: true }));
    const url = await listen(app);
    const headers = { Forwarded: 'for=192.0.2.20' };
    expect((await fetch(`${url}/token`, { headers })).status).toBe(200);
    expect((await fetch(`${url}/authorize`, { headers })).status).toBe(429);
    expect((await fetch(`${url}/api/hooks/lifecycle`, { headers })).status).toBe(200);
  });
});

describe('direct loopback exemption predicate', () => {
  it.each([
    '127.0.0.1',
    '127.10.20.30',
    '::1',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ])('recognizes socket address %s without treating Host as identity', (remoteAddress) => {
    expect(isDirectLoopbackRequest({ socket: { remoteAddress }, headers: {} })).toBe(true);
  });

  it.each([
    undefined,
    '',
    'localhost',
    '127.0.0.1.evil.test',
    '127.0.0.999',
    '192.0.2.1',
    '10.0.0.1',
    '::',
    '::ffff:192.0.2.1',
    '2001:db8::1',
  ])('does not grant an exemption for %j even with a localhost Host header', (remoteAddress) => {
    expect(
      isDirectLoopbackRequest({ socket: { remoteAddress }, headers: { host: 'localhost:3001' } })
    ).toBe(false);
  });

  it.each([
    'Forwarded',
    'X-Forwarded-For',
    'X-Forwarded-Host',
    'X-Forwarded-Proto',
    'X-Real-IP',
    'CF-Connecting-IP',
    'CF-Ray',
    'True-Client-IP',
    'Via',
    'CDN-Loop',
  ])(
    'withholds the exemption on %s presence, even if its value is empty or claims localhost',
    (header) => {
      for (const value of ['', '127.0.0.1', '192.0.2.1', ['127.0.0.1', '192.0.2.1']]) {
        expect(
          isDirectLoopbackRequest({
            socket: { remoteAddress: '::1' },
            headers: { [header]: value },
          })
        ).toBe(false);
      }
    }
  );
});
