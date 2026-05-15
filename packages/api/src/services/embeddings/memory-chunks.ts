import type { Json, TablesInsert } from '../../data/supabase/types';
import { MEMORY_EMBEDDING_CHUNKS_VERSION } from '../memory-benchmark-constants';
import {
  buildCurrentStateEmbeddingTexts,
  buildDurableFactEmbeddingTexts,
  buildEntityEmbeddingTexts,
  buildExactDetailsEmbeddingTexts,
  buildSummaryEmbeddingTexts,
  normalizeMemoryExtractions,
  type MemoryExtractions,
} from '../memory-llm-extraction';
import type { EmbeddingResult } from './router';
import { type VettedEmbeddingModel } from './vetted-models';

export { MEMORY_EMBEDDING_CHUNKS_VERSION };
const DEFAULT_MAX_CHARS = 1000;
const DEFAULT_OVERLAP_CHARS = 150;

export type MemoryChunkType =
  | 'summary'
  | 'fact'
  | 'exact_detail'
  | 'topic'
  | 'entity'
  | 'current_state'
  | 'content';
export type MemoryExtractionChunkMode = 'heuristic' | 'llm' | 'merged';
const CHUNK_TYPE_ORDER: MemoryChunkType[] = [
  'content',
  'summary',
  'fact',
  'exact_detail',
  'topic',
  'entity',
  'current_state',
];
const LEGACY_CHUNK_TYPE_ORDER: MemoryChunkType[] = [
  'summary',
  'fact',
  'exact_detail',
  'topic',
  'entity',
  'current_state',
  'content',
];

export interface MemoryEmbeddingChunk {
  chunkIndex: number;
  chunkType: MemoryChunkType;
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface EmbeddedMemoryChunk extends MemoryEmbeddingChunk {
  embedding: EmbeddingResult;
}

export interface MemoryChunkViewCounts {
  summary: number;
  fact: number;
  exact_detail: number;
  topic: number;
  entity: number;
  current_state: number;
  content: number;
}

function emptyViewCounts(): MemoryChunkViewCounts {
  return {
    summary: 0,
    fact: 0,
    exact_detail: 0,
    topic: 0,
    entity: 0,
    current_state: 0,
    content: 0,
  };
}

function pickMaxChunkChars(model: VettedEmbeddingModel | null): number {
  if (!model?.maxInputChars) return DEFAULT_MAX_CHARS;
  return Math.max(200, model.maxInputChars - 100);
}

function findChunkBoundary(text: string, start: number, targetEnd: number): number {
  if (targetEnd >= text.length) return text.length;

  const minBoundary = Math.min(text.length, start + Math.floor((targetEnd - start) * 0.6));
  const window = text.slice(minBoundary, targetEnd);
  const breakCandidates = ['\n\n', '\n', '. ', ' '];

  for (const delimiter of breakCandidates) {
    const idx = window.lastIndexOf(delimiter);
    if (idx !== -1) return minBoundary + idx + delimiter.length;
  }

  return targetEnd;
}

function buildContentChunks(
  text: string,
  maxChars: number,
  overlapChars: number
): MemoryEmbeddingChunk[] {
  const normalized = sanitizeChunkText(text.trim());
  if (!normalized) return [];

  const chunks: MemoryEmbeddingChunk[] = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < normalized.length) {
    const targetEnd = Math.min(normalized.length, start + maxChars);
    const end = findChunkBoundary(normalized, start, targetEnd);
    const chunkText = normalized.slice(start, end).trim();

    if (chunkText) {
      chunks.push({
        chunkIndex,
        chunkType: 'content',
        text: chunkText,
        startOffset: start,
        endOffset: end,
      });
      chunkIndex += 1;
    }

    if (end >= normalized.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }

  return chunks;
}

function normalizeWhitespace(text: string): string {
  return replaceUnpairedSurrogates(text.replace(/\s+/g, ' ').trim());
}

function replaceUnpairedSurrogates(text: string): string {
  let sanitized = '';

  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
    const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;

    if (isHighSurrogate) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        sanitized += text[i] + text[i + 1];
        i += 1;
      } else {
        sanitized += '�';
      }
      continue;
    }

    sanitized += isLowSurrogate ? '�' : text[i];
  }

  return sanitized;
}

function sanitizeChunkText(text: string): string {
  return replaceUnpairedSurrogates(text);
}

function buildChunksFromTexts(chunkType: MemoryChunkType, texts: string[]): MemoryEmbeddingChunk[] {
  return texts
    .map((text) => sanitizeChunkText(normalizeWhitespace(text)))
    .filter(Boolean)
    .map((text, index) => ({
      chunkIndex: index,
      chunkType,
      text,
      startOffset: 0,
      endOffset: text.length,
    }));
}

function reindexChunks(chunks: MemoryEmbeddingChunk[], startIndex: number): MemoryEmbeddingChunk[] {
  return chunks.map((chunk, index) => ({
    ...chunk,
    chunkIndex: startIndex + index,
  }));
}

export function countChunkViews(chunks: MemoryEmbeddingChunk[]): MemoryChunkViewCounts {
  const counts = emptyViewCounts();
  for (const chunk of chunks) counts[chunk.chunkType] += 1;
  return counts;
}

