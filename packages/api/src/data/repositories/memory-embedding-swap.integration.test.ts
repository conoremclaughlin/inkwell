/**
 * The two embedding functions, against a real database.
 *
 * memory-refresh-contract.test.ts drives the repository against a harness that
 * implements swap_memory_embedding and clear_memory_embedding in TypeScript.
 * That harness proves what the repository SENDS and how it reads each reply —
 * and nothing whatsoever about the SQL, because a fake written by the same
 * person as the caller agrees with the caller by construction. A mutation run
 * made that concrete: breaking the fence could not turn any unit test red,
 * because the fence being tested was the harness's own.
 *
 * So the properties that live in the function live here:
 *
 *   - the revision fence actually refuses a stale writer;
 *   - the metadata merge preserves keys the caller never mentioned;
 *   - the swap is atomic, so a failure leaves neither store half-written;
 *   - the chunk replacement removes surplus rows rather than accumulating them.
 *
 * Run via: yarn workspace @inklabs/api test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDataComposer, type DataComposer } from '../composer';
import { ensureEchoIntegrationFixture } from '../../test/integration-fixtures';

const VECTOR_DIMENSIONS = 1024;

/** A vector literal the pgvector column will accept. */
function vectorLiteral(seed: number): string {
  return `[${Array.from({ length: VECTOR_DIMENSIONS }, () => seed).join(',')}]`;
}

function chunkPayload(memoryId: string, userId: string, texts: string[], seed: number) {
  return texts.map((text, index) => ({
    memory_id: memoryId,
    user_id: userId,
    chunk_index: index,
    chunk_type: 'content',
    chunk_text: text,
    embedding: vectorLiteral(seed),
    metadata: { probe: true },
  }));
}

