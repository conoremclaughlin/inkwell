import { createSupabaseClient } from '../data/supabase/client';
import type { Database } from '../data/supabase/types';
import { formatVectorLiteral } from '../services/embeddings/memory-chunks';
import { EmbeddingRouter } from '../services/embeddings/router';

type ArtifactRow = Database['public']['Tables']['artifacts']['Row'];

const DEFAULT_BATCH_SIZE = 50;

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
  const userId = process.env.BACKFILL_ARTIFACT_USER_ID;
  if (!userId) {
    throw new Error(
      'BACKFILL_ARTIFACT_USER_ID is required. Example: BACKFILL_ARTIFACT_USER_ID=<uuid> yarn backfill:artifact-embeddings'
    );
  }

  const artifactType = process.env.BACKFILL_ARTIFACT_TYPE;
  const batchSize = parsePositiveInt(process.env.BACKFILL_ARTIFACT_BATCH_SIZE, DEFAULT_BATCH_SIZE);
  const limit = process.env.BACKFILL_ARTIFACT_LIMIT
    ? parsePositiveInt(process.env.BACKFILL_ARTIFACT_LIMIT, batchSize)
    : null;
  const dryRun = parseBoolean(process.env.BACKFILL_ARTIFACT_DRY_RUN, false);

  const router = new EmbeddingRouter();
  if (!router.isEnabled()) {
    throw new Error(
      'Embeddings are disabled. Set MEMORY_EMBEDDINGS_ENABLED=true before backfilling.'
    );
  }

  const supabase = createSupabaseClient();

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let scanned = 0;
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;

  while (limit === null || scanned < limit) {
    const remaining = limit === null ? batchSize : Math.min(batchSize, limit - scanned);
    if (remaining <= 0) break;

    let query = supabase
      .from('artifacts')
      .select('id,user_id,title,content,artifact_type,metadata,embedding,created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(remaining);

    if (artifactType) {
      query = query.eq('artifact_type', artifactType);
    }

    // Keyset pagination: advance past last seen (created_at, id)
    if (cursorCreatedAt && cursorId) {
      query = query.or(
        `created_at.gt.${cursorCreatedAt},and(created_at.eq.${cursorCreatedAt},id.gt.${cursorId})`
      );
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to fetch artifacts for backfill: ${error.message}`);
    }

    const rows = (data || []) as (Pick<
      ArtifactRow,
      'id' | 'user_id' | 'title' | 'content' | 'artifact_type' | 'metadata' | 'embedding'
    > & { created_at: string })[];

    if (rows.length === 0) break;
    scanned += rows.length;

    // Advance cursor to last row in batch
    const lastRow = rows[rows.length - 1];
    cursorCreatedAt = lastRow.created_at;
    cursorId = lastRow.id;

    for (const row of rows) {
      processed += 1;

      if (row.embedding) {
        skipped += 1;
        continue;
      }

      const textToEmbed = `${row.title}\n\n${row.content}`;
      const result = await router.embedDocument(textToEmbed);
      if (!result) {
        console.error(`Failed to generate embedding for artifact ${row.id}, skipping`);
        skipped += 1;
        continue;
      }

      if (dryRun) {
        console.log(
          `DRY RUN would backfill artifact ${row.id} (${row.artifact_type}) via ${result.provider}:${result.model}`
        );
        updated += 1;
        continue;
      }

      const existingMetadata = ((row.metadata as Record<string, unknown> | null) || {}) as Record<
        string,
        unknown
      >;

      const { error: updateError } = await supabase
        .from('artifacts')
        .update({
          embedding: formatVectorLiteral(result.vector),
          metadata: {
            ...existingMetadata,
            embedding: {
              provider: result.provider,
              model: result.model,
              dimensions: result.dimensions,
              updatedAt: new Date().toISOString(),
              backfilled: true,
            },
          } as Database['public']['Tables']['artifacts']['Update']['metadata'],
        })
        .eq('id', row.id);

      if (updateError) {
        throw new Error(`Failed to update artifact ${row.id}: ${updateError.message}`);
      }

      updated += 1;
      console.log(
        `Backfilled artifact ${row.id} (${row.artifact_type}) via ${result.provider}:${result.model}`
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
