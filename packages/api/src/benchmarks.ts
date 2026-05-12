export { createSupabaseClient } from './data/supabase/client';
export { MemoryRepository } from './data/repositories/memory-repository';
export { MEMORY_EMBEDDING_CHUNKS_VERSION } from './services/embeddings/memory-chunks';
export {
  DEFAULT_MEMORY_LLM_MODEL,
  MEMORY_EXTRACTION_VERSION,
} from './services/memory-llm-extraction';
export type {
  MemoryHybridChunkStrategy,
  MemorySemanticQueryStrategy,
  MemorySearchChunkType,
  MemorySearchOptions,
} from './data/models/memory';