export function inferChunkTypeFromMetadata(
  chunkIndex: number | null | undefined,
  metadata: Record<string, unknown> | null | undefined
): MemoryChunkType | null {
  if (
    typeof chunkIndex !== 'number' ||
    chunkIndex < 0 ||
    !metadata ||
    typeof metadata !== 'object'
  ) {
    return null;
  }

  const embeddingChunks =
    'embedding_chunks' in metadata &&
    metadata.embedding_chunks &&
    typeof metadata.embedding_chunks === 'object'
      ? (metadata.embedding_chunks as Record<string, unknown>)
      : null;
  const viewCounts =
    embeddingChunks &&
    'viewCounts' in embeddingChunks &&
    embeddingChunks.viewCounts &&
    typeof embeddingChunks.viewCounts === 'object'
      ? (embeddingChunks.viewCounts as Record<string, unknown>)
      : null;

  if (!embeddingChunks || !viewCounts) return null;

  const version = typeof embeddingChunks.version === 'number' ? embeddingChunks.version : null;
  const chunkTypeOrder =
    version !== null && version >= MEMORY_EMBEDDING_CHUNKS_VERSION
      ? CHUNK_TYPE_ORDER
      : LEGACY_CHUNK_TYPE_ORDER;

  let offset = 0;
  for (const chunkType of chunkTypeOrder) {
    const rawCount = viewCounts[chunkType];
    const count = typeof rawCount === 'number' ? rawCount : 0;
    if (chunkIndex < offset + count) return chunkType;
    offset += count;
  }

  return null;
}

export function buildMemoryEmbeddingChunks(params: {
  summary?: string | null;
  content: string;
  topicKey?: string | null;
  topics?: string[] | null;
  source?: string | null;
  salience?: string | null;
  model?: VettedEmbeddingModel | null;
  llmExtractions?: MemoryExtractions | Record<string, unknown> | null;
  extractionMode?: MemoryExtractionChunkMode;
}): MemoryEmbeddingChunk[] {
  const { content, model = null } = params;
  const maxChars = pickMaxChunkChars(model);
  const chunks: MemoryEmbeddingChunk[] = [];
  const llmExtractions = normalizeMemoryExtractions(params.llmExtractions);
  const extractionMode = params.extractionMode || 'heuristic';
  const includeLlm = extractionMode === 'llm' || extractionMode === 'merged';

  // The raw episodic memory is the authoritative representation. For normal-size memories this
  // produces exactly one embedding; content is split only when it exceeds the vetted model limit.
  chunks.push(
    ...reindexChunks(buildContentChunks(content, maxChars, DEFAULT_OVERLAP_CHARS), chunks.length)
  );

  const extractedSummaryTexts = llmExtractions?.summary
    ? buildSummaryEmbeddingTexts(llmExtractions.summary)
    : [];
  const summaryTexts = includeLlm ? extractedSummaryTexts : [];
  chunks.push(...reindexChunks(buildChunksFromTexts('summary', summaryTexts), chunks.length));

  const durableFactTexts = llmExtractions?.durable_fact
    ? buildDurableFactEmbeddingTexts(llmExtractions.durable_fact)
    : [];
  const factChunks = includeLlm ? buildChunksFromTexts('fact', durableFactTexts) : [];
  chunks.push(...reindexChunks(factChunks, chunks.length));

  const exactDetailTexts = llmExtractions?.exact_details
    ? buildExactDetailsEmbeddingTexts(llmExtractions.exact_details)
    : [];
  if (includeLlm) {
    chunks.push(
      ...reindexChunks(buildChunksFromTexts('exact_detail', exactDetailTexts), chunks.length)
    );
  }

  const entityTexts = llmExtractions?.entity
    ? buildEntityEmbeddingTexts(llmExtractions.entity)
    : [];
  const entityChunks = includeLlm ? buildChunksFromTexts('entity', entityTexts) : [];
  chunks.push(...reindexChunks(entityChunks, chunks.length));

  const currentStateTexts = llmExtractions?.current_state
    ? buildCurrentStateEmbeddingTexts(llmExtractions.current_state)
    : [];
  if (includeLlm) {
    chunks.push(
      ...reindexChunks(buildChunksFromTexts('current_state', currentStateTexts), chunks.length)
    );
  }

  return chunks;
}

export function formatVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

export function buildChunkRows(params: {
  memoryId: string;
  userId: string;
  chunks: EmbeddedMemoryChunk[];
}): TablesInsert<'memory_embedding_chunks'>[] {
  const { memoryId, userId, chunks } = params;

  return chunks.map((chunk) => ({
    memory_id: memoryId,
    user_id: userId,
    chunk_index: chunk.chunkIndex,
    chunk_type: chunk.chunkType,
    chunk_text: sanitizeChunkText(chunk.text),
    embedding: formatVectorLiteral(chunk.embedding.vector),
    metadata: {
      embedding: {
        provider: chunk.embedding.provider,
        model: chunk.embedding.model,
        dimensions: chunk.embedding.dimensions,
      },
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      version: MEMORY_EMBEDDING_CHUNKS_VERSION,
    } satisfies Json,
  }));
}

export function buildChunkMetadataUpdate(params: {
  provider: string;
  model: string;
  chunkCount: number;
  viewCounts: MemoryChunkViewCounts;
  extractionMode?: MemoryExtractionChunkMode;
  existingMetadata?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const { provider, model, chunkCount, viewCounts, extractionMode, existingMetadata } = params;
  return {
    ...(existingMetadata || {}),
    embedding_chunks: {
      provider,
      model,
      version: MEMORY_EMBEDDING_CHUNKS_VERSION,
      ...(extractionMode ? { extractionMode } : {}),
      chunkCount,
      viewCounts,
      updatedAt: new Date().toISOString(),
    },
  };
}
