import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './data/supabase/types';
import type { MemoryOwnerFilter } from './data/models/memory';
import { resolveSbIdResult } from './auth/resolve-identity';

export { createSupabaseClient } from './data/supabase/client';
export { MemoryRepository } from './data/repositories/memory-repository';
export { MEMORY_EMBEDDING_CHUNKS_VERSION } from './services/embeddings/memory-chunks';
export {
  DEFAULT_MEMORY_LLM_MODEL,
  MEMORY_EXTRACTION_VERSION,
} from './services/memory-llm-extraction';
export { ClaudeRunner } from './services/sessions';
export type { ClaudeRunnerConfig, IRunner } from './services/sessions';
export type {
  MemoryHybridChunkStrategy,
  MemorySemanticQueryStrategy,
  MemorySearchChunkType,
  MemorySearchOptions,
} from './data/models/memory';

export type { MemoryOwnerFilter } from './data/models/memory';

/**
 * The canonical owner of a benchmark's memories. Every memory has one owner
 * (ink://specs/remove-shared-memories), and the repository reads and writes
 * by its id, so a benchmark resolves its identity once, up front, and stops
 * when that identity does not resolve to exactly one row.
 */
export async function resolveBenchmarkOwner(
  supabase: SupabaseClient<Database>,
  userId: string,
  sbSlug: string
): Promise<MemoryOwnerFilter> {
  const resolved = await resolveSbIdResult(supabase, userId, sbSlug);
  if (!resolved.ok) {
    throw new Error(
      `Benchmark identity "${sbSlug}" does not resolve to one identity for this user (${resolved.reason}). ` +
        'A benchmark needs a real identity to own the memories it seeds.'
    );
  }
  return { sbSlug, sbId: resolved.sbId };
}
