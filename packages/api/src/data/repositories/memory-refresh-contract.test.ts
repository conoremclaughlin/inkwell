/**
 * What a re-embed must leave behind, and what it must never touch.
 *
 * updateMemory rewrites a memory's text and then rebuilds its embedding
 * artifacts: the primary vector, the chunk rows, the embedding metadata, the
 * cached summary that quotes it. Six contracts between those pieces were
 * broken in ways no unit test could see, because each one is an agreement
 * BETWEEN two stores rather than a property of either (Lumen, r2).
 *
 * The harness is a synthetic Supabase: one memory row, a chunk table, a
 * summary cache, and injectable delete faults. It drives the real
 * MemoryRepository, so the thing under test is the shipped code and not a
 * description of it. Written by Lumen for the review; committed here because a
 * regression that lives in a reviewer's scratch directory is not a regression.
 *
 * Every failing contract below is paired with something that must still work,
 * since all six could be "fixed" by refusing to embed anything at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRepository } from './memory-repository';
import { env } from '../../config/env';
vi.mock('../../config/env', () => ({ env: { MEMORY_EXTRACTION_MODE: 'heuristic' } }));
vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../auth/resolve-identity', () => ({ resolveSbId: vi.fn(), resolveOwnerSbId: vi.fn() }));

const clone = <T>(x: T): T => structuredClone(x);
function harness() {
  let memory: any = {
    id: 'synthetic-memory',
    user_id: 'synthetic-user',
    content: 'Old fact',
    summary: null,
    source: 'observation',
    salience: 'medium',
    topics: [],
    embedding: '[9,9]',
    metadata: { embedding: { model: 'test' }, embedding_chunks: { chunkCount: 2 } },
    embedding_chunks_version: 1,
    embedding_chunk_count: 2,
    version: 1,
    created_at: '2026-01-01T12:00:00Z',
    expires_at: null,
  };
  let chunks: any[] = [
    { memory_id: memory.id, chunk_index: 0, chunk_text: 'Old fact', embedding: '[9,9]' },
    { memory_id: memory.id, chunk_index: 1, chunk_text: 'Old extra fact', embedding: '[9,9]' },
  ];
  let cache: any = null;
  const faults = { trim: false, delete: false };
  const operations: any[] = [];
  const supabase = {
    from(table: string) {
      let op = 'select';
      let payload: any;
      let countOnly = false;
      const filters: Array<[string, string, any]> = [];
      const matches = (row: any) =>
        filters.every(([kind, key, value]) =>
          kind === 'eq' ? row[key] === value : kind === 'gt' ? row[key] > value : row[key] >= value
        );
      const run = () => {
        operations.push({ table, op, payload: clone(payload), filters: clone(filters) });
        if (table === 'memory_summary_cache') {
          if (op === 'upsert') cache = clone(payload);
          if (op === 'delete' && cache && matches(cache)) cache = null;
          return { data: cache && matches(cache) ? clone(cache) : null, error: null };
        }
        if (table === 'memories') {
          if (countOnly) return { data: null, count: matches(memory) ? 1 : 0, error: null };
          if (!matches(memory)) return { data: null, error: null };
          if (op === 'update') {
            if (
              (payload.content !== undefined && payload.content !== memory.content) ||
              (payload.summary !== undefined && payload.summary !== memory.summary)
            )
              memory.version++;
            memory = { ...memory, ...clone(payload) };
          }
          return { data: clone(memory), error: null };
        }
        if (table !== 'memory_embedding_chunks') throw new Error('Unexpected table: ' + table);
        if (op === 'upsert') {
          for (const row of payload) {
            const i = chunks.findIndex(
              (x) => x.memory_id === row.memory_id && x.chunk_index === row.chunk_index
            );
            if (i < 0) chunks.push(clone(row));
            else chunks[i] = clone(row);
          }
        }
        if (op === 'delete') {
          if (faults.delete || (faults.trim && filters.some((f) => f[0] === 'gte')))
            return { data: null, error: { message: 'synthetic delete fault' } };
          chunks = chunks.filter((row) => !matches(row));
        }
        return { data: null, error: null };
      };
      const q: any = {
        update(v: any) {
          op = 'update';
          payload = v;
          return q;
        },
        upsert(v: any) {
          op = 'upsert';
          payload = v;
          return q;
        },
        delete() {
          op = 'delete';
          return q;
        },
        select(_columns?: string, options?: any) {
          countOnly = options?.head === true;
          return q;
        },
        gt(k: string, v: any) {
          filters.push(['gt', k, v]);
          return q;
        },
        eq(k: string, v: any) {
          filters.push(['eq', k, v]);
          return q;
        },
        gte(k: string, v: any) {
          filters.push(['gte', k, v]);
          return q;
        },
        single() {
          return Promise.resolve(run());
        },
        then(resolve: any, reject: any) {
          return Promise.resolve().then(run).then(resolve, reject);
        },
      };
      return q;
    },
  };
  const router = {
    isEnabled: () => true,
    getRuntimeConfig: () => ({ provider: 'ollama', model: 'synthetic-model' }),
    embedDocument: vi.fn(async (text: string) => ({
      provider: 'ollama',
      model: 'synthetic-model',
      dimensions: 2,
      vector: text === 'Edit B' ? [2, 2] : [1, 1],
    })),
  };
  const repo = new MemoryRepository(supabase as any);
  // Explicitly replace the router so no default/provider can ever run.
  (repo as any).embeddingRouter = router;
  return {
    repo,
    router,
    faults,
    operations,
    get memory() {
      return memory;
    },
    get chunks() {
      return chunks;
    },
  };
}
beforeEach(() => {
  (env as any).MEMORY_EXTRACTION_MODE = 'heuristic';
});

describe('memory embedding refresh contracts', () => {
  it('control: a successful refresh replaces the vector and trims old chunks', async () => {
    // The one that must keep passing. Five of the six fixes below could be had
    // by never publishing anything, and this is what would notice.
    const h = harness();
    await h.repo.updateMemory('synthetic-memory', 'synthetic-user', { content: 'New fact' });
    expect(h.chunks.map((c) => c.chunk_text)).toEqual(['New fact']);
    expect(h.memory.embedding).toBe('[1,1]');
  });
  // A re-embed that produces fewer chunks than the last one leaves the surplus
  // rows behind. The chunk search RPC reads those rows directly — it never
  // consults the memory's embedding metadata, chunk count or version — so each
  // one stays matchable against text the memory no longer contains.
  it('trim failure must not leave stale higher-index chunks searchable', async () => {
    const h = harness();
    h.faults.trim = true;
    await h.repo
      .updateMemory('synthetic-memory', 'synthetic-user', { content: 'New fact' })
      .catch(() => null);
    expect(h.chunks.some((c) => c.chunk_text === 'Old extra fact')).toBe(false);
  });
  it('failed cleanup must not silently succeed with stale chunks', async () => {
    const h = harness();
    h.faults.delete = true;
    h.router.isEnabled = () => false;
    let rejected = false;
    await h.repo
      .updateMemory('synthetic-memory', 'synthetic-user', { content: 'New fact' })
      .catch(() => {
        rejected = true;
      });
    expect(rejected || h.chunks.length === 0).toBe(true);
  });
  // remember() upserts chunk rows before it updates the memory row, so a
  // failure in between leaves rows no metadata admits to. "The row says it was
  // never embedded" is not evidence about what is in the chunk table.
  it('chunk-only artifacts still need cleanup after a failed refresh', async () => {
    const h = harness();
    h.memory.embedding = null;
    h.memory.metadata = {};
    h.memory.embedding_chunks_version = null;
    h.memory.embedding_chunk_count = null;
    h.router.isEnabled = () => false;
    await h.repo.updateMemory('synthetic-memory', 'synthetic-user', { content: 'New fact' });
    expect(h.chunks).toEqual([]);
  });
  it('content edit must not re-embed cached extractions of superseded content', async () => {
    const h = harness();
    (env as any).MEMORY_EXTRACTION_MODE = 'merged';
    h.memory.metadata.llm_extractions = {
      version: 1,
      provider: 'synthetic',
      model: 'synthetic',
      extractedAt: '2026-01-01T12:00:00Z',
      durable_fact: {
        durableFacts: [
          {
            fact: 'The project uses OldDB',
            category: 'decision',
            evidence: 'The project uses OldDB',
          },
        ],
      },
    };
    await h.repo.updateMemory('synthetic-memory', 'synthetic-user', {
      content: 'The project uses NewDB',
    });
    expect(h.chunks.some((c) => c.chunk_text.includes('OldDB'))).toBe(false);
  });
  // getCachedSummary decides freshness by asking whether any memory was
  // CREATED after the cache was computed. An edit does not move created_at.
  it('content and summary edits must invalidate the bootstrap summary cache', async () => {
    const h = harness();
    h.router.isEnabled = () => false;
    await h.repo.setCachedSummary('synthetic-user', undefined, 'Old cached summary', 1);
    await h.repo.updateMemory('synthetic-memory', 'synthetic-user', {
      content: 'New fact',
      summary: 'New summary',
    });
    const cached = await h.repo.getCachedSummary('synthetic-user');
    expect(cached?.summaryText).not.toBe('Old cached summary');
  });
  // Embedding is the slow part and the row can move while it runs. The loser
  // must publish nothing: its chunks, its vector, and — because the metadata
  // update rewrites the whole object — the winner's unrelated metadata keys.
  it('late embedding from Edit A must not overwrite the already-completed Edit B', async () => {
    const h = harness();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ready = new Promise<void>((r) => {
      started = r;
    });
    const original = h.router.embedDocument.getMockImplementation()!;
    h.router.embedDocument.mockImplementation(async (text) => {
      if (text === 'Edit A') {
        started();
        await gate;
      }
      return original(text);
    });
    const a = h.repo.updateMemory('synthetic-memory', 'synthetic-user', { content: 'Edit A' });
    await ready;
    await h.repo.updateMemory('synthetic-memory', 'synthetic-user', {
      content: 'Edit B',
      metadata: { retainedFromB: true },
    });
    release();
    await a;
    expect(h.memory.content).toBe('Edit B');
    expect.soft(h.chunks.map((c) => c.chunk_text)).toEqual(['Edit B']);
    expect.soft(h.memory.embedding).toBe('[2,2]');
    expect.soft(h.memory.metadata.retainedFromB).toBe(true);
  });

  it('control: an edit that changes no text leaves the cached summary alone', async () => {
    // The counterweight to the cache invalidation above. Dropping the cache on
    // every update would be correct-looking and wasteful: a salience or topic
    // change does not alter a single word the summary quotes.
    const h = harness();
    await h.repo.setCachedSummary('synthetic-user', undefined, 'Still valid summary', 1);
    await h.repo.updateMemory('synthetic-memory', 'synthetic-user', { salience: 'high' });
    const cached = await h.repo.getCachedSummary('synthetic-user');
    expect(cached?.summaryText).toBe('Still valid summary');
  });

  it('control: the winning edit of a race keeps its own artifacts', async () => {
    // The other side of the fence. Abandoning the superseded write is only
    // right if the winner's write actually landed — a fence that made both
    // sides give up would satisfy the race test and lose the embedding.
    const h = harness();
    await h.repo.updateMemory('synthetic-memory', 'synthetic-user', { content: 'Edit B' });
    expect(h.memory.content).toBe('Edit B');
    expect(h.memory.embedding).toBe('[2,2]');
    expect(h.chunks.map((c) => c.chunk_text)).toEqual(['Edit B']);
  });
});
