import {
  DEFAULT_MEMORY_LLM_MODEL,
  MEMORY_EMBEDDING_CHUNKS_VERSION,
  MEMORY_EXTRACTION_VERSION,
} from '@inklabs/api/benchmarks';

export type BenchmarkPhase = 'all' | 'seed' | 'recall';

export function parseBenchmarkPhase(raw?: string): BenchmarkPhase {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'seed' || normalized === 'recall' || normalized === 'all') return normalized;
  if (normalized) {
    console.warn(`[memory-benchmark] Unknown MEMORY_BENCHMARK_PHASE=${raw}; using all`);
  }
  return 'all';
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Any setting that changes how memories are chunked, embedded, or extracted must be
 * represented here. Missing dimensions cause stale seed reuse across config changes,
 * which silently corrupts ablation comparisons.
 */
export function buildRepresentationKey(env: NodeJS.ProcessEnv = process.env): string {
  const parts = [
    'chunked',
    `chunks-v${MEMORY_EMBEDDING_CHUNKS_VERSION}`,
    env.MEMORY_EMBEDDINGS_ENABLED || 'default',
    env.MEMORY_EMBEDDING_PROVIDER || 'default',
    env.MEMORY_EMBEDDING_MODEL || 'default',
    env.MEMORY_EXTRACTION_MODE || 'heuristic',
    `extract-v${MEMORY_EXTRACTION_VERSION}`,
    env.MEMORY_LLM_EXTRACTION_ENABLED || 'false',
    env.MEMORY_LLM_MODEL || DEFAULT_MEMORY_LLM_MODEL,
    env.MEMORY_LLM_ENTITY_ENABLED || 'false',
    env.MEMORY_LLM_DURABLE_FACT_ENABLED || 'false',
    env.MEMORY_LLM_SUMMARY_ENABLED || 'false',
    env.MEMORY_LLM_CURRENT_STATE_ENABLED || 'false',
  ];
  return slugify(parts.join('-'));
}
