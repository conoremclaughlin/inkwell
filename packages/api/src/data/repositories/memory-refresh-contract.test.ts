/**
 * What a re-embed must leave behind, and what it must never touch.
 *
 * updateMemory rewrites a memory's text and then rebuilds everything derived
 * from it: the primary vector, the chunk rows, the embedding metadata, the
 * cached LLM extractions, the bootstrap summary cache. Each of those was
 * individually correct after an edit. The agreements BETWEEN them were not,
 * and an agreement is invisible to a test that only ever asserts one side
 * (Lumen, r1 and r2).
 *
 * WHAT THIS FILE DOES AND DOES NOT PROVE.
 *
 * Publication and cleanup now happen inside swap_memory_embedding and
 * clear_memory_embedding, which take the memory's row lock, compare `version`
 * and swap both stores in one transaction. The harness below implements those
 * two functions against in-memory state — synchronously, so nothing can
 * interleave inside one, which is the property the real transaction provides.
 *
 * That makes these tests a check on the REPOSITORY's use of the contract: what
 * it sends, what it does with each answer, and what it leaves consistent. It
 * is not a check on the SQL. A fake I wrote will happily stay green while the
 * function it imitates is wrong, so the functions themselves are exercised
 * against a real database in memory-embedding-swap.integration.test.ts. Both
 * halves are needed; neither substitutes for the other.
 *
 * Every failing contract is paired with something that must still work, since
 * all of them could be "fixed" by refusing to embed anything at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRepository } from './memory-repository';
import { env } from '../../config/env';

vi.mock('../../config/env', () => ({ env: { MEMORY_EXTRACTION_MODE: 'heuristic' } }));
vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../auth/resolve-identity', () => ({
  resolveSbId: vi.fn(),
  resolveOwnerSbId: vi.fn(),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */

const clone = <T>(x: T): T => structuredClone(x);

