import { describe, expect, it, vi } from 'vitest';
import { buildRepresentationKey, parseBenchmarkPhase } from './benchmark-memory-recall.config';

describe('benchmark-memory-recall config helpers', () => {
  it('parses benchmark phase values', () => {
    expect(parseBenchmarkPhase('seed')).toBe('seed');
    expect(parseBenchmarkPhase('recall')).toBe('recall');
    expect(parseBenchmarkPhase('all')).toBe('all');
  });

  it('warns and falls back to all on unknown benchmark phase', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseBenchmarkPhase('oops')).toBe('all');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Unknown MEMORY_BENCHMARK_PHASE=oops')
    );
    warn.mockRestore();
  });

  it('includes chunk, extraction, and model dimensions in representation key', () => {
    const key = buildRepresentationKey({
      MEMORY_EMBEDDINGS_ENABLED: 'true',
      MEMORY_EMBEDDING_PROVIDER: 'openai',
      MEMORY_EMBEDDING_MODEL: 'text-embedding-3-large',
      MEMORY_EXTRACTION_MODE: 'llm',
      MEMORY_LLM_EXTRACTION_ENABLED: 'true',
      MEMORY_LLM_MODEL: 'gpt-5-mini',
      MEMORY_LLM_ENTITY_ENABLED: 'true',
      MEMORY_LLM_DURABLE_FACT_ENABLED: 'false',
      MEMORY_LLM_SUMMARY_ENABLED: 'true',
      MEMORY_LLM_CURRENT_STATE_ENABLED: 'false',
    } as NodeJS.ProcessEnv);

    expect(key).toContain('chunks-v');
    expect(key).toContain('extract-v');
    expect(key).toContain('gpt-5');
    expect(key).toContain('llm');
    expect(key).toContain('text-embedding-3-large');
  });
});
