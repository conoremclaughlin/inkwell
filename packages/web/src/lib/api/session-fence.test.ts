/**
 * The browser's generation fence.
 *
 * `Invalid token` is a verdict on the credential ONE request carried. The
 * browser may well have moved past that credential while the request was in
 * flight — a sibling request rotated the grant, or the person signed in again —
 * and in that case the refusal is true about what it names and false about the
 * session.
 *
 * The server cannot close this gap. An unrecognised refresh secret is named by
 * no column on the grant row, so it is indistinguishable from one that never
 * existed, and `rejected` is the only honest answer it can give. Everything
 * below is therefore the consumer's half of that contract: before ending the
 * session, ask whether the credential this browser holds NOW is alive.
 *
 * Each test re-imports the module, because the recovery latch is module state
 * and a test that inherited it would be measuring the previous test.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { AxiosError } from 'axios';

type FetchCall = { url: string; method: string };

const PROBE = '/api/admin/auth/session';
const LOGOUT = '/api/auth/logout';

const jsonResponse = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

const invalidTokenFailure = () =>
  ({
    response: { status: 401, data: { error: 'Invalid token' } },
    config: { url: '/api/admin/sessions' },
  }) as AxiosError<{ error?: string }>;

/**
 * Drive the real response interceptor with a real axios error, rather than
 * calling the handler directly — the wiring between the two is part of what is
 * being claimed.
 */
async function interceptFailure(error: AxiosError<{ error?: string }>): Promise<void> {
  vi.resetModules();
  const { apiClient } = await import('./client');
  const handlers = (
    apiClient.interceptors.response as unknown as {
      handlers: { rejected: (e: unknown) => Promise<unknown> }[];
    }
  ).handlers;

  for (const handler of handlers) {
    if (handler?.rejected) await handler.rejected(error).catch(() => undefined);
  }

  // The interceptor fires the recovery without awaiting it.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ending the session is fenced against a credential the browser already replaced', () => {
  let calls: FetchCall[];
  let assigned: string[];
  let origFetch: typeof globalThis.fetch;
  let origWindow: unknown;

  const respondToProbeWith = (probe: () => Response | Promise<Response>) => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url === PROBE) return probe();
      return jsonResponse(200, {});
    }) as typeof globalThis.fetch;
  };

  beforeEach(() => {
    calls = [];
    assigned = [];
    origFetch = globalThis.fetch;
    origWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      location: { assign: (url: string) => assigned.push(url) },
    };
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    (globalThis as { window?: unknown }).window = origWindow;
  });

  it('does not end the session when the current credential still authenticates', async () => {
    // The load-bearing case. A request refused with the terminal string was
    // carrying a secret two rotations old; the browser holds a live one.
    respondToProbeWith(() => jsonResponse(200, { userId: 'u1', email: 'user@example.com' }));

    await interceptFailure(invalidTokenFailure());

    expect(calls.map((c) => c.url)).toContain(PROBE);
    expect(calls.map((c) => c.url)).not.toContain(LOGOUT);
    expect(assigned).toEqual([]);
  });

  it('ends the session when the current credential gets the same verdict', async () => {
    // The control. Without it, a fence that refused to ever log out would pass
    // every other test here and leave dead sessions on screen forever.
    respondToProbeWith(() => jsonResponse(401, { error: 'Invalid token' }));

    await interceptFailure(invalidTokenFailure());

    expect(calls.map((c) => c.url)).toContain(LOGOUT);
    expect(assigned).toEqual(['/login?reason=session-expired']);
  });

  it('does not end the session when the probe itself cannot be reached', async () => {
    // "The network did not answer" is not a refusal, and this is the same
    // mistake as the server's — concluding something terminal from an
    // unanswered question.
    respondToProbeWith(() => {
      throw new Error('network down');
    });

    await interceptFailure(invalidTokenFailure());

    expect(calls.map((c) => c.url)).not.toContain(LOGOUT);
    expect(assigned).toEqual([]);
  });

  it('does not end the session when the probe is answered 503', async () => {
    respondToProbeWith(() =>
      jsonResponse(503, { error: 'Authentication temporarily unavailable' })
    );

    await interceptFailure(invalidTokenFailure());

    expect(calls.map((c) => c.url)).not.toContain(LOGOUT);
    expect(assigned).toEqual([]);
  });

  it('does not end the session when the probe is answered with a superseded cookie', async () => {
    respondToProbeWith(() => jsonResponse(401, { error: 'Stale credential' }));

    await interceptFailure(invalidTokenFailure());

    expect(calls.map((c) => c.url)).not.toContain(LOGOUT);
    expect(assigned).toEqual([]);
  });

  it('checks again on a later failure rather than latching on the first survival', async () => {
    // The recovery latch exists to stop a burst of failures firing a burst of
    // logouts. A survived check must release it, or the first stale request of
    // a session permanently disarms the real thing.
    vi.resetModules();
    const { apiClient } = await import('./client');
    const handlers = (
      apiClient.interceptors.response as unknown as {
        handlers: { rejected: (e: unknown) => Promise<unknown> }[];
      }
    ).handlers;
    const fire = async () => {
      for (const handler of handlers) {
        if (handler?.rejected) await handler.rejected(invalidTokenFailure()).catch(() => undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    let alive = true;
    respondToProbeWith(() =>
      alive ? jsonResponse(200, { userId: 'u1' }) : jsonResponse(401, { error: 'Invalid token' })
    );

    await fire();
    expect(assigned).toEqual([]);

    alive = false;
    await fire();
    expect(assigned).toEqual(['/login?reason=session-expired']);
  });
});
