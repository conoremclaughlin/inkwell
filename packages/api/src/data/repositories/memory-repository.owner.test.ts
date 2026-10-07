/**
 * Every memory has exactly one owner, and the repository never reads or writes
 * without one (ink://specs/remove-shared-memories §3.2–3.4).
 *
 * The database half (the RPCs' owner predicate before their limit, the archive
 * triggers) is exercised against real Postgres in
 * memory-owner-containment.integration.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MemoryRepository } from './memory-repository';
import { createMockSupabaseClient, type MockSupabaseClient } from '../../test/mocks/supabase.mock';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const OWNER = { sbSlug: 'lumen', sbId: 'sb-lumen' };

function memoryRow(over: Record<string, unknown> = {}) {
  return {
    id: 'mem-1',
    user_id: 'user-1',
    content: 'A fact',
    summary: null,
    topic_key: null,
    source: 'observation',
    salience: 'medium',
    topics: [],
    agent_id: 'lumen',
    sb_id: 'sb-lumen',
    contact_id: null,
    embedding: null,
    metadata: {},
    version: 1,
    created_at: '2026-10-07T00:00:00Z',
    expires_at: null,
    ...over,
  };
}

function historyRow(over: Record<string, unknown> = {}) {
  return {
    id: 'hist-1',
    memory_id: 'mem-1',
    user_id: 'user-1',
    content: 'An older fact',
    summary: null,
    topic_key: null,
    source: 'observation',
    salience: 'medium',
    topics: [],
    metadata: {},
    version: 1,
    created_at: '2026-10-01T00:00:00Z',
    archived_at: '2026-10-02T00:00:00Z',
    change_type: 'delete',
    contact_id: 'contact-1',
    agent_id: 'lumen',
    sb_id: 'sb-lumen',
    ...over,
  };
}

describe('MemoryRepository — one owner per memory', () => {
  let db: MockSupabaseClient;
  let repo: MemoryRepository;
  const calls = (fn: unknown) => (fn as { mock: { calls: unknown[][] } }).mock.calls;

  beforeEach(() => {
    db = createMockSupabaseClient();
    repo = new MemoryRepository(db as unknown as SupabaseClient);
    (repo as any).embeddingRouter = { isEnabled: vi.fn().mockReturnValue(false) };
    vi.spyOn(repo as any, 'invalidateCachedSummaries').mockResolvedValue(undefined);
    vi.spyOn(repo as any, 'refreshMemoryEmbedding').mockResolvedValue(undefined);
  });

  describe('writes', () => {
    it('refuses a memory with no owner, and inserts nothing', async () => {
      await expect(repo.remember({ userId: 'user-1', content: 'whose?' } as never)).rejects.toThrow(
        'needs an owner'
      );
      expect(db.from).not.toHaveBeenCalled();
    });

    it('refuses a slug that resolves to no identity, rather than writing a slug-only row', async () => {
      db._queueReturnData([]); // agent_identities: nobody by that slug
      await expect(
        repo.remember({ userId: 'user-1', sbSlug: 'nobody', content: 'probe' })
      ).rejects.toThrow('canonical owner');
      expect(db._queryBuilder.insert).not.toHaveBeenCalled();
    });

    it('records both the slug and the canonical id', async () => {
      db._setReturnData(memoryRow());
      await repo.remember({ userId: 'user-1', ...OWNER, content: 'A fact' });
      expect(db._queryBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({ agent_id: 'lumen', sb_id: 'sb-lumen' })
      );
    });
  });

  describe('reads', () => {
    it('recalls nothing, and runs no query, without an owner', async () => {
      db._setArrayData([memoryRow({ agent_id: null, sb_id: null })]);
      await expect(repo.recall('user-1', undefined, {})).resolves.toEqual([]);
      await expect(repo.recall('user-1', 'fact', { sbSlug: 'lumen' })).resolves.toEqual([]);
      await expect(repo.recallWithScores('user-1', 'fact', {})).resolves.toEqual([]);
      expect(db.from).not.toHaveBeenCalled();
      expect(db.rpc).not.toHaveBeenCalled();
    });

    it("text recall matches the owner's canonical id, with no shared branch", async () => {
      db._setArrayData([]);
      await repo.recall('user-1', 'fact', { ...OWNER, recallMode: 'text' });
      expect(calls(db._queryBuilder.eq)).toContainEqual(['sb_id', 'sb-lumen']);
      const agentOr = calls(db._queryBuilder.or).filter(([arg]) =>
        String(arg).includes('agent_id')
      );
      expect(agentOr).toEqual([]);
    });

    it('recent memories need an owner, and read by its id', async () => {
      await expect(repo.getRecentMemories('user-1', undefined)).resolves.toEqual([]);
      expect(db.from).not.toHaveBeenCalled();

      db._setArrayData([]);
      await repo.getRecentMemories('user-1', OWNER);
      expect(calls(db._queryBuilder.eq)).toContainEqual(['sb_id', 'sb-lumen']);
    });
  });

  describe('semantic recall', () => {
    const embeddingRouter = (chunked: boolean) => ({
      isEnabled: vi.fn().mockReturnValue(true),
      embedQuery: vi.fn().mockResolvedValue({
        vector: [0.1, 0.2],
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1024,
      }),
      getRuntimeConfig: vi.fn().mockReturnValue({
        enabled: true,
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1024,
        queryThreshold: 0.2,
        matchCountMultiplier: 1,
        chunkedRecallEnabled: chunked,
        ollamaBaseUrl: 'http://localhost:11434',
        openaiBaseUrl: 'https://api.openai.com',
        hasOpenAIKey: true,
      }),
    });

    for (const [path, fn, chunked] of [
      ['chunked', 'match_memory_embedding_chunks', true],
      ['legacy', 'match_memories', false],
    ] as const) {
      it(`passes the canonical owner to ${fn}, and drops a row the RPC should not have returned`, async () => {
        (repo as any).embeddingRouter = embeddingRouter(chunked);
        const rpc = vi.fn().mockResolvedValue({
          data: [
            { ...memoryRow({ id: 'own' }), embedding: null, similarity: 0.9 },
            // A same-slug peer from another workspace, as an RPC that ignored
            // p_sb_id would return it.
            {
              ...memoryRow({ id: 'peer', sb_id: 'sb-other-lumen' }),
              embedding: null,
              similarity: 0.95,
            },
            {
              ...memoryRow({ id: 'shared', agent_id: null, sb_id: null }),
              embedding: null,
              similarity: 0.99,
            },
          ],
          error: null,
        });
        (db as any).rpc = rpc;

        const results = await repo.recall('user-1', 'fact', { ...OWNER, recallMode: 'semantic' });

        const [calledFn, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
        expect(calledFn).toBe(fn);
        expect(args).toMatchObject({ p_agent_id: 'lumen', p_sb_id: 'sb-lumen' });
        // The server no longer sends the shared flag at all (§3.5).
        expect(args).not.toHaveProperty('p_include_shared');
        expect(results.map((m) => m.id)).toEqual(['own']);
        void path;
      });
    }
  });

  describe('history, restore, forget and update', () => {
    it("an SB's history read is confined to rows it owns; a person's is not", async () => {
      db._setArrayData([]);
      await repo.getMemoryHistory('mem-1', 'user-1', 'sb-lumen');
      expect(calls(db._queryBuilder.eq)).toContainEqual(['sb_id', 'sb-lumen']);

      db._reset();
      db._setArrayData([]);
      await repo.getMemoryHistory('mem-1', 'user-1');
      expect(calls(db._queryBuilder.eq).some(([key]) => key === 'sb_id')).toBe(false);

      db._reset();
      db._setArrayData([]);
      await repo.getUserMemoryHistory('user-1', { ownerSbId: 'sb-lumen' });
      expect(calls(db._queryBuilder.eq)).toContainEqual(['sb_id', 'sb-lumen']);
    });

    it('recreates a deleted memory under its recorded owner and contact scope', async () => {
      db._queueReturnData(historyRow()); // the history row
      vi.spyOn(repo, 'getMemory').mockResolvedValue(null); // deleted
      db._queueReturnData(memoryRow({ contact_id: 'contact-1' })); // the insert

      await repo.restoreMemory('hist-1', 'user-1');

      expect(db._queryBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'lumen',
          sb_id: 'sb-lumen',
          contact_id: 'contact-1',
        })
      );
    });

    it('refuses to recreate a deleted memory whose history recorded no owner', async () => {
      db._queueReturnData(historyRow({ agent_id: null, sb_id: null }));
      vi.spyOn(repo, 'getMemory').mockResolvedValue(null);

      await expect(repo.restoreMemory('hist-1', 'user-1')).rejects.toThrow('recorded an owner');
      expect(db._queryBuilder.insert).not.toHaveBeenCalled();
    });

    it('refuses to rewrite a live memory that has no owner', async () => {
      db._queueReturnData(historyRow({ change_type: 'update' }));
      vi.spyOn(repo, 'getMemory').mockResolvedValue({
        id: 'mem-1',
        userId: 'user-1',
        content: 'shared',
        source: 'observation',
        salience: 'medium',
        topics: [],
        metadata: {},
        version: 2,
        createdAt: new Date(),
      });

      await expect(repo.restoreMemory('hist-1', 'user-1')).rejects.toThrow('has no owner');
      expect(db._queryBuilder.update).not.toHaveBeenCalled();
    });

    it('lets an SB restore only onto its own memory, and confines its history lookup', async () => {
      db._queueReturnData(historyRow({ change_type: 'update' }));
      vi.spyOn(repo, 'getMemory').mockResolvedValue({
        id: 'mem-1',
        userId: 'user-1',
        content: 'theirs',
        source: 'observation',
        salience: 'medium',
        topics: [],
        metadata: {},
        version: 2,
        sbSlug: 'wren',
        sbId: 'sb-wren',
        createdAt: new Date(),
      });

      await expect(repo.restoreMemory('hist-1', 'user-1', 'sb-lumen')).resolves.toBeNull();
      expect(calls(db._queryBuilder.eq)).toContainEqual(['sb_id', 'sb-lumen']);
      expect(db._queryBuilder.update).not.toHaveBeenCalled();
    });

    it("an SB's forget and update are confined to its own memory", async () => {
      db._setReturnData(null);
      await repo.forget('mem-1', 'user-1', 'sb-lumen');
      expect(calls(db._queryBuilder.eq)).toContainEqual(['sb_id', 'sb-lumen']);

      db._reset();
      db._setReturnData(memoryRow());
      await repo.updateMemory('mem-1', 'user-1', { salience: 'high' }, 'sb-lumen');
      expect(calls(db._queryBuilder.eq)).toContainEqual(['sb_id', 'sb-lumen']);
    });
  });
});
