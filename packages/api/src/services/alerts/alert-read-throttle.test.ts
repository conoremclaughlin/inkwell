/**
 * The alert query routes are throttled (CodeQL js/missing-rate-limiting).
 *
 * Both GETs are authenticated, so this is not the anti-guessing throttle that
 * guards the credential routes. It bounds cost: each request runs a query
 * against alert_events / alert_sources for whoever holds a valid token, so a
 * leaked token or a client stuck in a retry loop could otherwise make the
 * alerting tables the thing that takes the database down — the alerting path
 * becoming the outage it exists to report.
 *
 * Exercised over real HTTP against the real router, which is the point. Two
 * earlier versions of this throttle were "present" by inspection and still not
 * rate limiting anything an analyzer could see, and the test agreed with the
 * code both times because it read the source for the same shape the code was
 * written from. Sending 61 requests and counting refusals does not care how
 * the limiter is spelled.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { DataComposer } from '../../data/composer';

vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Authenticated callers are keyed per user; the token itself is irrelevant to
// the throttle, so the provider is stubbed to a fixed identity per bearer.
vi.mock('../../mcp/auth/pcp-auth-provider', () => ({
  PcpAuthProvider: class {
    verifyAccessToken(header?: string) {
      if (!header) return null;
      return { userId: header.replace('Bearer ', '') };
    }
  },
}));

const ALERT_READS_PER_MINUTE = 60;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const { createAlertsRouter } = await import('../../routes/alerts');
  const dataComposer = {
    getClient: () => ({
      from: () => {
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'order', 'limit', 'is']) b[m] = () => b;
        b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
        return b;
      },
    }),
  } as unknown as DataComposer;

  const app = express();
  app.set('trust proxy', true);
  app.use('/api/alerts', createAlertsRouter(dataComposer));
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function get(path: string, user: string): Promise<number> {
  const resp = await fetch(`${baseUrl}/api/alerts${path}`, {
    headers: { authorization: `Bearer ${user}` },
  });
  return resp.status;
}

describe('alert read throttle', () => {
  it('serves a normal polling rate then refuses the runaway', async () => {
    const user = `burst-${Date.now()}`;
    const statuses: number[] = [];
    for (let i = 0; i < ALERT_READS_PER_MINUTE; i += 1) statuses.push(await get('/', user));

    // The control, and the reason this is not merely "eventually 429": the
    // budget is spent rather than refused from the first call. A throttle that
    // said no to everything would silence a monitor permanently after one
    // burst, which is the same outcome as the bug it guards against.
    expect(statuses.filter((s) => s === 429)).toHaveLength(0);

    expect(await get('/', user)).toBe(429);
  });

  it('throttles /sources too, not just the first route added', async () => {
    const user = `sources-${Date.now()}`;
    for (let i = 0; i < ALERT_READS_PER_MINUTE; i += 1) await get('/sources', user);
    expect(await get('/sources', user)).toBe(429);
  });

  it('gives each user their own budget', async () => {
    const noisy = `noisy-${Date.now()}`;
    const quiet = `quiet-${Date.now()}`;
    for (let i = 0; i < ALERT_READS_PER_MINUTE + 2; i += 1) await get('/', noisy);

    // One client exhausting itself must not deny everyone else their alerts.
    expect(await get('/', noisy)).toBe(429);
    expect(await get('/', quiet)).not.toBe(429);
  });
});
