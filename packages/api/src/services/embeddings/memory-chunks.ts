import type { Json, TablesInsert } from '../../data/supabase/types';
import type { EmbeddingResult } from './router';
import { type VettedEmbeddingModel } from './vetted-models';

export const MEMORY_EMBEDDING_CHUNKS_VERSION = 2;
const DEFAULT_MAX_CHARS = 1000;
const DEFAULT_OVERLAP_CHARS = 150;
const MAX_FACT_CHUNKS = 3;
const MAX_ENTITY_CHUNKS = 2;
const MIN_FACT_SENTENCE_CHARS = 48;
const MAX_FACT_SENTENCE_CHARS = 280;

export type MemoryChunkType = 'summary' | 'fact' | 'topic' | 'entity' | 'content';
const CHUNK_TYPE_ORDER: MemoryChunkType[] = ['summary', 'fact', 'topic', 'entity', 'content'];

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
  topic: number;
  entity: number;
  content: number;
}

function emptyViewCounts(): MemoryChunkViewCounts {
  return {
    summary: 0,
    fact: 0,
    topic: 0,
    entity: 0,
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
  const normalized = text.trim();
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
  return text.replace(/\s+/g, ' ').trim();
}

function splitIntoSentences(text: string): string[] {
  const normalized = text
    .replace(/\r/g, '\n')
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map(normalizeWhitespace)
    .filter(Boolean);

  return normalized;
}

function sentenceScore(sentence: string): number {
  const lowered = sentence.toLowerCase();
  const cueWords = [
    ' must ',
    ' should ',
    ' decided ',
    ' because ',
    ' prefer ',
    ' important ',
    ' override',
    ' replace',
    ' policy',
    ' convention',
    ' requires ',
    ' means ',
  ];

  let score = 0;
  if (/\d/.test(sentence)) score += 0.3;
  if (cueWords.some((cue) => lowered.includes(cue.trim()) || lowered.includes(cue))) score += 0.4;
  if (/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/.test(sentence) || /\b[A-Z]{2,}\b/.test(sentence)) {
    score += 0.2;
  }

  const tokens = lowered.split(/[^a-z0-9]+/).filter((token) => token.length > 2);
  const uniqueTokens = new Set(tokens);
  if (tokens.length > 0) score += Math.min(0.3, uniqueTokens.size / Math.max(tokens.length, 1) / 2);

  return score;
}

function buildFactChunks(text: string): MemoryEmbeddingChunk[] {
  const sentences = splitIntoSentences(text)
    .filter(
      (sentence) =>
        sentence.length >= MIN_FACT_SENTENCE_CHARS && sentence.length <= MAX_FACT_SENTENCE_CHARS
    )
    .map((sentence) => ({ sentence, score: sentenceScore(sentence) }))
    .filter((entry) => entry.score > 0.2)
    .sort((a, b) => b.score - a.score || b.sentence.length - a.sentence.length);

  const seen = new Set<string>();
  const chunks: MemoryEmbeddingChunk[] = [];

  for (const entry of sentences) {
    const normalized = entry.sentence.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    chunks.push({
      chunkIndex: chunks.length,
      chunkType: 'fact',
      text: entry.sentence,
      startOffset: 0,
      endOffset: entry.sentence.length,
    });
    if (chunks.length >= MAX_FACT_CHUNKS) break;
  }

  return chunks;
}

function buildTopicChunks(params: {
  topicKey?: string | null;
  topics?: string[] | null;
  source?: string | null;
  salience?: string | null;
}): MemoryEmbeddingChunk[] {
  const lines: string[] = [];
  if (params.topicKey?.trim()) lines.push(`topic key: ${params.topicKey.trim()}`);
  const normalizedTopics = (params.topics || []).map((topic) => topic.trim()).filter(Boolean);
  if (normalizedTopics.length > 0) lines.push(`topics: ${normalizedTopics.join(', ')}`);
  if (params.source?.trim()) lines.push(`source: ${params.source.trim()}`);
  if (params.salience?.trim()) lines.push(`salience: ${params.salience.trim()}`);
  const text = lines.join('\n').trim();
  if (!text) return [];
  return [
    {
      chunkIndex: 0,
      chunkType: 'topic',
      text,
      startOffset: 0,
      endOffset: text.length,
    },
  ];
}

function extractEntityPhrases(text: string): string[] {
  const matches = [
    ...text.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\b/g),
    ...text.matchAll(/\b[A-Z]{2,}(?:\s+[A-Z]{2,})*\b/g),
  ].map((match) => normalizeWhitespace(match[0] || ''));

  const unique = new Set<string>();
  for (const phrase of matches) {
    if (phrase.length < 3) continue;
    unique.add(phrase);
    if (unique.size >= 8) break;
  }

  return Array.from(unique);
}

