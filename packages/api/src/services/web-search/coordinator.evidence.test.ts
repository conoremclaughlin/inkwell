import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSearchBatchInput, WebSearchBatchOutput } from './types';
import type { SearchBatchRecord } from './coordinator';
vi.mock('./index.js', () => ({
  searchWebBatch: () => {
    throw Error('No real provider in evidence tests');
  },
}));
import { SearchCoordinator, QUEUE_LIMITS } from './coordinator';
import { WebSearchError } from './errors';
import { searchEvents } from './fixtures.test-support';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
const tick = () => vi.advanceTimersByTimeAsync(QUEUE_LIMITS.collectMs);
const request = (queries = ['q'], contentRecording = true, signal?: AbortSignal) => ({
  accountId: 'account-A',
  queries,
  maxResults: 1,
  contentRecording,
  signal,
});
const result = (queries = ['q']): WebSearchBatchOutput => ({
  provider: 'claude',
  model: 'test',
  searchQueries: queries,
  modelToolCallCount: queries.length,
  items: queries.map((query) => ({ query, success: true, results: [] })),
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const capture = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: WebSearchError) => ({ error })
  );

describe('batch evidence lifetime and failure isolation', () => {
  it('waits for required batch persistence before releasing results or the physical slot', async () => {
    const persisted = deferred<void>();
    const run = vi.fn(async (input: WebSearchBatchInput) => result(input.queries));
    const record = vi.fn(() => persisted.promise);
    const coordinator = new SearchCoordinator(run, record);
    let first: unknown;
    void coordinator.submit(request()).then((value) => {
      first = value;
    });
    await tick();
    expect(record).toHaveBeenCalledOnce();
    expect(first).toBeUndefined();
    const next = coordinator.submit(request(['next']));
    await tick();
    expect(run).toHaveBeenCalledOnce();
    persisted.resolve();
    await tick();
    expect(first).toBeDefined();
    expect(run).toHaveBeenCalledTimes(2);
    await next;
  });

  it('never coalesces different recording snapshots for one account', async () => {
    const run = vi.fn(async (input: WebSearchBatchInput, observe?: (line: string) => void) => {
      observe?.(JSON.stringify(searchEvents(input.queries[0])[1]));
      return result(input.queries);
    });
    const record = vi.fn(async (_value: SearchBatchRecord) => undefined);
    const coordinator = new SearchCoordinator(run, record);
    const on = coordinator.submit(request(['on'], true));
    const off = coordinator.submit(request(['off'], false));
    await tick();
    await tick();
    expect((await on).batchId).not.toBe((await off).batchId);
    expect(run.mock.calls.map(([input]) => input.queries)).toEqual([['on'], ['off']]);
    expect(record.mock.calls[0][0]).toMatchObject({
      accountId: 'account-A',
      contentRecording: true,
      observations: { queries: [{ query: 'on' }] },
    });
    expect(record.mock.calls[1][0]).toMatchObject({
      contentRecording: false,
      observations: { queryCount: 1 },
    });
    expect(record.mock.calls[1][0].observations).not.toHaveProperty('queries');
    expect(JSON.stringify(record.mock.calls[1][0])).not.toContain('"off"');
  });

  it.each([true, false])(
    'batch audit failure preserves launched=%s and never retries',
    async (launched) => {
      const run = vi.fn(async () => {
        throw new WebSearchError('provider_failed', launched);
      });
      const record = vi.fn(async () => {
        throw Error('private audit fault');
      });
      const coordinator = new SearchCoordinator(run, record);
      const pending = capture(coordinator.submit(request()));
      await tick();
      expect(await pending).toMatchObject({ error: { reason: 'audit_unavailable', launched } });
      expect(record).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledOnce();
    }
  );

  it('withholds successful results if their required batch record fails', async () => {
    const coordinator = new SearchCoordinator(
      async () => result(),
      async () => {
        throw Error('private audit fault');
      }
    );
    const pending = capture(coordinator.submit(request()));
    await tick();
    expect(await pending).toMatchObject({ error: { reason: 'audit_unavailable', launched: true } });
  });

  it('all subscribers leaving does not suppress evidence, and no new run starts before settlement', async () => {
    const stopped = deferred<WebSearchBatchOutput>();
    const run = vi.fn((_input: WebSearchBatchInput, observe?: (line: string) => void) => {
      observe?.(JSON.stringify(searchEvents('rejected query')[1]));
      return stopped.promise;
    });
    const record = vi.fn(async (_record: SearchBatchRecord) => undefined);
    const coordinator = new SearchCoordinator(run, record);
    const abort = new AbortController();
    const pending = capture(coordinator.submit(request(['q'], true, abort.signal)));
    await tick();
    abort.abort();
    expect(await pending).toMatchObject({ error: { reason: 'cancelled', launched: true } });
    expect(record).not.toHaveBeenCalled();
    stopped.reject(new WebSearchError('cancelled', true));
    await tick();
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0][0]).toMatchObject({
      reason: 'cancelled',
      searchMayHaveRun: true,
      observations: { queries: [{ query: 'rejected query' }] },
    });
  });

  it('a failed audit cannot undo the unknown-stop quarantine', async () => {
    const stopped = deferred<WebSearchBatchOutput>();
    const run = vi.fn(() => stopped.promise);
    const coordinator = new SearchCoordinator(run, async () => {
      throw Error('private audit fault');
    });
    const active = capture(coordinator.submit(request()));
    await tick();
    const queued = capture(coordinator.submit(request(['next'])));
    stopped.reject(new WebSearchError('stop_unconfirmed', true));
    await tick();
    expect(await active).toMatchObject({ error: { reason: 'audit_unavailable', launched: true } });
    for (const p of [queued, capture(coordinator.submit(request(['future'])))]) {
      let refusal: unknown;
      void p.then((value) => {
        refusal = value;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(refusal).toMatchObject({ error: { reason: 'service_quarantined', launched: false } });
    }
    expect(run).toHaveBeenCalledOnce();
  });
});
