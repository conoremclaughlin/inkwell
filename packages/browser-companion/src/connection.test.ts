// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserConnection } from './connection';
import type { PairingRecord } from './pairing';

const origin = 'https://dashboard.example.test:8443';
const installationId = '00000000-0000-4000-8000-000000000001';
const grantId = '00000000-0000-4000-8000-000000000002';
const workspaceId = '00000000-0000-4000-8000-000000000003';
const userId = '00000000-0000-4000-8000-000000000004';
const otherId = '00000000-0000-4000-8000-000000000005';
const start = Date.parse('2026-01-01T00:00:00.000Z');
const expiresAt = '2026-01-01T12:00:00.000Z';
const token = 'synthetic.payload.signature';
const record = (): PairingRecord => ({
  origin,
  installationId,
  commitment: 'a'.repeat(64),
  phase: 'paired',
  revocation: 'none',
  grant: { id: grantId, secret: 'ink-bc-' + 'b'.repeat(64), expiresAt },
});
const tokenReceipt = () => ({
  accessToken: token,
  tokenType: 'Bearer',
  expiresIn: 300,
  grantExpiresAt: expiresAt,
});
const sessionReceipt = () => ({
  grantId,
  installationId,
  workspaceId,
  userId,
  grantExpiresAt: expiresAt,
  grantRevokedAt: null,
  pageAuthority: 'none',
});
const view = () => ({
  origin,
  grantId,
  installationId,
  workspaceId,
  userId,
  grantExpiresAt: expiresAt,
  pageAuthority: 'none',
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function fixture(input = record()) {
  const intent = new AbortController();
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    Response.json(String(url).endsWith('/auth/token') ? tokenReceipt() : sessionReceipt())
  );
  const connection = createBrowserConnection(input, intent.signal, { fetcher });
  return { intent, fetcher, connection };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('fixed connection transport (synthetic fetch only, not registered)', () => {
  it('does nothing at construction or status read, including a stored paired receipt after restart', () => {
    const f = fixture();
    expect(f.connection.current()).toBeUndefined();
    expect(f.fetcher).not.toHaveBeenCalled();
    f.connection.close();
    const restarted = fixture();
    expect(restarted.connection.current()).toBeUndefined();
    expect(restarted.fetcher).not.toHaveBeenCalled();
    restarted.connection.close();
  });
  it('uses only the exact two endpoints and keeps credentials out of views', async () => {
    const f = fixture();
    const result = await f.connection.refresh();
    expect(result).toEqual(view());
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.fetcher.mock.calls[0]).toEqual([
      `${origin}/api/browser-companion/auth/token`,
      expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId, pairingSecret: record().grant!.secret }),
      }),
    ]);
    expect(f.fetcher.mock.calls[1]).toEqual([
      `${origin}/api/browser-companion/session`,
      expect.objectContaining({
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);
    expect(f.fetcher.mock.calls[1][1]).not.toHaveProperty('body');
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(record().grant!.secret);
    expect(Object.keys(f.connection).sort()).toEqual(['close', 'current', 'refresh']);
    result.workspaceId = otherId;
    expect(f.connection.current()).toEqual(view());
    f.connection.current()!.userId = otherId;
    expect(f.connection.current()).toEqual(view());
    f.connection.close();
  });
  it('copies the selected origin and grant before any request and ignores receipt extras', async () => {
    const input = record();
    const f = fixture(input);
    input.origin = 'https://other.example.test';
    input.grant!.secret = 'ink-bc-' + 'c'.repeat(64);
    input.installationId = otherId;
    f.fetcher.mockResolvedValueOnce(
      Response.json({ ...tokenReceipt(), privateExtra: 'synthetic extra' })
    );
    f.fetcher.mockResolvedValueOnce(
      Response.json({ ...sessionReceipt(), privateExtra: 'synthetic extra' })
    );
    expect(await f.connection.refresh()).toEqual(view());
    expect(f.fetcher.mock.calls[0][0]).toBe(`${origin}/api/browser-companion/auth/token`);
    expect(f.fetcher.mock.calls[0][1]?.body).toContain(record().grant!.secret);
    f.connection.close();
  });
  it.each([
    { phase: 'disconnected' },
    { phase: 'ready' },
    { phase: 'unknown' },
    { revocation: 'pending' },
    { revocation: 'confirmed' },
    { grant: undefined },
    { origin: `${origin}/api` },
    { origin: 'http://outside.example.test' },
    { origin: 'https://user:synthetic@dashboard.example.test' },
    { origin: `${origin}/` },
    { installationId: 'invalid' },
    { grant: { ...record().grant!, secret: 'invalid' } },
  ])('refuses an unusable stored pairing before IO: %j', (patch) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() =>
      createBrowserConnection(
        { ...record(), ...patch } as PairingRecord,
        new AbortController().signal,
        { fetcher }
      )
    ).toThrow('refused');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not send an expired grant or an already-aborted intent', async () => {
    const f = fixture();
    vi.setSystemTime(Date.parse(expiresAt));
    await expect(f.connection.refresh()).rejects.toMatchObject({ code: 'expired' });
    expect(f.fetcher).not.toHaveBeenCalled();
    vi.setSystemTime(start);
    const intent = new AbortController();
    intent.abort('synthetic private reason');
    const fetcher = vi.fn<typeof fetch>();
    const connection = createBrowserConnection(record(), intent.signal, { fetcher });
    await expect(connection.refresh()).rejects.toMatchObject({ code: 'closed' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('coalesces verification; reuses a live bearer, then refreshes within the same intent', async () => {
    const f = fixture();
    const first = f.connection.refresh();
    expect(f.connection.refresh()).toBe(first);
    await first;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.fetcher).toHaveBeenCalledTimes(2); // No implicit polling or mint timer.
    await f.connection.refresh();
    expect(f.fetcher.mock.calls.map((c) => c[0])).toEqual([
      `${origin}/api/browser-companion/auth/token`,
      `${origin}/api/browser-companion/session`,
      `${origin}/api/browser-companion/session`,
    ]);
    await vi.advanceTimersByTimeAsync(210_000);
    await f.connection.refresh();
    expect(f.fetcher.mock.calls.slice(-2).map((c) => c[0])).toEqual([
      `${origin}/api/browser-companion/auth/token`,
      `${origin}/api/browser-companion/session`,
    ]);
    f.connection.close();
  });
  it('does not expose an expired bearer as connected, but may refresh within active intent', async () => {
    const f = fixture();
    await f.connection.refresh();
    vi.setSystemTime(start + 300_000);
    expect(f.connection.current()).toBeUndefined();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(await f.connection.refresh()).toEqual(view());
    expect(f.fetcher).toHaveBeenCalledTimes(4);
    f.connection.close();
  });
  it('never refreshes past grant expiry, even after a successful connection', async () => {
    const f = fixture();
    await f.connection.refresh();
    vi.setSystemTime(Date.parse(expiresAt));
    expect(f.connection.current()).toBeUndefined();
    await expect(f.connection.refresh()).rejects.toMatchObject({ code: 'expired' });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(['close', 'intent'] as const)(
    'fences a late token after %s, even if fetch ignores abort',
    async (stop) => {
      const f = fixture();
      const late = deferred<Response>();
      f.fetcher.mockReturnValueOnce(late.promise);
      const refreshing = f.connection.refresh();
      const rejected = expect(refreshing).rejects.toMatchObject({ code: 'closed' });
      if (stop === 'close') f.connection.close();
      else f.intent.abort('synthetic private reason');
      expect(f.connection.current()).toBeUndefined();
      expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
      await rejected; // Does not wait for the transport to cooperate.
      late.resolve(Response.json(tokenReceipt()));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      expect(f.connection.current()).toBeUndefined();
      await expect(f.connection.refresh()).rejects.toMatchObject({ code: 'closed' });
      expect(vi.getTimerCount()).toBe(0);
    }
  );
  it('fences a late session result after Disconnect without exposing the candidate bearer', async () => {
    const f = fixture();
    const late = deferred<Response>();
    f.fetcher
      .mockResolvedValueOnce(Response.json(tokenReceipt()))
      .mockReturnValueOnce(late.promise);
    const work = f.connection.refresh();
    const rejected = expect(work).rejects.toMatchObject({ code: 'closed' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.connection.current()).toBeUndefined();
    f.connection.close();
    await rejected;
    late.resolve(Response.json(sessionReceipt()));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.connection.current()).toBeUndefined();
  });
  it.each([
    { accessToken: '' },
    { accessToken: 'Bearer synthetic' },
    { accessToken: 'a.b.c\r\nx: y' },
    { accessToken: 'x'.repeat(4097) },
    { tokenType: 'other' },
    { expiresIn: 301 },
    { expiresIn: 0 },
    { expiresIn: 1.5 },
    { expiresIn: '300' },
    { grantExpiresAt: 'invalid' },
    { grantExpiresAt: '2026-01-02T00:00:00.000Z' },
  ])('refuses malformed token receipt case %#', async (patch) => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(Response.json({ ...tokenReceipt(), ...patch }));
    await expect(f.connection.refresh()).rejects.toMatchObject({ code: 'invalid-response' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.connection.current()).toBeUndefined();
    f.connection.close();
  });
  it.each([
    { grantId: otherId },
    { installationId: otherId },
    { workspaceId: '' },
    { userId: null },
    { grantExpiresAt: 'invalid' },
    { grantExpiresAt: '2026-01-02T00:00:00.000Z' },
    { grantRevokedAt: '2026-01-01T00:00:00.000Z' },
    { grantRevokedAt: undefined },
    { pageAuthority: 'read' },
    { pageAuthority: undefined },
  ])('refuses a mismatched or authority-bearing session receipt: %j', async (patch) => {
    const f = fixture();
    f.fetcher
      .mockResolvedValueOnce(Response.json(tokenReceipt()))
      .mockResolvedValueOnce(Response.json({ ...sessionReceipt(), ...patch }));
    await expect(f.connection.refresh()).rejects.toMatchObject({ code: 'invalid-response' });
    expect(f.connection.current()).toBeUndefined();
    f.connection.close();
  });
  it.each(['workspaceId', 'userId'])(
    'keeps the first verified %s binding across refresh and failures',
    async (key) => {
      const f = fixture();
      await f.connection.refresh();
      f.fetcher.mockRejectedValueOnce(new Error('synthetic outage'));
      await expect(f.connection.refresh()).rejects.toMatchObject({ code: 'unavailable' });
      f.fetcher
        .mockResolvedValueOnce(Response.json(tokenReceipt()))
        .mockResolvedValueOnce(Response.json({ ...sessionReceipt(), [key]: otherId }));
      await expect(f.connection.refresh()).rejects.toMatchObject({ code: 'invalid-response' });
      expect(f.connection.current()).toBeUndefined();
      f.connection.close();
    }
  );
  it.each([401, 403, 302, 500, 503])(
    'handles HTTP %s without echoing or consuming the error body',
    async (status) => {
      const f = fixture();
      f.fetcher.mockResolvedValueOnce(new Response('synthetic private response', { status }));
      await expect(f.connection.refresh()).rejects.toMatchObject({
        code: status === 401 || status === 403 ? 'refused' : 'unavailable',
      });
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
      f.connection.close();
    }
  );
  it('discards a previously verified bearer after a refused recheck, and never claims confirmed revocation', async () => {
    const f = fixture();
    await f.connection.refresh();
    f.fetcher.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(f.connection.refresh()).rejects.toMatchObject({ code: 'refused' });
    expect(f.connection.current()).toBeUndefined();
    f.connection.close();
  });
  it('sanitizes fetch exceptions and discards previous verification on an outage', async () => {
    const f = fixture();
    await f.connection.refresh();
    f.fetcher.mockRejectedValueOnce(
      new Error(`synthetic private response: ${record().grant!.secret}`)
    );
    const error = await f.connection.refresh().catch((e) => e);
    expect(error.message).toBe('Browser connection unavailable.');
    expect(f.connection.current()).toBeUndefined();
    f.connection.close();
  });
  it.each(['redirected', 'foreign-url'])(
    'refuses a response with %s despite fetch policy',
    async (kind) => {
      const f = fixture();
      const response = Response.json(tokenReceipt());
      Object.defineProperty(response, kind === 'redirected' ? 'redirected' : 'url', {
        value:
          kind === 'redirected'
            ? true
            : 'https://other.example.test/api/browser-companion/auth/token',
      });
      f.fetcher.mockResolvedValueOnce(response);
      await expect(f.connection.refresh()).rejects.toMatchObject({ code: 'invalid-response' });
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      f.connection.close();
    }
  );
  it.each([
    ['not JSON', { 'Content-Type': 'application/json' }],
    [JSON.stringify(tokenReceipt()), { 'Content-Type': 'text/html' }],
    [
      JSON.stringify(tokenReceipt()),
      { 'Content-Type': 'application/json', 'Content-Length': '9000' },
    ],
  ])('refuses invalid bodies and headers', async (body, headers) => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(new Response(body, { headers }));
    await expect(f.connection.refresh()).rejects.toMatchObject({ code: 'invalid-response' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.connection.close();
  });
  it('bounds streaming bodies by bytes and cancels before reading a second oversized chunk', async () => {
    const f = fixture();
    const cancel = vi.fn();
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          chunks++;
          controller.enqueue(new Uint8Array(8193));
        },
        cancel,
      },
      { highWaterMark: 0 }
    );
    f.fetcher.mockResolvedValueOnce(
      new Response(body, { headers: { 'Content-Type': 'application/json' } })
    );
    await expect(f.connection.refresh()).rejects.toMatchObject({ code: 'invalid-response' });
    expect(chunks).toBe(1);
    expect(cancel).toHaveBeenCalledOnce();
    f.connection.close();
  });
  it('times out a stalled body within the same request budget and cancels its reader', async () => {
    const f = fixture();
    const cancel = vi.fn();
    f.fetcher.mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel }), {
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const rejected = expect(f.connection.refresh()).rejects.toMatchObject({ code: 'unavailable' });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.connection.current()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    f.connection.close();
  });
  it('bounds a fetch that ignores cancellation and cannot let its late result replace a retry', async () => {
    const f = fixture();
    const late = deferred<Response>();
    f.fetcher.mockReturnValueOnce(late.promise);
    const rejected = expect(f.connection.refresh()).rejects.toMatchObject({ code: 'unavailable' });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(await f.connection.refresh()).toEqual(view());
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    late.resolve(Response.json(tokenReceipt()));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(f.connection.current()).toEqual(view());
    f.connection.close();
  });
  it('checks grant expiry again before using a late token', async () => {
    const f = fixture();
    const late = deferred<Response>();
    f.fetcher.mockReturnValueOnce(late.promise);
    const rejected = expect(f.connection.refresh()).rejects.toMatchObject({ code: 'expired' });
    vi.setSystemTime(Date.parse(expiresAt));
    late.resolve(Response.json(tokenReceipt()));
    await rejected;
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.connection.current()).toBeUndefined();
  });
  it('rejects a bearer that expires while the session receipt is in flight', async () => {
    const f = fixture();
    const late = deferred<Response>();
    f.fetcher
      .mockResolvedValueOnce(Response.json({ ...tokenReceipt(), expiresIn: 3 }))
      .mockReturnValueOnce(late.promise);
    const rejected = expect(f.connection.refresh()).rejects.toMatchObject({ code: 'expired' });
    await vi.advanceTimersByTimeAsync(2_000);
    late.resolve(Response.json(sessionReceipt()));
    await rejected;
    expect(f.connection.current()).toBeUndefined();
    f.connection.close();
  });
});
