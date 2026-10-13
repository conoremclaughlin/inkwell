import { afterEach, describe, it, expect, vi } from 'vitest';
import { requestHostedToolApproval } from './tool-approval.js';
afterEach(() => vi.useRealTimers());
describe('explicit approval transport', () => {
  it('preserves cloned attribution and scoped headers through creation and polling', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('{"requestId":"r1"}'))
      .mockResolvedValueOnce(new Response('{"status":"granted","action":"grant-session"}'));
    const promise = requestHostedToolApproval(
      {
        serverUrl: 'http://fixture.invalid',
        headers: { Authorization: 'Bearer scoped', 'x-ink-context': 'context' },
        fetch,
      },
      {
        tool: 'read',
        reason: 'ask',
        sessionId: 'parent',
        origin: { origin: 'clone', cloneId: 'clone-1', cloneLabel: 'probe' },
      }
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(await promise).toMatchObject({ status: 'granted', action: 'grant-session' });
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({
      sessionId: 'parent',
      origin: { origin: 'clone', cloneId: 'clone-1', cloneLabel: 'probe' },
    });
    expect(fetch.mock.calls[1][1]!.headers).toMatchObject({
      Authorization: 'Bearer scoped',
      'x-ink-context': 'context',
    });
  });
  it('Stop aborts a creation request in flight instead of waiting for its HTTP timeout', async () => {
    const stop = new AbortController();
    let observed: AbortSignal | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          observed = init!.signal!;
          observed.addEventListener('abort', () => reject(observed!.reason), { once: true });
        })
    );
    const promise = requestHostedToolApproval(
      { serverUrl: 'http://fixture.invalid', headers: {}, fetch },
      { tool: 'write', reason: 'ask', signal: stop.signal }
    );
    stop.abort();
    expect((await promise).status).not.toBe('granted');
    expect(observed?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
