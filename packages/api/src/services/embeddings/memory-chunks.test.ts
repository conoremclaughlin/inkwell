import { describe, expect, it } from 'vitest';
import {
  buildMemoryEmbeddingChunks,
  countChunkViews,
  inferChunkTypeFromMetadata,
  MEMORY_EMBEDDING_CHUNKS_VERSION,
} from './memory-chunks';
import { memoryExtractionsSchema } from '../memory-llm-extraction';

describe('memory chunk multi-view helpers', () => {
  it('builds summary, fact, topic, entity, and content views when structured data is available', () => {
    const chunks = buildMemoryEmbeddingChunks({
      summary: 'Policy B replaces Policy A for wound escalation.',
      content:
        'Policy A required fax escalation. Policy B replaces Policy A and requires portal escalation within 24 hours. UCLA Care Team owns the policy review.',
      topicKey: 'policy:wound-escalation',
      topics: ['policy:wound-escalation', 'person:care-team'],
      source: 'observation',
      salience: 'high',
      model: { maxInputChars: 1200 } as { maxInputChars: number },
    });

    expect(chunks.some((chunk) => chunk.chunkType === 'summary')).toBe(true);
    expect(chunks.some((chunk) => chunk.chunkType === 'fact')).toBe(true);
    expect(chunks.some((chunk) => chunk.chunkType === 'topic')).toBe(true);
    expect(chunks.some((chunk) => chunk.chunkType === 'entity')).toBe(true);
    expect(chunks.some((chunk) => chunk.chunkType === 'content')).toBe(true);

    const viewCounts = countChunkViews(chunks);
    expect(viewCounts.summary).toBe(1);
    expect(viewCounts.current_state).toBe(0);
    expect(viewCounts.content).toBeGreaterThan(0);

    const metadata = {
      embedding_chunks: {
        version: MEMORY_EMBEDDING_CHUNKS_VERSION,
        viewCounts,
      },
    };

    expect(inferChunkTypeFromMetadata(0, metadata)).toBe('summary');
  });

  it('prefers llm-derived summary, durable fact, entity, and current state chunks when provided', () => {
    const llmExtractions = memoryExtractionsSchema.parse({
      version: 1,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      extractedAt: '2026-04-18T12:00:00.000Z',
      summary: {
        summary: 'The benchmark doc discussion established the current feature-flag plan.',
        keyPoints: ['feature flags gate extraction', 'current state is first-class'],
        actionRelevance: 'Helps future agents route retrieval experiments correctly.',
      },
      durable_fact: {
        durableFacts: [
          {
            fact: 'Current-state memory should be indexed separately from durable facts.',
            category: 'decision',
            subject: 'current_state index',
            object: 'durable_fact index',
            evidence:
              'Current state should stay separate from durable facts because it is volatile.',
          },
        ],
      },
      entity: {
        entities: [
          {
            name: 'Wren',
            aliases: ['wren'],
            entityType: 'person',
            description: 'Reviewer providing memory-system feedback.',
            evidence: 'Wren forgot that we were discussing a specific document.',
          },
        ],
      },
      current_state: {
        state: 'The dev server auto-restarts on file change.',
        scope: 'local dev server',
        status: 'running',
        volatility: 'volatile',
        evidence:
          'Current state is also important: like the currently running dev server will autorestart.',
      },
    });

    const chunks = buildMemoryEmbeddingChunks({
      summary: 'Fallback summary that should not be used',
      content:
        'Current state is also important: like the currently running dev server will autorestart.',
      topicKey: 'spec:memory-benchmark-notes',
      topics: ['person:wren'],
      source: 'observation',
      salience: 'high',
      model: { maxInputChars: 1200 } as { maxInputChars: number },
      llmExtractions,
      extractionMode: 'llm',
    });

    expect(chunks.find((chunk) => chunk.chunkType === 'summary')?.text).toContain(
      'action relevance'
    );
    expect(chunks.find((chunk) => chunk.chunkType === 'fact')?.text).toContain('durable fact:');
    expect(chunks.find((chunk) => chunk.chunkType === 'entity')?.text).toContain('entity: Wren');
    expect(chunks.find((chunk) => chunk.chunkType === 'current_state')?.text).toContain(
      'current state:'
    );

    const viewCounts = countChunkViews(chunks);
    expect(viewCounts.summary).toBe(1);
    expect(viewCounts.fact).toBe(1);
    expect(viewCounts.entity).toBe(1);
    expect(viewCounts.current_state).toBe(1);
  });

  it('uses heuristic extraction mode by default even when llm metadata exists', () => {
    const llmExtractions = memoryExtractionsSchema.parse({
      version: 1,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      extractedAt: '2026-04-18T12:00:00.000Z',
      current_state: {
        state: 'The dev server auto-restarts on file change.',
        scope: 'local dev server',
        status: 'running',
        volatility: 'volatile',
        evidence: 'The current dev server auto-restarts when files change.',
      },
    });

    const chunks = buildMemoryEmbeddingChunks({
      summary: 'Policy B replaces Policy A for wound escalation.',
      content: 'Policy B replaces Policy A and requires portal escalation within 24 hours.',
      model: { maxInputChars: 1200 } as { maxInputChars: number },
      llmExtractions,
    });

    expect(chunks.some((chunk) => chunk.chunkType === 'current_state')).toBe(false);
    expect(chunks.some((chunk) => chunk.chunkType === 'fact')).toBe(true);
  });

  it('sanitizes unpaired unicode surrogates before chunk persistence', () => {
    const chunks = buildMemoryEmbeddingChunks({
      content: 'A benchmark transcript contained a broken low surrogate \udc00 in the text.',
      model: { maxInputChars: 1200 } as { maxInputChars: number },
    });

    expect(chunks.some((chunk) => chunk.text.includes('\udc00'))).toBe(false);
    expect(chunks.some((chunk) => chunk.text.includes('�'))).toBe(true);
  });
});