interface Faults {
  /** swap_memory_embedding returns an error (the whole transaction rolls back). */
  swap: boolean;
  /** clear_memory_embedding returns an error. */
  clear: boolean;
  /** Deleting the bootstrap summary cache fails. */
  cacheDelete: boolean;
  /** Answer the swap with something other than 'ok' | 'superseded'. */
  swapResult: string | null;
}

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
  const history = {
    ...clone(memory),
    id: 'synthetic-history',
    memory_id: memory.id,
    archived_at: '2026-01-02T12:00:00Z',
    change_type: 'update',
  };
  let cache: any = null;
  const faults: Faults = { swap: false, clear: false, cacheDelete: false, swapResult: null };
  const rpcCalls: Array<{ fn: string; args: Record<string, any> }> = [];

  /**
   * The two SQL functions, as the database runs them: take the row, compare
   * the revision, swap both stores, commit. No awaits inside — a transaction
   * does not yield partway through, and neither may this.
   */
  const rpc = async (fn: string, args: Record<string, any>) => {
    rpcCalls.push({ fn, args: clone(args) });
    const isSwap = fn === 'swap_memory_embedding';
    if (isSwap && faults.swapResult) return { data: faults.swapResult, error: null };
    if (isSwap && faults.swap) return { data: null, error: { message: 'synthetic swap fault' } };
    if (!isSwap && faults.clear) return { data: null, error: { message: 'synthetic clear fault' } };

    if (memory.id !== args.p_memory_id || memory.user_id !== args.p_user_id) {
      return { data: 'missing', error: null };
    }
    if (memory.version !== args.p_expected_version) {
      return { data: 'superseded', error: null };
    }

    chunks = chunks.filter((row) => row.memory_id !== args.p_memory_id);

    // Merge onto what the row holds NOW, then drop the named keys. The caller
    // never sends a whole metadata object, so a concurrent write to an
    // unrelated key survives.
    let metadata = { ...(memory.metadata || {}) };
    if (isSwap) {
      for (const row of args.p_chunks || []) chunks.push(clone(row));
      metadata = { ...metadata, ...(args.p_metadata_patch || {}) };
    }
    for (const key of args.p_metadata_remove || []) delete metadata[key];

    memory = isSwap
      ? {
          ...memory,
          embedding: args.p_embedding,
          embedding_chunks_version: args.p_chunks_version,
          embedding_chunk_count: args.p_chunk_count,
          metadata,
        }
      : {
          ...memory,
          embedding: null,
          embedding_chunks_version: null,
          embedding_chunk_count: null,
          metadata,
        };

    return { data: 'ok', error: null };
  };

  const supabase: any = {
    rpc,
    from(table: string) {
      let op = 'select';
      let payload: any;
      let countOnly = false;
      const filters: Array<[string, string, any]> = [];
      const matches = (row: any) =>
        filters.every(([kind, key, value]) =>
          kind === 'eq' ? row[key] === value : kind === 'gt' ? row[key] > value : row[key] >= value
        );
      const run = async () => {
        if (table === 'memory_history') {
          return { data: matches(history) ? clone(history) : null, error: null };
        }
        if (table === 'memory_summary_cache') {
          if (op === 'delete' && faults.cacheDelete) {
            return { data: null, error: { message: 'synthetic cache delete fault' } };
          }
          if (op === 'upsert') cache = clone(payload);
          if (op === 'delete' && cache && matches(cache)) cache = null;
          return { data: cache && matches(cache) ? clone(cache) : null, error: null };
        }
        if (table === 'memories') {
          if (countOnly) return { data: null, count: matches(memory) ? 1 : 0, error: null };
          if (!matches(memory)) return { data: null, error: null };
          if (op === 'update') {
            const textChanged =
              (payload.content !== undefined && payload.content !== memory.content) ||
              (payload.summary !== undefined && payload.summary !== memory.summary);
            // The archive trigger bumps version on a TEXT change only. A
            // metadata-only write does not move it, which is why the fence
            // alone cannot protect unrelated metadata.
            if (textChanged) memory.version++;
            const next = { ...memory, ...clone(payload) };
            // memory_update_strip_stale_extractions, BEFORE UPDATE: extractions
            // carried across a text edit unchanged never reach the stored row.
            // A writer supplying DIFFERENT ones is stating extractions for the
            // text it is writing, so those survive — that is what keeps a
            // restore whole.
            if (
              textChanged &&
              JSON.stringify((next.metadata || {}).llm_extractions) ===
                JSON.stringify((memory.metadata || {}).llm_extractions)
            ) {
              const stripped = { ...(next.metadata || {}) };
              delete stripped.llm_extractions;
              next.metadata = stripped;
            }
            memory = next;
          }
          return { data: clone(memory), error: null };
        }
        if (table !== 'memory_embedding_chunks') throw new Error('Unexpected table: ' + table);
        if (op === 'delete') chunks = chunks.filter((row) => !matches(row));
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
        insert(v: any) {
          op = 'insert';
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
          return Promise.resolve().then(run);
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

  const repo = new MemoryRepository(supabase);
  (repo as any).embeddingRouter = router;

  return {
    repo,
    router,
    faults,
    rpcCalls,
    get memory() {
      return memory;
    },
    get chunks() {
      return chunks;
    },
  };
}

/** Pause the embedder on one text so a second edit can finish underneath it. */
function pauseOn(h: ReturnType<typeof harness>, text: string) {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const ready = new Promise<void>((r) => (started = r));
  const original = h.router.embedDocument.getMockImplementation()!;
  h.router.embedDocument.mockImplementation(async (value: string) => {
    if (value === text) {
      started();
      await gate;
    }
    return original(value);
  });
  return { ready, release };
}

beforeEach(() => {
  (env as any).MEMORY_EXTRACTION_MODE = 'heuristic';
});

describe('a refresh publishes everything or nothing', () => {
  it('control: a successful refresh replaces the vector and trims old chunks', async () => {
    // The one that must keep passing. Almost every fix here could be had by
    // never publishing at all, and this is what would notice.
    const h = harness();
    await h.repo.updateMemory('synthetic-memory', 'synthetic-user', { content: 'New fact' });
    expect(h.chunks.map((c) => c.chunk_text)).toEqual(['New fact']);
    expect(h.memory.embedding).toBe('[1,1]');
  });

  it('a failed publish leaves no stale chunks behind', async () => {
    // The swap is one transaction, so a failure rolls back both stores — and
    // the memory text has still changed, so whatever survives is stale and
    // gets cleared.
    const h = harness();
    h.faults.swap = true;
    await h.repo
      .updateMemory('synthetic-memory', 'synthetic-user', { content: 'New fact' })
      .catch(() => null);
    expect(h.chunks.some((c) => c.chunk_text === 'Old extra fact')).toBe(false);
  });

  it('a failed cleanup is reported, not swallowed', async () => {
    // Previously the chunk delete could fail, be logged, and the primary
    // vector nulled anyway — leaving a memory that looks un-embedded to every
    // surface that reports on embeddings while its chunk rows are still there
    // and still matching. That is the most misleading of the three states.
    const h = harness();
    h.faults.clear = true;
    h.router.isEnabled = () => false;
    let rejected = false;
    await h.repo
      .updateMemory('synthetic-memory', 'synthetic-user', { content: 'New fact' })
      .catch(() => {
        rejected = true;
      });
    expect(rejected).toBe(true);
  });

  it('a failed cleanup leaves the primary vector and the chunks agreeing', async () => {
    // The transaction's other half: nulling the vector while the rows survive
    // would leave legacy recall matching the old primary embedding even after
    // the chunks were gone, and vice versa. Neither moves unless both do.
    const h = harness();
    h.faults.clear = true;
    h.router.isEnabled = () => false;
    await h.repo
      .updateMemory('synthetic-memory', 'synthetic-user', { content: 'New fact' })
      .catch(() => null);
    expect(h.memory.embedding).toBe('[9,9]');
    expect(h.chunks.length).toBeGreaterThan(0);
  });

  it('chunk-only artifacts still need cleanup after a failed refresh', async () => {
    // remember() writes chunk rows BEFORE it updates the memory row, so a
    // failure in between leaves rows no metadata mentions. The row's opinion
    // of its own embeddings is not evidence about the chunk table.
    const h = harness();
    h.memory.embedding = null;
    h.memory.metadata = {};
    h.memory.embedding_chunks_version = null;
    h.memory.embedding_chunk_count = null;
    h.router.isEnabled = () => false;
    await h.repo.updateMemory('synthetic-memory', 'synthetic-user', { content: 'New fact' });
    expect(h.chunks).toEqual([]);
  });
});

describe('a losing revision publishes nothing and destroys nothing', () => {
  it('a late embedding must not overwrite the edit that finished first', async () => {
    const h = harness();
    const gate = pauseOn(h, 'Edit A');

    const a = h.repo.updateMemory('synthetic-memory', 'synthetic-user', { content: 'Edit A' });
    await gate.ready;
    await h.repo.updateMemory('synthetic-memory', 'synthetic-user', {
      content: 'Edit B',
      metadata: { retainedFromB: true },
    });
    gate.release();
    await a;

    expect(h.memory.content).toBe('Edit B');
    expect(h.chunks.map((c) => c.chunk_text)).toEqual(['Edit B']);
    expect(h.memory.embedding).toBe('[2,2]');
    expect(h.memory.metadata.retainedFromB).toBe(true);
  });

  it('a late FAILED embedding must not clear the winning revision artifacts', async () => {
    // The half I missed first time round (Lumen, r2). A provider returning
    // null skips straight to cleanup, and an unfenced cleanup deletes the
    // chunks and vector the winner just wrote — leaving a memory current in
    // its text and unreachable by every semantic path. Cleanup carries the
    // same fence as publication for exactly this reason.
    const h = harness();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ready = new Promise<void>((r) => (started = r));
    h.router.embedDocument.mockImplementation(async (text: string) => {
      if (text === 'Edit A') {
        // Reach the provider, then fail — after B has fully landed.
        started();
        await gate;
        return null as never;
      }
      return { provider: 'ollama', model: 'synthetic-model', dimensions: 2, vector: [2, 2] };
    });

    const a = h.repo
      .updateMemory('synthetic-memory', 'synthetic-user', { content: 'Edit A' })
      .catch(() => null);
    await ready;
    await h.repo.updateMemory('synthetic-memory', 'synthetic-user', { content: 'Edit B' });
    release();
    await a;

    expect(h.memory.embedding).toBe('[2,2]');
    expect(h.chunks.map((c) => c.chunk_text)).toEqual(['Edit B']);
  });

  it('a metadata-only write during the embed survives it', async () => {
    // The fence alone is not enough here, and that is the point (Lumen, r2).
    // The archive trigger bumps `version` on a TEXT change, so a metadata-only
    // write does not move it: the losing embed passes the fence honestly and
    // would still erase the key by writing back a whole object read before the
    // embed began. The function merges an owned-key patch instead.
    const h = harness();
    const gate = pauseOn(h, 'Edit A');

    const a = h.repo.updateMemory('synthetic-memory', 'synthetic-user', { content: 'Edit A' });
    await gate.ready;
    await h.repo.updateMemory('synthetic-memory', 'synthetic-user', {
      metadata: { unrelatedKey: 'set during the embed' },
    });
    gate.release();
    await a;

    expect(h.memory.metadata.unrelatedKey).toBe('set during the embed');
    // And the embed still landed — a patch that dropped its own keys would
    // pass the assertion above and lose the embedding.
    expect(h.memory.embedding).toBe('[1,1]');
    expect(h.chunks.map((c) => c.chunk_text)).toEqual(['Edit A']);
  });

  it('control: the winner of a race keeps its own artifacts', async () => {
    // A fence that made BOTH sides give up would satisfy the three above and
    // lose the embedding entirely.
    const h = harness();
    await h.repo.updateMemory('synthetic-memory', 'synthetic-user', { content: 'Edit B' });
    expect(h.memory.content).toBe('Edit B');
    expect(h.memory.embedding).toBe('[2,2]');
    expect(h.chunks.map((c) => c.chunk_text)).toEqual(['Edit B']);
  });
});

describe('everything derived from the text is invalidated with the text', () => {
  it('a content edit must not re-embed extractions of the superseded content', async () => {
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

  it('the invalidation persists, so a later refresh cannot revive them', async () => {
    // Suppressing the extractions for one embed call leaves the stale object
    // on the row (Lumen, r2). A summary-only edit afterwards embeds them
    // again — and a summary edit invalidates them too, because
    // buildSourceBlock feeds the summary into the extraction prompt alongside
    // the memory text. My earlier reading, that a summary edit could safely
    // keep them, was wrong about what they were extracted from.
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
    expect(h.memory.metadata.llm_extractions).toBeUndefined();

    await h.repo.updateMemory('synthetic-memory', 'synthetic-user', { summary: 'A new summary' });
    expect(h.chunks.some((c) => c.chunk_text.includes('OldDB'))).toBe(false);
  });

  it('content and summary edits must invalidate the bootstrap summary cache', async () => {
    // getCachedSummary decides freshness by asking whether any memory was
    // CREATED after the cache was computed. An edit does not move created_at,
    // so a corrected memory kept being summarised with its pre-edit text.
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

  it('restoring a memory must invalidate the bootstrap summary cache too', async () => {
    // A rollback rewrites the text exactly as an edit does, and the cache was
    // quoting the edited version right up until it (Lumen, r2). Nothing is
    // created by a restore, so the created_at check never fires.
    const h = harness();
    h.router.isEnabled = () => false;
    await h.repo.setCachedSummary('synthetic-user', undefined, 'Summary of the edited text', 1);
    await h.repo.restoreMemory('synthetic-history', 'synthetic-user');
    const cached = await h.repo.getCachedSummary('synthetic-user');
    expect(cached?.summaryText).not.toBe('Summary of the edited text');
  });

  it('control: an edit that changes no text leaves the cached summary alone', async () => {
    // Dropping the cache on every update would be correct-looking and
    // wasteful: a salience change does not alter a word the summary quotes.
    const h = harness();
    await h.repo.setCachedSummary('synthetic-user', undefined, 'Still valid summary', 1);
    await h.repo.updateMemory('synthetic-memory', 'synthetic-user', { salience: 'high' });
    const cached = await h.repo.getCachedSummary('synthetic-user');
    expect(cached?.summaryText).toBe('Still valid summary');
  });
});

describe('what the repository sends, and what it believes back', () => {
  // The two contracts this file CAN prove on its own. The fence and the
  // merge-versus-replace semantics live in SQL, so a harness that implements
  // them correctly will stay green whatever the real function does — the
  // integration test is what covers those. What is checkable here is the
  // repository's half of the bargain: the shape of the request, and the
  // reading of the reply.
  it('sends only the keys the embedding owns, never a metadata snapshot', async () => {
    // The whole reason the function can merge safely. If the caller posted the
    // object it read before embedding, merging it back would reinstate every
    // key at its pre-embed value and no amount of care in SQL would help.
    const h = harness();
    h.memory.metadata = { ...h.memory.metadata, unrelatedKey: 'owned by someone else' };

    await h.repo.updateMemory('synthetic-memory', 'synthetic-user', { content: 'New fact' });

    const swap = h.rpcCalls.find((c) => c.fn === 'swap_memory_embedding');
    expect(swap).toBeTruthy();
    expect(Object.keys(swap!.args.p_metadata_patch).sort()).toEqual([
      'embedding',
      'embedding_chunks',
    ]);
    expect(swap!.args.p_metadata_patch).not.toHaveProperty('unrelatedKey');
  });

  it('treats an unrecognised swap result as a failure, not a success', async () => {
    // 'missing', or anything the function grows later. Unknown is not evidence
    // that the swap happened, and it is certainly not evidence that a newer
    // revision won — reading it as either leaves the memory's text edited and
    // its vectors describing the version before the edit, reported as fine
    // (Lumen, r2).
    const h = harness();
    h.faults.swapResult = 'missing';

    await h.repo
      .updateMemory('synthetic-memory', 'synthetic-user', { content: 'New fact' })
      .catch(() => null);

    // It must have gone on to clean up rather than declaring victory.
    expect(h.rpcCalls.some((c) => c.fn === 'clear_memory_embedding')).toBe(true);
    expect(h.memory.embedding).toBeNull();
    expect(h.chunks).toEqual([]);
  });

  it('control: a recognised superseded result does NOT trigger cleanup', async () => {
    // The distinction the previous test rests on. If unknown-means-failure were
    // implemented as everything-means-failure, a legitimately superseded write
    // would delete the winner's artifacts — the r2 finding, reintroduced from
    // the other side.
    const h = harness();
    h.faults.swapResult = 'superseded';

    await h.repo.updateMemory('synthetic-memory', 'synthetic-user', { content: 'New fact' });

    expect(h.rpcCalls.some((c) => c.fn === 'clear_memory_embedding')).toBe(false);
    expect(h.memory.embedding).toBe('[9,9]');
  });
});

describe('a silent staleness is worse than a loud failure', () => {
  it('reports a summary-cache invalidation that did not happen', async () => {
    // The cache decides freshness by asking whether a memory was CREATED since
    // it was computed, and an edit creates nothing. So a delete that quietly
    // failed leaves bootstrap quoting the pre-edit text for as long as the user
    // writes no new memories — with the edit reported as successful, which is
    // what makes it undetectable (Lumen, r3).
    const h = harness();
    h.faults.cacheDelete = true;
    await h.repo.setCachedSummary('synthetic-user', undefined, 'Pre-edit summary', 1);

    await expect(
      h.repo.updateMemory('synthetic-memory', 'synthetic-user', { content: 'New fact' })
    ).rejects.toThrow(/could not be invalidated/);
  });

  it('reports it on the restore path too, which shares the helper', async () => {
    const h = harness();
    h.faults.cacheDelete = true;
    await h.repo.setCachedSummary('synthetic-user', undefined, 'Pre-restore summary', 1);

    await expect(h.repo.restoreMemory('synthetic-history', 'synthetic-user')).rejects.toThrow(
      /could not be invalidated/
    );
  });

  it('control: a healthy invalidation does not throw', async () => {
    // Otherwise "throws on failure" could be satisfied by throwing always.
    const h = harness();
    await h.repo.setCachedSummary('synthetic-user', undefined, 'Pre-edit summary', 1);
    await expect(
      h.repo.updateMemory('synthetic-memory', 'synthetic-user', { content: 'New fact' })
    ).resolves.toBeTruthy();
  });

  it('strips stale extractions inside the write, with no separate call', async () => {
    // The invalidation used to be a second RPC after the UPDATE committed, and
    // that gap is a real one: a concurrent edit in between lets the archive
    // trigger snapshot the new text carrying the OLD extractions into history,
    // where clearing the current row can never reach it (Lumen, r3).
    const h = harness();
    h.memory.metadata = {
      ...h.memory.metadata,
      llm_extractions: { durable_fact: 'the project uses OldDB' },
    };

    await h.repo.updateMemory('synthetic-memory', 'synthetic-user', {
      content: 'The project uses NewDB',
    });

    expect(h.memory.metadata.llm_extractions).toBeUndefined();
    expect(h.rpcCalls.map((c) => c.fn)).not.toContain('invalidate_memory_extractions');
  });
});
