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
import { env } from '../config/env';

type MemoryRow = Database['public']['Tables']['memories']['Row'];

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_PROGRESS_EVERY = 100;
const DEFAULT_ROW_ATTEMPTS = 3;

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function parsePositiveInt(raw: string | undefined, defaultValue: number): number {
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function parseNonNegativeInt(raw: string | undefined, defaultValue: number): number {
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const userId = process.env.BACKFILL_MEMORY_USER_ID || process.env.BENCHMARK_USER_ID;
  if (!userId) {
    throw new Error(
      'BACKFILL_MEMORY_USER_ID or BENCHMARK_USER_ID is required. Example: BACKFILL_MEMORY_USER_ID=<uuid> yarn backfill:memory-embeddings'
    );
  }

  const agentId = process.env.BACKFILL_MEMORY_AGENT_ID;
  const topic = process.env.BACKFILL_MEMORY_TOPIC;
  const memoryId = process.env.BACKFILL_MEMORY_ID;
  const batchSize = parsePositiveInt(process.env.BACKFILL_MEMORY_BATCH_SIZE, DEFAULT_BATCH_SIZE);
  const startOffset = parseNonNegativeInt(process.env.BACKFILL_MEMORY_OFFSET, 0);
  const limit = process.env.BACKFILL_MEMORY_LIMIT
    ? parsePositiveInt(process.env.BACKFILL_MEMORY_LIMIT, batchSize)
    : null;
  const progressEvery = parsePositiveInt(
    process.env.BACKFILL_MEMORY_PROGRESS_EVERY,
    DEFAULT_PROGRESS_EVERY
  );
  const maxRowAttempts = parsePositiveInt(
    process.env.BACKFILL_MEMORY_ROW_ATTEMPTS,
    DEFAULT_ROW_ATTEMPTS
  );
  const continueOnError = parseBoolean(process.env.BACKFILL_MEMORY_CONTINUE_ON_ERROR, false);
  const dryRun = parseBoolean(process.env.BACKFILL_MEMORY_DRY_RUN, false);
  const force = parseBoolean(process.env.MEMORY_EMBEDDINGS_FORCE, false);

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
  let failed = 0;
  let scanned = 0;
  let cursor = startOffset;
  const failures: Array<{ memoryId: string; message: string }> = [];

  console.log(
    `[memory-embedding-backfill] user=${userId} agent=${agentId || '*'} memory=${memoryId || '*'} topic=${topic || '*'} ` +
      `offset=${startOffset} limit=${limit ?? 'all'} batchSize=${batchSize} force=${force} dryRun=${dryRun} ` +
      `continueOnError=${continueOnError} rowAttempts=${maxRowAttempts} ` +
      `mode=${env.MEMORY_EXTRACTION_MODE} chunkVersion=${MEMORY_EMBEDDING_CHUNKS_VERSION}`
  );

  while (limit === null || scanned < limit) {
    const remaining = limit === null ? batchSize : Math.min(batchSize, limit - scanned);
    if (remaining <= 0) break;

    let query = supabase
      .from('memories')
      .select(
        'id,user_id,agent_id,content,summary,topic_key,topics,source,salience,metadata,embedding,embedding_chunks_version,embedding_chunk_count'
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .range(cursor, cursor + remaining - 1);

    if (agentId) {
      query = query.eq('agent_id', agentId);
    }

    if (topic?.trim()) {
      query = query.contains('topics', [topic.trim()]);
    }

    if (memoryId?.trim()) {
      query = query.eq('id', memoryId.trim());
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
      | 'topic_key'
      | 'topics'
      | 'source'
      | 'salience'
      | 'metadata'
      | 'embedding'
      | 'embedding_chunks_version'
      | 'embedding_chunk_count'
    >[];

    if (rows.length === 0) break;
    scanned += rows.length;
    cursor += rows.length;

    for (const row of rows) {
      processed += 1;
      let lastError: unknown = null;

      for (let attempt = 1; attempt <= maxRowAttempts; attempt += 1) {
        try {
          const hasCurrentChunks =
            row.embedding_chunks_version === MEMORY_EMBEDDING_CHUNKS_VERSION &&
            (row.embedding_chunk_count || 0) > 0;

          if (hasCurrentChunks && !force) {
            skipped += 1;
            lastError = null;
            break;
          }

          const chunks = buildMemoryEmbeddingChunks({
            summary: row.summary,
            content: row.content,
            topicKey: row.topic_key,
            topics: row.topics,
            source: row.source,
            salience: row.salience,
            model: vettedModel,
            extractionMode: env.MEMORY_EXTRACTION_MODE,
            llmExtractions:
              row.metadata && typeof row.metadata === 'object' && 'llm_extractions' in row.metadata
                ? (row.metadata.llm_extractions as Record<string, unknown>)
                : null,
          });
          if (chunks.length === 0) {
            skipped += 1;
            lastError = null;
            break;
          }

          const embeddedChunks = [];
          for (const chunk of chunks) {
            const embedding = await router.embedDocument(chunk.text);
            if (!embedding) continue;
            embeddedChunks.push({ chunk, embedding });
          }

          if (embeddedChunks.length === 0) {
            skipped += 1;
            lastError = null;
            break;
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
            lastError = null;
            break;
          }

          const { error: chunkDeleteError } = await supabase
            .from('memory_embedding_chunks')
            .delete()
            .eq('memory_id', row.id);

          if (chunkDeleteError) {
            throw new Error(
              `Failed to clear chunks for memory ${row.id}: ${chunkDeleteError.message}`
            );
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
                  extractionMode: env.MEMORY_EXTRACTION_MODE,
                  existingMetadata: ((row.metadata as Record<string, unknown> | null) ||
                    {}) as Record<string, unknown> | null,
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
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const message = error instanceof Error ? error.message : String(error);
          console.warn(
            `[memory-embedding-backfill] memory=${row.id} failed attempt=${attempt}/${maxRowAttempts} retrying=${attempt < maxRowAttempts}: ${message}`
          );
          if (attempt < maxRowAttempts) {
            await sleep(500 * attempt);
          }
        }
      }

      if (lastError) {
        const message = lastError instanceof Error ? lastError.message : String(lastError);
        failed += 1;
        failures.push({ memoryId: row.id, message });
        if (!continueOnError) {
          throw new Error(message);
        }
      }

      if (processed % progressEvery === 0) {
        console.log(
          `[memory-embedding-backfill] progress offset=${startOffset} cursor=${cursor} scanned=${scanned} processed=${processed} updated=${updated} skipped=${skipped} failed=${failed}`
        );
      }
    }
  }

  console.log(
    `[memory-embedding-backfill] complete offset=${startOffset} scanned=${scanned} processed=${processed} updated=${updated} skipped=${skipped} failed=${failed} dryRun=${dryRun}`
  );
  if (failures.length > 0) {
    console.log(
      JSON.stringify(
        {
          failures: failures.slice(0, 20),
          failureCount: failures.length,
        },
        null,
        2
      )
    );
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