describe('memory embedding swap functions', () => {
  let dataComposer: DataComposer;
  let userId: string;
  const createdMemoryIds: string[] = [];

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    userId = fixture.userId;
  });

  afterAll(async () => {
    if (!dataComposer || createdMemoryIds.length === 0) return;
    const client = dataComposer.getClient();
    await client.from('memory_embedding_chunks').delete().in('memory_id', createdMemoryIds);
    await client.from('memory_history').delete().in('memory_id', createdMemoryIds);
    await client.from('memories').delete().in('id', createdMemoryIds);
  });

  /** A memory with one chunk already published, at a known revision. */
  async function seedMemory(metadata: Record<string, unknown> = {}) {
    const client = dataComposer.getClient();
    const { data, error } = await client
      .from('memories')
      .insert({
        user_id: userId,
        content: 'Original content',
        source: 'observation',
        salience: 'medium',
        topics: [],
        metadata,
      })
      .select()
      .single();
    if (error || !data) throw new Error(`seed failed: ${error?.message}`);
    createdMemoryIds.push(data.id);

    const seeded = await client.rpc('swap_memory_embedding', {
      p_memory_id: data.id,
      p_user_id: userId,
      p_expected_version: data.version,
      p_chunks: chunkPayload(data.id, userId, ['Original content', 'Original extra'], 1),
      p_embedding: vectorLiteral(1),
      p_chunks_version: 1,
      p_chunk_count: 2,
      p_metadata_patch: { embedding: { model: 'seed' } },
    });
    expect(seeded.error).toBeNull();
    expect(seeded.data).toBe('ok');

    return { id: data.id as string, version: data.version as number };
  }

  async function readChunks(memoryId: string) {
    const { data } = await dataComposer
      .getClient()
      .from('memory_embedding_chunks')
      .select('chunk_index, chunk_text')
      .eq('memory_id', memoryId)
      .order('chunk_index');
    return (data || []).map((row) => row.chunk_text);
  }

  async function readMemory(memoryId: string) {
    const { data } = await dataComposer
      .getClient()
      .from('memories')
      .select('version, metadata, embedding_chunk_count')
      .eq('id', memoryId)
      .single();
    return data!;
  }

  it('refuses a writer whose revision has been superseded', async () => {
    const memory = await seedMemory();
    const client = dataComposer.getClient();

    // A text edit bumps `version` through the archive trigger — this is the
    // winning revision.
    await client
      .from('memories')
      .update({ content: 'Corrected content' })
      .eq('id', memory.id)
      .eq('user_id', userId);

    // The stale writer arrives with the version it read before embedding.
    const { data, error } = await client.rpc('swap_memory_embedding', {
      p_memory_id: memory.id,
      p_user_id: userId,
      p_expected_version: memory.version,
      p_chunks: chunkPayload(memory.id, userId, ['Stale content'], 9),
      p_embedding: vectorLiteral(9),
      p_chunks_version: 1,
      p_chunk_count: 1,
      p_metadata_patch: { embedding: { model: 'stale' } },
    });

    expect(error).toBeNull();
    expect(data).toBe('superseded');

    // And it published nothing: this is the assertion the unit tests cannot
    // make, because there the fence is the harness's own code.
    expect(await readChunks(memory.id)).toEqual(['Original content', 'Original extra']);
    const row = await readMemory(memory.id);
    expect((row.metadata as Record<string, unknown>).embedding).toEqual({ model: 'seed' });
  });

  it('merges the patch onto whatever the row holds at commit time', async () => {
    // The protection against a caller's pre-embed snapshot. A metadata-only
    // write does NOT bump version, so it passes the fence honestly — only the
    // merge keeps it.
    const memory = await seedMemory({ ownedByCaller: 'original' });
    const client = dataComposer.getClient();

    await client
      .from('memories')
      .update({ metadata: { ownedByCaller: 'written during the embed' } })
      .eq('id', memory.id)
      .eq('user_id', userId);

    const { data, error } = await client.rpc('swap_memory_embedding', {
      p_memory_id: memory.id,
      p_user_id: userId,
      p_expected_version: memory.version,
      p_chunks: chunkPayload(memory.id, userId, ['Fresh content'], 2),
      p_embedding: vectorLiteral(2),
      p_chunks_version: 1,
      p_chunk_count: 1,
      p_metadata_patch: { embedding: { model: 'fresh' } },
    });

    expect(error).toBeNull();
    expect(data).toBe('ok');

    const row = await readMemory(memory.id);
    const metadata = row.metadata as Record<string, unknown>;
    expect(metadata.ownedByCaller).toBe('written during the embed');
    expect(metadata.embedding).toEqual({ model: 'fresh' });
  });

  it('replaces the chunk set rather than accumulating it', async () => {
    // A re-embed producing fewer chunks must not leave the surplus behind: the
    // chunk search RPC reads those rows directly and never consults the
    // memory's chunk count.
    const memory = await seedMemory();

    const { data } = await dataComposer.getClient().rpc('swap_memory_embedding', {
      p_memory_id: memory.id,
      p_user_id: userId,
      p_expected_version: memory.version,
      p_chunks: chunkPayload(memory.id, userId, ['Only one chunk now'], 3),
      p_embedding: vectorLiteral(3),
      p_chunks_version: 1,
      p_chunk_count: 1,
      p_metadata_patch: {},
    });

    expect(data).toBe('ok');
    expect(await readChunks(memory.id)).toEqual(['Only one chunk now']);
    expect((await readMemory(memory.id)).embedding_chunk_count).toBe(1);
  });

  it('leaves both stores untouched when the swap fails partway', async () => {
    // Atomicity, demonstrated by a payload the insert must reject: a chunk
    // whose vector has the wrong dimensions. The chunk delete happens BEFORE
    // that insert, so without a transaction the old rows would already be gone.
    const memory = await seedMemory();

    const { error } = await dataComposer.getClient().rpc('swap_memory_embedding', {
      p_memory_id: memory.id,
      p_user_id: userId,
      p_expected_version: memory.version,
      p_chunks: [
        {
          memory_id: memory.id,
          user_id: userId,
          chunk_index: 0,
          chunk_type: 'content',
          chunk_text: 'Malformed',
          embedding: '[1,2,3]',
          metadata: {},
        },
      ],
      p_embedding: vectorLiteral(4),
      p_chunks_version: 1,
      p_chunk_count: 1,
      p_metadata_patch: { embedding: { model: 'never applied' } },
    });

    expect(error).toBeTruthy();
    expect(await readChunks(memory.id)).toEqual(['Original content', 'Original extra']);
    const row = await readMemory(memory.id);
    expect((row.metadata as Record<string, unknown>).embedding).toEqual({ model: 'seed' });
  });

  it('clears both stores together, and refuses to clear a superseded revision', async () => {
    const memory = await seedMemory({ ownedByCaller: 'keep me' });
    const client = dataComposer.getClient();

    // A stale cleanup must not delete the winner's artifacts.
    await client
      .from('memories')
      .update({ content: 'Corrected content' })
      .eq('id', memory.id)
      .eq('user_id', userId);

    const stale = await client.rpc('clear_memory_embedding', {
      p_memory_id: memory.id,
      p_user_id: userId,
      p_expected_version: memory.version,
      p_metadata_remove: ['embedding'],
    });
    expect(stale.data).toBe('superseded');
    expect(await readChunks(memory.id)).toEqual(['Original content', 'Original extra']);

    // At the current revision it clears, and only the named keys go.
    const current = await readMemory(memory.id);
    const applied = await client.rpc('clear_memory_embedding', {
      p_memory_id: memory.id,
      p_user_id: userId,
      p_expected_version: current.version,
      p_metadata_remove: ['embedding'],
    });
    expect(applied.data).toBe('ok');
    expect(await readChunks(memory.id)).toEqual([]);

    const cleared = await readMemory(memory.id);
    const metadata = cleared.metadata as Record<string, unknown>;
    expect(metadata.embedding).toBeUndefined();
    expect(metadata.ownedByCaller).toBe('keep me');
  });

  it('reports a memory that is not there rather than pretending to write', async () => {
    const { data } = await dataComposer.getClient().rpc('swap_memory_embedding', {
      p_memory_id: '00000000-0000-4000-8000-000000000000',
      p_user_id: userId,
      p_expected_version: 1,
      p_chunks: [],
      p_embedding: vectorLiteral(5),
      p_chunks_version: 1,
      p_chunk_count: 0,
      p_metadata_patch: {},
    });
    expect(data).toBe('missing');
  });

  it('drops cached extractions and leaves everything else alone', async () => {
    const memory = await seedMemory({
      llm_extractions: { durable_fact: 'the project uses OldDB' },
      ownedByCaller: 'keep me',
    });

    const { error } = await dataComposer.getClient().rpc('invalidate_memory_extractions', {
      p_memory_id: memory.id,
      p_user_id: userId,
    });
    expect(error).toBeNull();

    const metadata = (await readMemory(memory.id)).metadata as Record<string, unknown>;
    expect(metadata.llm_extractions).toBeUndefined();
    expect(metadata.ownedByCaller).toBe('keep me');
    expect(metadata.embedding).toEqual({ model: 'seed' });
  });
});
