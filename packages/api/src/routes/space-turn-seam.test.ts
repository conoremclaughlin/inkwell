/**
 * Every route that takes an mcp_access bearer through InkAuthProvider refuses
 * a space-turn token, and does nothing for it
 * (ink://specs/inkling-multi-person-groups, Phase 1).
 *
 * The provider is the real one: the routes build their own, or are handed
 * one here, and its own database client is a spy, so a refusal is seen to
 * cost no identity read. Each route's store is a separate spy, so "refused"
 * also means "touched nothing". The ordinary mcp:tools token is the control
 * on every route.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { fakeEnv } from '../test/fake-env';

// The provider's own client: the identity read behind verifyAccessToken.
const identityReads = vi.hoisted(() => ({ from: [] as string[] }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: (table: string) => {
      identityReads.from.push(table);
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'limit']) chain[m] = () => chain;
      chain.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: [{ id: '00000000-0000-4000-8000-0000000000b1' }], error: null });
      return chain;
    },
  })),
}));
vi.mock('../config/env', async () => ({
  env: { ...(await import('../test/fake-env')).fakeEnv },
}));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/principals', () => ({ workspaceOfSb: vi.fn(async () => null) }));
vi.mock('../services/graph-executor.service', () => ({
  releaseGraphClaimsForSession: vi.fn(async () => undefined),
}));

import { InkAuthProvider } from '../mcp/auth/ink-auth-provider';
import { createAlertsRouter } from './alerts';
import { createHookLifecycleRouter } from './hook-lifecycle';
import { createSessionsRouter } from './sessions';

const USER = '00000000-0000-4000-8000-0000000000a1';
const SB = '00000000-0000-4000-8000-0000000000b1';
const SESSION = '00000000-0000-4000-8000-0000000000c1';

function token(scope: string): string {
  const conversation =
    scope === 'mcp:tools'
      ? {}
      : {
          workspaceId: '00000000-0000-4000-8000-0000000000d1',
          threadId: '00000000-0000-4000-8000-0000000000e1',
          threadKey: 'inkling:thread:fixture-group',
          turnEpoch: '00000000-0000-4000-8000-0000000000f1',
        };
  return jwt.sign(
    {
      type: 'mcp_access',
      sub: USER,
      email: 'owner@example.invalid',
      scope,
      sbSlug: 'fixture-inkling',
      sbId: SB,
      sessionId: SESSION,
      ...conversation,
    },
    fakeEnv.JWT_SECRET,
    { expiresIn: 600 }
  );
}

const SPACE_TURN_SCOPES = ['mcp:space-turn', 'mcp:tools mcp:space-turn'];

// The routes' store. Every query a route makes starts at from().
const storeReads: string[] = [];
function storeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'order', 'limit', 'insert', 'update', 'upsert', 'or']) {
    chain[m] = () => chain;
  }
  chain.single = async () => ({ data: null, error: { message: 'not found' } });
  chain.maybeSingle = async () => ({ data: null, error: null });
  chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
  return chain;
}
const dataComposer = {
  getClient: () => ({
    from: (table: string) => {
      storeReads.push(table);
      return storeChain();
    },
    rpc: (fn: string) => {
      storeReads.push(`rpc:${fn}`);
      return storeChain();
    },
  }),
  repositories: new Proxy(
    {},
    {
      get: (_t, repo: string) =>
        new Proxy(
          {},
          {
            get: (_r, method: string) => async () => {
              storeReads.push(`${repo}.${method}`);
              return null;
            },
          }
        ),
    }
  ),
} as never;

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/alerts', createAlertsRouter(dataComposer));
  app.use('/api/hooks', createHookLifecycleRouter(dataComposer));
  app.use(
    '/api/sessions',
    createSessionsRouter({ authProvider: new InkAuthProvider(), dataComposer } as never)
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  identityReads.from.length = 0;
  storeReads.length = 0;
});

async function send(method: string, path: string, bearer: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, text };
}

const ROUTES: Array<{ name: string; method: string; path: string; body?: unknown }> = [
  { name: 'alerts read', method: 'GET', path: '/api/alerts' },
  { name: 'alerts sources read', method: 'GET', path: '/api/alerts/sources' },
  {
    name: 'alerts action (raise)',
    method: 'POST',
    path: '/api/alerts',
    body: { source: 'fixture-monitor', severity: 'critical', title: 'fixture' },
  },
  { name: 'session events', method: 'GET', path: `/api/sessions/${SESSION}/events` },
  {
    name: 'hook lifecycle',
    method: 'POST',
    path: '/api/hooks/lifecycle',
    body: { sessionId: SESSION, lifecycle: 'idle' },
  },
];

describe('a space-turn token at every non-MCP seam', () => {
  for (const scope of SPACE_TURN_SCOPES) {
    for (const route of ROUTES) {
      it(`${route.name} refuses ${scope} with 403, touching nothing`, async () => {
        const res = await send(route.method, route.path, token(scope), route.body);
        expect(res.status).toBe(403);
        // Refused before the identity read, and before the route's store.
        expect(identityReads.from).toEqual([]);
        expect(storeReads).toEqual([]);
        // Nothing streamed or written back but the refusal itself.
        expect(res.text).not.toContain('event:');
      });
    }
  }
});

describe('session controls and steering keep their existing 403', () => {
  // Already refused before this change: both refuse any SB- or session-bound
  // token. Pinned so the seam change cannot loosen them.
  for (const scope of SPACE_TURN_SCOPES) {
    it(`controls refuses ${scope}`, async () => {
      const res = await send('POST', `/api/sessions/${SESSION}/controls`, token(scope), {
        action: 'stop',
      });
      expect(res.status).toBe(403);
      expect(storeReads).toEqual([]);
    });
    it(`steering refuses ${scope}`, async () => {
      const res = await send('POST', `/api/sessions/${SESSION}/steer`, token(scope), {
        text: 'fixture',
      });
      expect(res.status).toBe(403);
      expect(storeReads).toEqual([]);
    });
  }
});

describe('the ordinary runner token is unchanged at the same seams', () => {
  it('alerts read passes authentication and queries the store', async () => {
    const res = await send('GET', '/api/alerts', token('mcp:tools'));
    expect(res.status).toBe(200);
    expect(identityReads.from).toEqual(['agent_identities']);
    expect(storeReads).toEqual(['alert_events']);
  });

  it('alerts action passes authentication and reaches payload validation', async () => {
    const res = await send('POST', '/api/alerts', token('mcp:tools'), { nonsense: true });
    expect(res.status).toBe(400);
    expect(identityReads.from).toEqual(['agent_identities']);
  });

  it('session events passes authentication and looks the session up', async () => {
    const res = await send('GET', `/api/sessions/${SESSION}/events`, token('mcp:tools'));
    expect(res.status).toBe(404);
    expect(storeReads).toEqual(['sessions']);
  });

  it('hook lifecycle passes authentication', async () => {
    const res = await send('POST', '/api/hooks/lifecycle', token('mcp:tools'), {});
    expect([401, 403, 503]).not.toContain(res.status);
    expect(identityReads.from).toEqual(['agent_identities']);
  });
});
