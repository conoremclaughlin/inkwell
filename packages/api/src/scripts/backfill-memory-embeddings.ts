import { createSupabaseClient } from '../data/supabase/client';
import type { Database } from '../data/supabase/types';
import {
  buildChunkMetadataUpdate,
  buildChunkRows,
  buildMemoryEmbeddingChunks,
  countChunkViews,
  formatVectorLiteral,
  MEMORY_EMBEDDING_CHUNKS_VERSION,
} from '../services/embeddings/memory-chunks';
import { EmbeddingRouter } from '../services/embeddings/router';
import { getVettedEmbeddingModel } from '../services/embeddings/vetted-models';

type MemoryRow = Database['public']['Tables']['memories']['Row'];

const DEFAULT_BATCH_SIZE = 100;

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function parsePositiveInt(raw: string | undefined, defaultValue: number): number {
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

async function main() {
  const userId = process.env.BACKFILL_MEMORY_USER_ID;
  if (!userId) {
    throw new Error(
      'BACKFILL_MEMORY_USER_ID is required. Example: BACKFILL_MEMORY_USER_ID=<uuid> yarn backfill:memory-embeddings'
    );
  }

  const agentId = process.env.BACKFILL_MEMORY_AGENT_ID;
  const batchSize = parsePositiveInt(process.env.BACKFILL_MEMORY_BATCH_SIZE, DEFAULT_BATCH_SIZE);
  const limit = process.env.BACKFILL_MEMORY_LIMIT
    ? parsePositiveInt(process.env.BACKFILL_MEMORY_LIMIT, batchSize)
    : null;
  const dryRun = parseBoolean(process.env.BACKFILL_MEMORY_DRY_RUN, false);

  const router = new EmbeddingRouter();
  if (!router.isEnabled()) {
    throw new Error(
      'Memory embeddings are disabled. Run `sb memory install` or set MEMORY_EMBEDDINGS_ENABLED=true before backfilling.'
    );
  }
  const config = router.getRuntimeConfig();
  const vettedModel = getVettedEmbeddingModel(config.provider, config.model);

  const supabase = createSupabaseClient();

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let scanned = 0;

  while (limit === null || scanned < limit) {
    const remaining = limit === null ? batchSize : Math.min(batchSize, limit - scanned);
    if (remaining <= 0) break;

    let query = supabase
      .from('memories')
      .select(
        'id,user_id,agent_id,content,summary,metadata,embedding,embedding_chunks_version,embedding_chunk_count'
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .range(scanned, scanned + remaining - 1);

    if (agentId) {
      query = query.eq('agent_id', agentId);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to fetch memories for backfill: ${error.message}`);
    }

    const rows = (data || []) as Pick<
      MemoryRow,
      | 'id'
      | 'user_id'
      | 'agent_id'
      | 'content'
      | 'summary'
      | 'metadata'
      | 'embedding'
      | 'embedding_chunks_version'
      | 'embedding_chunk_count'
    >[];

    if (rows.length === 0) break;
    scanned += rows.length;

    for (const row of rows) {
      processed += 1;
      const hasCurrentChunks =
        row.embedding_chunks_version === MEMORY_EMBEDDING_CHUNKS_VERSION &&
        (row.embedding_chunk_count || 0) > 0;

      if (hasCurrentChunks) {
        skipped += 1;
        continue;
      }

      const chunks = buildMemoryEmbeddingChunks({
        summary: row.summary,
        content: row.content,
        topicKey: row.topic_key,
        topics: row.topics,
        source: row.source,
        salience: row.salience,
        model: vettedModel,
      });
      if (chunks.length === 0) {
        skipped += 1;
        continue;
      }

      const embeddedChunks = [];
      for (const chunk of chunks) {
        const embedding = await router.embedDocument(chunk.text);
        if (!embedding) continue;
        embeddedChunks.push({ chunk, embedding });
      }

      if (embeddedChunks.length === 0) {
        skipped += 1;
        continue;
      }

      const primaryEmbedding = embeddedChunks[0].embedding;
      const chunkRows = buildChunkRows({
        memoryId: row.id,
        userId: row.user_id,
        chunks: embeddedChunks.map(({ chunk, embedding }) => ({ ...chunk, embedding })),
      });

      if (dryRun) {
        console.log(
          `DRY RUN would backfill memory ${row.id} (${row.agent_id || 'shared'}) with ${embeddedChunks.length} chunk(s) via ${primaryEmbedding.provider}:${primaryEmbedding.model}`
        );
        updated += 1;
        continue;
      }

      const { error: chunkDeleteError } = await supabase
        .from('memory_embedding_chunks')
        .delete()
        .eq('memory_id', row.id);

      if (chunkDeleteError) {
        throw new Error(`Failed to clear chunks for memory ${row.id}: ${chunkDeleteError.message}`);
      }

      const { error: chunkUpsertError } = await supabase
        .from('memory_embedding_chunks')
        .upsert(chunkRows, { onConflict: 'memory_id,chunk_index' });

      if (chunkUpsertError) {
        throw new Error(
          `Failed to upsert chunks for memory ${row.id}: ${chunkUpsertError.message}`
        );
      }

      const { error: updateError } = await supabase
        .from('memories')
        .update({
          embedding: formatVectorLiteral(primaryEmbedding.vector),
          embedding_chunks_version: MEMORY_EMBEDDING_CHUNKS_VERSION,
          embedding_chunk_count: embeddedChunks.length,
          metadata: {
            ...buildChunkMetadataUpdate({
              provider: primaryEmbedding.provider,
              model: primaryEmbedding.model,
              chunkCount: embeddedChunks.length,
              viewCounts: countChunkViews(embeddedChunks.map(({ chunk }) => chunk)),
              existingMetadata: ((row.metadata as Record<string, unknown> | null) || {}) as Record<
                string,
                unknown
              > | null,
            }),
            embedding: {
              provider: primaryEmbedding.provider,
              model: primaryEmbedding.model,
              dimensions: primaryEmbedding.dimensions,
              updatedAt: new Date().toISOString(),
              backfilled: true,
            },
          } as Database['public']['Tables']['memories']['Update']['metadata'],
        })
        .eq('id', row.id)
        .eq('user_id', row.user_id);

      if (updateError) {
        throw new Error(`Failed to update memory ${row.id}: ${updateError.message}`);
      }

      updated += 1;
      console.log(
        `Backfilled memory ${row.id} (${row.agent_id || 'shared'}) with ${embeddedChunks.length} chunk(s) via ${primaryEmbedding.provider}:${primaryEmbedding.model}`
      );
    }
  }

  console.log(
    `Backfill complete. scanned=${scanned} processed=${processed} updated=${updated} skipped=${skipped} dryRun=${dryRun}`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