function buildEntityChunks(params: {
  summary?: string | null;
  content: string;
  topicKey?: string | null;
  topics?: string[] | null;
}): MemoryEmbeddingChunk[] {
  const phrases = new Set<string>();

  for (const topic of params.topics || []) {
    const normalized = topic
      .split(':')
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' ');
    if (normalized) phrases.add(normalized);
  }

  if (params.topicKey?.trim()) {
    const normalized = params.topicKey
      .split(':')
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' ');
    if (normalized) phrases.add(normalized);
  }

  for (const phrase of extractEntityPhrases(`${params.summary || ''}\n${params.content}`)) {
    phrases.add(phrase);
    if (phrases.size >= 10) break;
  }

  const entries = Array.from(phrases)
    .map(normalizeWhitespace)
    .filter(Boolean)
    .slice(0, MAX_ENTITY_CHUNKS);

  return entries.map((entry, index) => ({
    chunkIndex: index,
    chunkType: 'entity',
    text: `entity focus: ${entry}`,
    startOffset: 0,
    endOffset: entry.length,
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
  if (typeof chunkIndex !== 'number' || chunkIndex < 0 || !metadata || typeof metadata !== 'object') {
    return null;
  }

  const embeddingChunks =
    'embedding_chunks' in metadata && metadata.embedding_chunks && typeof metadata.embedding_chunks === 'object'
      ? (metadata.embedding_chunks as Record<string, unknown>)
      : null;
  const viewCounts =
    embeddingChunks &&
    'viewCounts' in embeddingChunks &&
    embeddingChunks.viewCounts &&
    typeof embeddingChunks.viewCounts === 'object'
      ? (embeddingChunks.viewCounts as Record<string, unknown>)
      : null;

  if (!viewCounts) return null;

  let offset = 0;
  for (const chunkType of CHUNK_TYPE_ORDER) {
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
}): MemoryEmbeddingChunk[] {
  const { summary, content, topicKey, topics, source, salience, model = null } = params;
  const maxChars = pickMaxChunkChars(model);
  const chunks: MemoryEmbeddingChunk[] = [];

  const normalizedSummary = summary?.trim();
  if (normalizedSummary) {
    chunks.push({
      chunkIndex: chunks.length,
      chunkType: 'summary',
      text: normalizedSummary,
      startOffset: 0,
      endOffset: normalizedSummary.length,
    });
  }

  chunks.push(...reindexChunks(buildFactChunks(`${normalizedSummary || ''}\n${content}`), chunks.length));
  chunks.push(...reindexChunks(buildTopicChunks({ topicKey, topics, source, salience }), chunks.length));
  chunks.push(...reindexChunks(buildEntityChunks({ summary, content, topicKey, topics }), chunks.length));
  chunks.push(...reindexChunks(buildContentChunks(content, maxChars, DEFAULT_OVERLAP_CHARS), chunks.length));

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
    chunk_text: chunk.text,
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
  existingMetadata?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const { provider, model, chunkCount, viewCounts, existingMetadata } = params;
  return {
    ...(existingMetadata || {}),
    embedding_chunks: {
      provider,
      model,
      version: MEMORY_EMBEDDING_CHUNKS_VERSION,
      chunkCount,
      viewCounts,
      updatedAt: new Date().toISOString(),
    },
  };
}
