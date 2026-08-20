/**
 * Hook-lifecycle route tests (PR #492 rounds 4–6).
 *
 * The CLI's real hook traffic is a TWO-request sequence per prompt: the
 * prompt event first (opens cli_turn_at), then a cliAttached re-assert. Round
 * 6 caught the attach/detach rule clearing the marker on that second request
 * — a no-plugin CLI looked dead for its whole turn. These tests run the
 * actual HTTP sequences against the router and assert what lands in
 * updateSession: the turn marker must survive attach re-asserts and fall only
 * to the real stop event or an explicit detach.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';

vi.mock('../mcp/auth/pcp-auth-provider', () => ({
  PcpAuthProvider: class {
    verifyAccessToken(header?: string) {
      return header ? { userId: 'user-1' } : null;
    }
  },
}));

import { createHookLifecycleRouter } from './hook-lifecycle';
import type { DataComposer } from '../data/composer';

// Minimal fake supabase for the StudioLeaseService the route constructs —
// empty tables make lease renewals/releases clean no-ops.
function makeFakeClient() {
  const empty = {
    eq() {
      return this;
    },
    is() {
      return this;
    },
    not() {
      return this;
    },
    limit() {
      return this;
    },
    order() {
      return this;
    },
    select() {
      return this;
    },
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    single: () => Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'none' } }),
    then<T>(resolve: (v: { data: never[]; error: null }) => T) {
      return Promise.resolve({ data: [] as never[], error: null }).then(resolve);
    },
  };
  return {
    from: () => ({
      select: () => ({ ...empty }),
      update: () => ({ ...empty }),
      insert: () => ({ ...empty }),
    }),
  } as never;
}

describe('hook-lifecycle CLI turn signal', () => {
  const updateSession = vi.fn(async (_id: string, _updates: Record<string, unknown>) => ({
    id: 'session-1',
  }));
  const getSession = vi.fn(async () => ({
    id: 'session-1',
    userId: 'user-1',
    endedAt: null,
    status: 'active',
    lifecycle: 'idle',
  }));

  const dataComposer = {
    getClient: () => makeFakeClient(),
    repositories: { memory: { getSession, updateSession } },
  } as unknown as DataComposer;

  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/hooks', createHookLifecycleRouter(dataComposer));
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    updateSession.mockClear();
    getSession.mockClear();
  });

  async function post(body: Record<string, unknown>) {
    const resp = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ sessionId: 'session-1', ...body }),
    });
    expect(resp.status).toBe(200);
    return updateSession.mock.calls.at(-1)?.[1] as Record<string, unknown>;
  }

  it('the real two-request prompt sequence leaves the turn marker OPEN (round 6)', async () => {
    // Request 1: the prompt event opens the turn — and stamps the proof that
    // this session's runtime writes the marker (the lease sweep's narrow
    // release path is only valid for proven sessions, PR #506 round three).
    const promptUpdates = await post({ lifecycle: 'running', event: 'prompt' });
    expect(typeof promptUpdates.cliTurnAt).toBe('string');
    expect(promptUpdates.cliTurnProvenAt).toBe(promptUpdates.cliTurnAt);

    // Request 2: the CLI immediately re-asserts attachment. This must NOT
    // touch the marker the prompt just opened — nor the proof.
    const attachUpdates = await post({ cliAttached: true });
    expect('cliTurnAt' in attachUpdates).toBe(false);
    expect('cliTurnProvenAt' in attachUpdates).toBe(false);
  });

  it('an explicit detach clears the marker (process proof)', async () => {
    const updates = await post({ cliAttached: false });
    expect(updates.cliTurnAt).toBeNull();
  });

  it('only the real stop event closes the turn; post-compact idle does not', async () => {
    const stopUpdates = await post({ lifecycle: 'idle', event: 'stop' });
    expect(stopUpdates.cliTurnAt).toBeNull();

    const postCompactUpdates = await post({ lifecycle: 'idle', event: 'post-compact' });
    expect('cliTurnAt' in postCompactUpdates).toBe(false);

    // Legacy sender: bare idle without an event — never inferred as a stop.
    const legacyIdleUpdates = await post({ lifecycle: 'idle' });
    expect('cliTurnAt' in legacyIdleUpdates).toBe(false);
  });

  it('legacy running without an event still opens the turn (protection only extends)', async () => {
    const updates = await post({ lifecycle: 'running' });
    expect(typeof updates.cliTurnAt).toBe('string');
  });
});
