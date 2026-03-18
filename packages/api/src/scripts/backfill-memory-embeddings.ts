import { createSupabaseClient } from '../data/supabase/client';
import type { Database } from '../data/supabase/types';
import { EmbeddingRouter } from '../services/embeddings/router';

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

function buildEmbeddingText(memory: Pick<MemoryRow, 'summary' | 'content'>): string {
  return [memory.summary, memory.content].filter(Boolean).join('\n\n').trim();
}

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
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

  const supabase = createSupabaseClient();

  let processed = 0;
  let updated = 0;
  let skipped = 0;

  while (limit === null || processed < limit) {
    const remaining = limit === null ? batchSize : Math.min(batchSize, limit - processed);
    if (remaining <= 0) break;

    let query = supabase
      .from('memories')
      .select('id,user_id,agent_id,content,summary,metadata')
      .eq('user_id', userId)
      .is('embedding', null)
      .order('created_at', { ascending: true })
      .limit(remaining);

    if (agentId) {
      query = query.eq('agent_id', agentId);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to fetch memories for backfill: ${error.message}`);
    }

    const rows = (data || []) as Pick<
      MemoryRow,
      'id' | 'user_id' | 'agent_id' | 'content' | 'summary' | 'metadata'
    >[];

    if (rows.length === 0) break;

    for (const row of rows) {
      const text = buildEmbeddingText(row);
      processed += 1;

      if (!text) {
        skipped += 1;
        continue;
      }

      const embedding = await router.embedDocument(text);
      if (!embedding) {
        skipped += 1;
        continue;
      }

      if (dryRun) {
        console.log(
          `DRY RUN would backfill memory ${row.id} (${row.agent_id || 'shared'}) with ${embedding.dimensions}-dim ${embedding.provider}:${embedding.model}`
        );
        updated += 1;
        continue;
      }

      const { error: updateError } = await supabase
        .from('memories')
        .update({
          embedding: toVectorLiteral(embedding.vector),
          metadata: {
            ...((row.metadata as Record<string, unknown> | null) || {}),
            embedding: {
              provider: embedding.provider,
              model: embedding.model,
              dimensions: embedding.dimensions,
              updatedAt: new Date().toISOString(),
              backfilled: true,
            },
          },
        })
        .eq('id', row.id)
        .eq('user_id', row.user_id);

      if (updateError) {
        throw new Error(`Failed to update memory ${row.id}: ${updateError.message}`);
      }

      updated += 1;
      console.log(
        `Backfilled memory ${row.id} (${row.agent_id || 'shared'}) with ${embedding.provider}:${embedding.model}`
      );
    }
  }

  console.log(
    `Backfill complete. processed=${processed} updated=${updated} skipped=${skipped} dryRun=${dryRun}`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
