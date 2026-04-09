import { describe, expect, it } from 'vitest';
import {
  buildMemoryEmbeddingChunks,
  countChunkViews,
  inferChunkTypeFromMetadata,
  MEMORY_EMBEDDING_CHUNKS_VERSION,
} from './memory-chunks';

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
    expect(viewCounts.content).toBeGreaterThan(0);

    const metadata = {
      embedding_chunks: {
        version: MEMORY_EMBEDDING_CHUNKS_VERSION,
        viewCounts,
      },
    };

    expect(inferChunkTypeFromMetadata(0, metadata)).toBe('summary');
  });
});
