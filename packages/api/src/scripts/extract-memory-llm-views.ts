import { createSupabaseClient } from '../data/supabase/client';
import type { Database } from '../data/supabase/types';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  buildCurrentStateEmbeddingTexts,
  buildDurableFactEmbeddingTexts,
  buildEntityEmbeddingTexts,
  buildSummaryEmbeddingTexts,
  MemoryLlmExtractor,
  type MemoryExtractions,
} from '../services/memory-llm-extraction';

type MemoryRow = Database['public']['Tables']['memories']['Row'];

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function parsePositiveInt(raw: string | undefined, defaultValue: number): number {
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultValue;
}

function buildExtractionEmbeddingTexts(
  llmExtractions: MemoryExtractions
): Record<string, string[]> {
  return {
    entity: llmExtractions.entity ? buildEntityEmbeddingTexts(llmExtractions.entity) : [],
    durable_fact: llmExtractions.durable_fact
      ? buildDurableFactEmbeddingTexts(llmExtractions.durable_fact)
      : [],
    summary: llmExtractions.summary ? buildSummaryEmbeddingTexts(llmExtractions.summary) : [],
    current_state: llmExtractions.current_state
      ? buildCurrentStateEmbeddingTexts(llmExtractions.current_state)
      : [],
  };
}

async function main() {
  const userId = process.env.MEMORY_LLM_EXTRACT_USER_ID || process.env.BENCHMARK_USER_ID;
  if (!userId) {
    throw new Error('MEMORY_LLM_EXTRACT_USER_ID or BENCHMARK_USER_ID is required');
  }

  const limit = parsePositiveInt(process.env.MEMORY_LLM_EXTRACT_LIMIT, 100);
  const offset = parsePositiveInt(process.env.MEMORY_LLM_EXTRACT_OFFSET, 0);
  const topic = process.env.MEMORY_LLM_EXTRACT_TOPIC;
  const dryRun = parseBoolean(process.env.MEMORY_LLM_EXTRACT_DRY_RUN, false);
  const force = parseBoolean(process.env.MEMORY_LLM_EXTRACT_FORCE, false);
  const outputPath =
    process.env.MEMORY_LLM_EXTRACT_OUTPUT_PATH ||
    resolve(
      process.cwd(),
      'output',
      'memory-extractions',
      `memory-llm-extract-${Date.now()}.jsonl`
    );

  const extractor = new MemoryLlmExtractor();
  if (!extractor.isEnabled()) {
    throw new Error(
      'Memory LLM extraction is disabled. Set MEMORY_LLM_EXTRACTION_ENABLED=true and at least one per-type flag.'
    );
  }

  const supabase = createSupabaseClient();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify({
      type: 'config',
      userId,
      topic: topic || null,
      limit,
      offset,
      dryRun,
      force,
      enabledKinds: extractor.getEnabledKinds(),
      startedAt: new Date().toISOString(),
    })}\n`
  );

  console.log(`[memory-llm-extract] auditOutput=${outputPath}`);

  let query = supabase
    .from('memories')
    .select('id,user_id,content,summary,topic_key,topics,source,salience,metadata')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);

  if (topic?.trim()) {
    query = query.contains('topics', [topic.trim()]);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load memories: ${error.message}`);

  const rows = (data || []) as Pick<
    MemoryRow,
    | 'id'
    | 'user_id'
    | 'content'
    | 'summary'
    | 'topic_key'
    | 'topics'
    | 'source'
    | 'salience'
    | 'metadata'
  >[];

  let extracted = 0;
  let skipped = 0;

  for (const row of rows) {
    const metadata = (row.metadata as Record<string, unknown> | null) || {};
    if (!force && metadata.llm_extractions) {
      skipped += 1;
      continue;
    }

    const llmExtractions = await extractor.extract({
      summary: row.summary,
      content: row.content,
      topicKey: row.topic_key,
      topics: row.topics,
      source: row.source,
      salience: row.salience,
    });

    if (!llmExtractions) {
      skipped += 1;
      continue;
    }

    if (!dryRun) {
      const { error: updateError } = await supabase
        .from('memories')
        .update({
          metadata: {
            ...metadata,
            llm_extractions: llmExtractions,
          } as Database['public']['Tables']['memories']['Update']['metadata'],
        })
        .eq('id', row.id)
        .eq('user_id', row.user_id);

      if (updateError) {
        throw new Error(`Failed to update memory ${row.id}: ${updateError.message}`);
      }
    }

    extracted += 1;
    await appendFile(
      outputPath,
      `${JSON.stringify({
        type: 'extraction',
        memoryId: row.id,
        topicKey: row.topic_key,
        topics: row.topics,
        source: row.source,
        salience: row.salience,
        summary: row.summary,
        contentLength: row.content.length,
        extractedKinds: extractor.getEnabledKinds(),
        llmExtractions,
        embeddingTexts: buildExtractionEmbeddingTexts(llmExtractions),
        dryRun,
        extractedAt: new Date().toISOString(),
      })}\n`
    );
    console.log(
      `[memory-llm-extract] ${dryRun ? 'dry-run ' : ''}extracted memory=${row.id} kinds=${extractor.getEnabledKinds().join(',')}`
    );
  }

  await appendFile(
    outputPath,
    `${JSON.stringify({
      type: 'summary',
      loaded: rows.length,
      extracted,
      skipped,
      dryRun,
      completedAt: new Date().toISOString(),
    })}\n`
  );

  console.log(
    `[memory-llm-extract] complete loaded=${rows.length} extracted=${extracted} skipped=${skipped} dryRun=${dryRun} auditOutput=${outputPath}`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
