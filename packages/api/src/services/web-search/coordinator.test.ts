import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSearchBatchInput, WebSearchBatchOutput } from './types.js';

vi.mock('./index.js', () => ({
  searchWebBatch: () => {
    throw Error('No real provider in coordinator tests');
  },
}));
import { SearchCoordinator, QUEUE_LIMITS } from './coordinator.js';
import { WebSearchError } from './errors.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function fixture() {
  const calls: Array<{
    input: WebSearchBatchInput;
    resolve(result: WebSearchBatchOutput): void;
    reject(error: unknown): void;
  }> = [];
  const run = vi.fn(
    (input: WebSearchBatchInput) =>
      new Promise<WebSearchBatchOutput>((resolve, reject) => calls.push({ input, resolve, reject }))
  );
  const coordinator = new SearchCoordinator(run);
  const submit = (accountId: string, queries: string[], signal?: AbortSignal, maxResults = 1) =>
    coordinator.submit({ accountId, queries, signal, maxResults }).then(
      (value) => ({ ok: true as const, value }),
      (error: WebSearchError & { batchId?: string }) => ({ ok: false as const, error })
    );
  const complete = (index = 0) => {
    const { input, resolve } = calls[index];
    resolve({
      provider: 'claude',
      model: 'claude-synthetic',
      items: input.queries.map((query) => ({
        query,
        success: true,
        results: [
          { title: 'first ' + query, url: 'https://example.com/first', snippet: '' },
          { title: 'second ' + query, url: 'https://example.com/second', snippet: '' },
        ],
      })),
      searchQueries: input.queries,
      modelToolCallCount: input.queries.length,
      nativeSearchCount: input.queries.length,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  };
  return { coordinator, calls, run, submit, complete };
}

const flush = () => vi.advanceTimersByTimeAsync(QUEUE_LIMITS.collectMs);

describe('bounded same-account search coalescing (inert provider only)', () => {
  it('coalesces one account, deduplicates provider input and returns only caller queries in original order', async () => {
    const f = fixture();
    const first = f.submit('A', ['q1', 'q1'], undefined, 1);
    const second = f.submit('A', ['q2', 'q1'], undefined, 2);
    await vi.advanceTimersByTimeAsync(QUEUE_LIMITS.collectMs - 1);
    expect(f.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls[0].input.queries).toEqual(['q1', 'q2']);
    expect(f.calls[0].input.maxResults).toBe(2);
    f.complete();
    const a = await first,
      b = await second;
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.items.map((x) => x.query)).toEqual(['q1', 'q1']);
    expect(b.value.items.map((x) => x.query)).toEqual(['q2', 'q1']);
    expect(a.value.batchId).toBe(b.value.batchId);
    expect(a.value).not.toHaveProperty('searchQueries');
    expect(a.value.batchUsage).toEqual({
      modelToolCallCount: 2,
      nativeSearchCount: 2,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const aItem = a.value.items[0],
      bItem = b.value.items[1];
    if (!aItem.success || !bItem.success) throw Error('expected verified hits');
    expect(aItem.results).toHaveLength(1);
    expect(bItem.results).toHaveLength(2);
    aItem.results[0].title = 'mutation after delivery';
    a.value.batchUsage.usage!.inputTokens = 999;
    expect(bItem.results[0].title).toBe('first q1');
    expect(b.value.batchUsage.usage?.inputTokens).toBe(10);
  });

  it('does not skip another account to fill a batch or share its context', async () => {
    const f = fixture();
    const a = f.submit('A', ['a']),
      b = f.submit('B', ['b']),
      c = f.submit('A', ['c']);
    await flush();
    expect(f.calls[0].input.queries).toEqual(['a']);
    await flush();
    expect(f.calls).toHaveLength(1);
    f.complete(0);
    await a;
    await flush();
    expect(f.calls[1].input.queries).toEqual(['b']);
    f.complete(1);
    await b;
    await flush();
    expect(f.calls[2].input.queries).toEqual(['c']);
    f.complete(2);
    await c;
  });

  it('never exceeds four unique queries per run and cannot split a request silently', async () => {
    const f = fixture();
    const a = f.submit('A', ['1', '2', '3']),
      b = f.submit('A', ['3', '4', '5']);
    await flush();
    expect(f.calls[0].input.queries).toEqual(['1', '2', '3']);
    f.complete();
    await a;
    await flush();
    expect(f.calls[1].input.queries).toEqual(['3', '4', '5']);
    f.complete(1);
    await b;
  });

  it('snapshots caller input, preserving normalization and not following later mutations', async () => {
    const f = fixture();
    const queries = [' q '];
    const p = f.submit('A', queries);
    queries[0] = 'changed';
    await flush();
    expect(f.calls[0].input.queries).toEqual(['q']);
    f.complete();
    const result = await p;
    expect(result.ok && result.value.items[0].query).toBe('q');
  });

  it('queued cancellation proves no submission and launches nothing', async () => {
    const f = fixture(),
      abort = new AbortController();
    const p = f.submit('A', ['q'], abort.signal);
    abort.abort();
    expect(await p).toMatchObject({ ok: false, error: { reason: 'cancelled', launched: false } });
    await flush();
    expect(f.run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('submitted cancellation does not kill another subscriber or release the running slot', async () => {
    const f = fixture(),
      abort = new AbortController();
    const a = f.submit('A', ['a'], abort.signal),
      b = f.submit('A', ['b']);
    await flush();
    abort.abort();
    const cancelled = await a;
    expect(cancelled).toMatchObject({
      ok: false,
      error: { reason: 'cancelled', launched: true, batchId: expect.any(String) },
    });
    expect(f.calls[0].input.signal?.aborted).toBe(false);
    const c = f.submit('B', ['c']);
    await flush();
    expect(f.calls).toHaveLength(1);
    f.complete();
    expect((await b).ok).toBe(true);
    await flush();
    expect(f.calls).toHaveLength(2);
    f.complete(1);
    await c;
  });

  it('aborts when the last subscriber leaves but waits for runner settlement before replacement', async () => {
    const f = fixture(),
      a = new AbortController(),
      b = new AbortController();
    const pa = f.submit('A', ['a'], a.signal),
      pb = f.submit('A', ['b'], b.signal);
    await flush();
    a.abort();
    b.abort();
    await pa;
    await pb;
    expect(f.calls[0].input.signal?.aborted).toBe(true);
    const next = f.submit('B', ['next']);
    await flush();
    expect(f.calls).toHaveLength(1);
    f.calls[0].reject(new WebSearchError('cancelled', true));
    await flush();
    expect(f.calls).toHaveLength(2);
    f.complete(1);
    await next;
  });

  it('bounds queued requests and expires without aborting or multiplying the active runner', async () => {
    const f = fixture();
    const active = f.submit('A', ['active']);
    await flush();
    const queued = Array.from({ length: QUEUE_LIMITS.requests }, (_, i) =>
      f.submit('B', ['q' + i])
    );
    let overflow: unknown;
    void f.submit('C', ['overflow']).then((result) => {
      overflow = result;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(overflow).toMatchObject({
      ok: false,
      error: { reason: 'capacity_exhausted', launched: false },
    });
    await vi.advanceTimersByTimeAsync(QUEUE_LIMITS.waitMs);
    for (const p of queued)
      expect(await p).toMatchObject({
        ok: false,
        error: { reason: 'queue_timeout', launched: false },
      });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].input.signal?.aborted).toBe(false);
    f.complete();
    await active;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds queued query positions including duplicates, independently of request count', async () => {
    const f = fixture();
    const active = f.submit('A', ['active']);
    await flush();
    const abort = new AbortController();
    const queued = Array.from({ length: QUEUE_LIMITS.queries / 4 }, () =>
      f.submit('B', ['q', 'q', 'q', 'q'], abort.signal)
    );
    let overflow: unknown;
    void f.submit('B', ['q']).then((result) => {
      overflow = result;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(overflow).toMatchObject({
      ok: false,
      error: { reason: 'capacity_exhausted', launched: false },
    });
    abort.abort();
    await Promise.all(queued);
    f.complete();
    await active;
  });

  it.each([false, true])(
    'fans out the measured launched=%s failure without retry',
    async (launched) => {
      const f = fixture();
      const a = f.submit('A', ['a']),
        b = f.submit('A', ['b']);
      await flush();
      f.calls[0].reject(new WebSearchError('provider_failed', launched));
      for (const p of [a, b])
        expect(await p).toMatchObject({
          ok: false,
          error: { reason: 'provider_failed', launched, batchId: expect.any(String) },
        });
      await flush();
      expect(f.calls).toHaveLength(1);
    }
  );

  it('quarantines on unknown stop; queued work and future work never dispatch', async () => {
    const f = fixture();
    const active = f.submit('A', ['active']);
    await flush();
    const queued = f.submit('B', ['queued']);
    f.calls[0].reject(new WebSearchError('stop_unconfirmed', true));
    expect(await active).toMatchObject({
      ok: false,
      error: { reason: 'stop_unconfirmed', launched: true },
    });
    for (const p of [queued, f.submit('C', ['future'])]) {
      let refusal: unknown;
      void p.then((result) => {
        refusal = result;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(refusal).toMatchObject({
        ok: false,
        error: { reason: 'service_quarantined', launched: false },
      });
    }
    await flush();
    expect(f.calls).toHaveLength(1);
  });

  it('rejects malformed input before queuing or provider work', async () => {
    const f = fixture();
    for (const p of [
      f.submit('', ['q']),
      f.submit('A', []),
      f.submit('A', ['q'], AbortSignal.abort()),
      f.submit('A', ['q'], undefined, 11),
    ]) {
      expect(await p).toMatchObject({ ok: false, error: { launched: false } });
    }
    await flush();
    expect(f.run).not.toHaveBeenCalled();
  });

  it('refuses a broken adapter result rather than returning another query or omitting a caller silently', async () => {
    const f = fixture();
    const p = f.submit('A', ['q']);
    await flush();
    f.calls[0].resolve({
      provider: 'claude',
      model: 'synthetic',
      items: [{ query: 'other', success: true, results: [] }],
      searchQueries: ['other'],
      modelToolCallCount: 1,
    });
    expect(await p).toMatchObject({
      ok: false,
      error: { reason: 'invalid_output', launched: true },
    });
  });
});
