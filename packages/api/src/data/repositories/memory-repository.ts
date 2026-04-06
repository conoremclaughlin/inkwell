/**
 * Memory Repository - handles memories, sessions, and session logs
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';
import { resolveIdentityId } from '../../auth/resolve-identity';
import { logger } from '../../utils/logger';
import {
  buildChunkMetadataUpdate,
  buildChunkRows,
  buildMemoryEmbeddingChunks,
  formatVectorLiteral,
  MEMORY_EMBEDDING_CHUNKS_VERSION,
} from '../../services/embeddings/memory-chunks';
import { EmbeddingRouter } from '../../services/embeddings/router';
import { getVettedEmbeddingModel } from '../../services/embeddings/vetted-models';
import type {
  Memory,
  MemoryCreateInput,
  MemoryRow,
  MemorySearchOptions,
  MemoryHistory,
  MemoryHistoryRow,
  Session,
  SessionCreateInput,
  SessionRow,
  SessionLog,
  SessionLogCreateInput,
  SessionLogRow,
  Salience,
} from '../models/memory';

type RecallMode = NonNullable<MemorySearchOptions['recallMode']>;

export interface KnowledgeMemoryContext {
  threadKey?: string;
  focusText?: string;
}

interface RecallCandidate {
  memory: Memory;
  semanticScore?: number;
  textScore?: number;
  finalScore: number;
}

type MatchMemoryEmbeddingChunksArgs =
  Database['public']['Functions']['match_memory_embedding_chunks']['Args'];
type MatchMemoryEmbeddingChunksReturn =
  Database['public']['Functions']['match_memory_embedding_chunks']['Returns'][number];
type MatchMemoriesArgs = Database['public']['Functions']['match_memories']['Args'];
type MatchMemoriesReturn = Database['public']['Functions']['match_memories']['Returns'][number];
type MatchMemoryEmbeddingChunksRpcResult = {
  data: MatchMemoryEmbeddingChunksReturn[] | null;
  error: { message: string } | null;
};
type MatchMemoriesRpcResult = {
  data: MatchMemoriesReturn[] | null;
  error: { message: string } | null;
};
type MatchMemoriesRpcClient = {
  rpc(fn: 'match_memories', args: MatchMemoriesArgs): Promise<MatchMemoriesRpcResult>;
  rpc(
    fn: 'match_memory_embedding_chunks',
    args: MatchMemoryEmbeddingChunksArgs
  ): Promise<MatchMemoryEmbeddingChunksRpcResult>;
};

type SemanticMatchRow = Omit<MemoryRow, 'embedding'> & {
  embedding: number[] | string | null;
  similarity?: number;
};
type SemanticChunkMatchRow = Omit<MemoryRow, 'embedding'> & {
  embedding: number[] | string | null;
  similarity?: number;
  matched_chunk_index?: number | null;
  matched_chunk_text?: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function parseEmbeddingValue(value: MemoryRow['embedding'] | string | null): number[] | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return undefined;

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((entry) => Number(entry)) : undefined;
  } catch {
    return undefined;
  }
}

function tokenizeRelevance(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 1);
}

function extractThreadType(threadKey: string): string | null {
  const idx = threadKey.indexOf(':');
  if (idx <= 0) return null;
  return threadKey.slice(0, idx).toLowerCase();
}

function computeThreadBoost(memory: Memory, threadKey?: string): number {
  if (!threadKey?.trim()) return 1;

  const normalized = threadKey.trim().toLowerCase();
  const candidates = new Set<string>();
  if (memory.topicKey) candidates.add(memory.topicKey.toLowerCase());
  for (const t of memory.topics) candidates.add(t.toLowerCase());
  const metadataThreadKey =
    memory.metadata &&
    typeof memory.metadata === 'object' &&
    typeof (memory.metadata as Record<string, unknown>).threadKey === 'string'
      ? ((memory.metadata as Record<string, unknown>).threadKey as string).toLowerCase()
      : null;
  if (metadataThreadKey) candidates.add(metadataThreadKey);

  if (candidates.has(normalized)) return 1.8;

  const threadType = extractThreadType(normalized);
  if (threadType) {
    for (const candidate of candidates) {
      if (extractThreadType(candidate) === threadType) return 1.25;
    }
  }

  const threadTokens = tokenizeRelevance(normalized);
  if (threadTokens.length === 0) return 1;
  const candidateText = Array.from(candidates).join(' ');
  const tokenOverlap = threadTokens.filter((token) => candidateText.includes(token)).length;
  if (tokenOverlap > 0) return 1.1;

  return 1;
}

function computeFocusBoost(memory: Memory, focusText?: string): number {
  if (!focusText?.trim()) return 1;

  const focusTokens = tokenizeRelevance(focusText).filter((token) => token.length > 2);
  if (focusTokens.length === 0) return 1;

  const haystack = [
    memory.content,
    memory.summary || '',
    memory.topicKey || '',
    memory.topics.join(' '),
  ]
    .join(' ')
    .toLowerCase();

  const overlap = focusTokens.filter((token) => haystack.includes(token)).length;
  if (overlap === 0) return 1;

  const ratio = overlap / focusTokens.length;
  return 1 + Math.min(0.35, ratio * 0.35);
}

export function computeKnowledgeMemoryScore(
  memory: Memory,
  context: KnowledgeMemoryContext = {},
  now: Date = new Date()
): number {
  const salienceWeight =
    memory.salience === 'critical'
      ? 2
      : memory.salience === 'high'
        ? 1.2
        : memory.salience === 'medium'
          ? 0.9
          : 0.6;

  const ageDays = Math.max(0, (now.getTime() - memory.createdAt.getTime()) / DAY_MS);
  const recencyDecay = Math.max(0.25, Math.exp(-ageDays / 45));
  const threadBoost = computeThreadBoost(memory, context.threadKey);
  const focusBoost = computeFocusBoost(memory, context.focusText);

  return salienceWeight * recencyDecay * threadBoost * focusBoost;
}

export class MemoryRepository {
  private embeddingRouter: EmbeddingRouter;

  constructor(private supabase: SupabaseClient) {
    this.embeddingRouter = new EmbeddingRouter();
  }

  // ==================== MEMORIES ====================

  /**
   * Create a new memory
   */
  async remember(input: MemoryCreateInput): Promise<Memory> {
    const identityId =
      input.agentId && input.userId
        ? await resolveIdentityId(this.supabase, input.userId, input.agentId)
        : null;

    // If topicKey is provided, ensure it's included in topics array
    const topics = input.topics || [];
    if (input.topicKey && !topics.includes(input.topicKey)) {
      topics.unshift(input.topicKey);
    }

    const { data, error } = await this.supabase
      .from('memories')
      .insert({
        user_id: input.userId,
        content: input.content,
        summary: input.summary || null,
        topic_key: input.topicKey || null,
        source: input.source || 'observation',
        salience: input.salience || 'medium',
        topics,
        metadata: input.metadata || {},
        expires_at: input.expiresAt?.toISOString(),
        agent_id: input.agentId || null,
        contact_id: input.contactId || null,
        identity_id: identityId,
      })
      .select()
      .single();

    if (error) {
      logger.error('Failed to create memory:', error);
      throw new Error(`Failed to create memory: ${error.message}`);
    }

    const memory = this.rowToMemory(data);

    // Embedding persistence is intentionally eventually consistent: we insert the
    // memory row first so writes never fail on provider/network issues, then best-
    // effort persist the vector in a follow-up update.
    await this.tryEmbedMemory(memory, input);

    return memory;
  }

  /**
   * Search memories by text and/or semantic vectors.
   */
  async recall(
    userId: string,
    query?: string,
    options: MemorySearchOptions = {}
  ): Promise<Memory[]> {
    const limit = options.limit || 20;
    const offset = options.offset || 0;
    const recallMode: RecallMode = options.recallMode || 'hybrid';

    if (!query?.trim()) {
      return this.textRecall(userId, undefined, options, limit, offset);
    }

    const normalizedQuery = query.trim();

    if (recallMode === 'text') {
      return this.textRecall(userId, normalizedQuery, options, limit, offset);
    }

    if (recallMode === 'semantic') {
      const semanticCandidates = await this.trySemanticRecallCandidates(
        userId,
        normalizedQuery,
        options,
        limit,
        offset
      );
      return semanticCandidates?.map((c) => c.memory) || [];
    }

    if (recallMode === 'auto') {
      const semanticCandidates = await this.trySemanticRecallCandidates(
        userId,
        normalizedQuery,
        options,
        limit,
        offset
      );
      if (semanticCandidates && semanticCandidates.length > 0) {
        return semanticCandidates.map((c) => c.memory);
      }
      return this.textRecall(userId, normalizedQuery, options, limit, offset);
    }

    // hybrid mode: combine text + semantic signals with dedupe/reranking
    return this.hybridRecall(userId, normalizedQuery, options, limit, offset);
  }

  private async hybridRecall(
    userId: string,
    query: string,
    options: MemorySearchOptions,
    limit: number,
    offset: number
  ): Promise<Memory[]> {
    const config = this.embeddingRouter.getRuntimeConfig();
    const candidatePool = Math.max(
      limit,
      (offset + limit) * Math.max(1, config.matchCountMultiplier)
    );

    const [semanticCandidates, textCandidates] = await Promise.all([
      this.trySemanticRecallCandidates(userId, query, options, limit, offset),
      this.textRecallCandidates(userId, query, options, candidatePool, 0),
    ]);

    const byId = new Map<string, RecallCandidate>();

    for (const candidate of semanticCandidates || []) {
      const existing = byId.get(candidate.memory.id);
      byId.set(candidate.memory.id, {
        memory: candidate.memory,
        semanticScore: candidate.semanticScore,
        textScore: existing?.textScore,
        finalScore: 0,
      });
    }

    for (const candidate of textCandidates) {
      const existing = byId.get(candidate.memory.id);
      byId.set(candidate.memory.id, {
        memory: candidate.memory,
        semanticScore: existing?.semanticScore,
        textScore: candidate.textScore,
        finalScore: 0,
      });
    }

    const merged = Array.from(byId.values()).map((candidate) => ({
      ...candidate,
      finalScore: this.computeHybridScore(candidate.semanticScore, candidate.textScore),
    }));

    merged.sort(
      (a, b) =>
        b.finalScore - a.finalScore || b.memory.createdAt.getTime() - a.memory.createdAt.getTime()
    );

    return merged.slice(offset, offset + limit).map((c) => c.memory);
  }

  private computeHybridScore(semanticScore?: number, textScore?: number): number {
    const s = semanticScore ?? 0;
    const t = textScore ?? 0;
    // Blend with heavier semantic weighting, but allow lexical key matches to lift ranking.
    return s * 0.7 + t * 0.3;
  }

  private buildTextScore(query: string, memory: Memory): number {
    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0) return 0;

    const haystack = [
      memory.content,
      memory.summary || '',
      memory.topicKey || '',
      memory.topics.join(' '),
    ]
      .join(' ')
      .toLowerCase();

    const overlapCount = queryTokens.filter((token) => haystack.includes(token)).length;
    let score = overlapCount / queryTokens.length;

    if (haystack.includes(query.toLowerCase())) score += 0.2;
    if (
      memory.topicKey &&
      queryTokens.some((token) => memory.topicKey!.toLowerCase().includes(token))
    ) {
      score += 0.2;
    }

    return Math.min(1, score);
  }

  private tokenize(text: string): string[] {
    return tokenizeRelevance(text);
  }

  private buildTextSearchTerms(query: string): string[] {
    const full = query
      .trim()
      .replace(/[,%()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const tokens = this.tokenize(full)
      .filter((token) => token.length > 2)
      .sort((a, b) => b.length - a.length)
      .slice(0, 3);
    return Array.from(new Set([full, ...tokens].filter(Boolean)));
  }

  private async textRecall(
    userId: string,
    query: string | undefined,
    options: MemorySearchOptions,
    limit: number,
    offset: number
  ): Promise<Memory[]> {
    const candidates = await this.textRecallCandidates(userId, query, options, limit, offset);
    return candidates.map((c) => c.memory);
  }

  private async textRecallCandidates(
    userId: string,
    query: string | undefined,
    options: MemorySearchOptions,
    limit: number,
    offset: number
  ): Promise<RecallCandidate[]> {
    let queryBuilder = this.supabase
      .from('memories')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    // Filter by source
    if (options.source) {
      queryBuilder = queryBuilder.eq('source', options.source);
    }

    // Filter by salience
    if (options.salience) {
      queryBuilder = queryBuilder.eq('salience', options.salience);
    }

    // Filter by topics (any match)
    if (options.topics && options.topics.length > 0) {
      queryBuilder = queryBuilder.overlaps('topics', options.topics);
    }

    // Filter by agent
    if (options.agentId) {
      const includeShared = options.includeShared !== false; // default true
      if (includeShared) {
        // Include both agent-specific and shared (null) memories
        queryBuilder = queryBuilder.or(`agent_id.eq.${options.agentId},agent_id.is.null`);
      } else {
        // Only agent-specific memories
        queryBuilder = queryBuilder.eq('agent_id', options.agentId);
      }
    }

    // Filter by contact for per-sender isolation
    if (options.contactId) {
      // In per-contact mode: only show this contact's memories
      queryBuilder = queryBuilder.eq('contact_id', options.contactId);
    }

    // Exclude expired unless requested
    if (!options.includeExpired) {
      queryBuilder = queryBuilder.or('expires_at.is.null,expires_at.gt.now()');
    }

    // Text search on content/summary/topic_key
    if (query) {
      const terms = this.buildTextSearchTerms(query).slice(0, 10);
      if (terms.length > 0) {
        const clauses = terms.flatMap((term) => [
          `content.ilike.%${term}%`,
          `summary.ilike.%${term}%`,
          `topic_key.ilike.%${term}%`,
        ]);
        queryBuilder = queryBuilder.or(clauses.join(','));
      }
    }

    // Pagination
    queryBuilder = queryBuilder.range(offset, offset + limit - 1);

    const { data, error } = await queryBuilder;

    if (error) {
      logger.error('Failed to recall memories:', error);
      throw new Error(`Failed to recall memories: ${error.message}`);
    }

    return (data || []).map((row) => {
      const memory = this.rowToMemory(row);
      const textScore = query ? this.buildTextScore(query, memory) : 0;
      return {
        memory,
        textScore,
        finalScore: textScore,
      };
    });
  }

  private async trySemanticRecallCandidates(
    userId: string,
    query: string,
    options: MemorySearchOptions,
    limit: number,
    offset: number
  ): Promise<RecallCandidate[] | null> {
    const queryEmbedding = await this.embeddingRouter.embedQuery(query);
    if (!queryEmbedding) return null;

    const config = this.embeddingRouter.getRuntimeConfig();
    if (queryEmbedding.dimensions !== config.dimensions) {
      logger.warn('Skipping semantic recall due to embedding dimension mismatch', {
        provider: queryEmbedding.provider,
        model: queryEmbedding.model,
        embeddingDimensions: queryEmbedding.dimensions,
        expectedDimensions: config.dimensions,
      });
      return null;
    }

    const matchCount = Math.max(
      limit,
      (offset + limit) * Math.max(1, config.matchCountMultiplier || 1)
    );

    const rpcArgs: MatchMemoryEmbeddingChunksArgs = {
      query_embedding: formatVectorLiteral(queryEmbedding.vector),
      match_threshold: config.queryThreshold,
      match_count: matchCount,
      p_user_id: userId,
      p_source: options.source,
      p_salience: options.salience,
      p_topics: options.topics && options.topics.length > 0 ? options.topics : undefined,
      p_agent_id: options.agentId,
      p_include_shared: options.includeShared !== false,
      p_include_expired: options.includeExpired === true,
    };

    const rpcClient = this.supabase as unknown as MatchMemoriesRpcClient;
    const { data, error } = await rpcClient.rpc('match_memory_embedding_chunks', rpcArgs);

    if (error) {
      logger.warn(
        'Chunked semantic memory recall failed, falling back to legacy memory embeddings',
        {
          error: error.message,
        }
      );
      return this.tryLegacySemanticRecallCandidates(userId, options, limit, offset, queryEmbedding);
    }

    const rows = (data || []) as SemanticChunkMatchRow[];
    if (rows.length === 0) {
      return this.tryLegacySemanticRecallCandidates(userId, options, limit, offset, queryEmbedding);
    }

    const grouped = new Map<string, RecallCandidate>();

    for (const row of rows) {
      const memory = this.rowToMemory(row);

      // Post-filter for contact-scoped isolation (RPC doesn't support contact_id yet)
      if (options.contactId && memory.contactId !== options.contactId) {
        continue;
      }

      const semanticScore = Math.max(0, Math.min(1, row.similarity ?? 0));
      const existing = grouped.get(memory.id);

      if (!existing || semanticScore > (existing.semanticScore ?? 0)) {
        grouped.set(memory.id, {
          memory,
          semanticScore,
          finalScore: semanticScore,
        });
      }
    }

    return Array.from(grouped.values())
      .sort(
        (a, b) =>
          (b.semanticScore ?? 0) - (a.semanticScore ?? 0) ||
          b.memory.createdAt.getTime() - a.memory.createdAt.getTime()
      )
      .slice(offset, offset + limit);
  }

  private async tryLegacySemanticRecallCandidates(
    userId: string,
    options: MemorySearchOptions,
    limit: number,
    offset: number,
    queryEmbedding: {
      vector: number[];
      provider: string;
      model: string;
      dimensions: number;
    }
  ): Promise<RecallCandidate[] | null> {
    const config = this.embeddingRouter.getRuntimeConfig();
    const matchCount = Math.max(
      limit,
      (offset + limit) * Math.max(1, config.matchCountMultiplier || 1)
    );

    const rpcArgs: MatchMemoriesArgs = {
      query_embedding: formatVectorLiteral(queryEmbedding.vector),
      match_threshold: config.queryThreshold,
      match_count: matchCount,
      p_user_id: userId,
      p_source: options.source,
      p_salience: options.salience,
      p_topics: options.topics && options.topics.length > 0 ? options.topics : undefined,
      p_agent_id: options.agentId,
      p_include_shared: options.includeShared !== false,
      p_include_expired: options.includeExpired === true,
    };

    const rpcClient = this.supabase as unknown as MatchMemoriesRpcClient;
    const { data, error } = await rpcClient.rpc('match_memories', rpcArgs);

    if (error) {
      logger.warn('Legacy semantic memory recall failed, falling back to text recall', {
        error: error.message,
      });
      return null;
    }

    const rows = ((data || []) as SemanticMatchRow[]).slice(offset, offset + limit);
    return rows.map((row) => {
      const memory = this.rowToMemory(row);
      const semanticScore = Math.max(0, Math.min(1, row.similarity ?? 0));
      return {
        memory,
        semanticScore,
        finalScore: semanticScore,
      };
    });
  }

  private async tryEmbedMemory(memory: Memory, input: MemoryCreateInput): Promise<void> {
    if (!this.embeddingRouter.isEnabled()) return;

    const config = this.embeddingRouter.getRuntimeConfig();
    const vettedModel = getVettedEmbeddingModel(config.provider, config.model);
    const chunks = buildMemoryEmbeddingChunks({
      summary: input.summary,
      content: input.content,
      model: vettedModel,
    });
    if (chunks.length === 0) return;

    const embeddedChunks = [];
    for (const chunk of chunks) {
      const embedding = await this.embeddingRouter.embedDocument(chunk.text);
      if (!embedding) return;
      embeddedChunks.push({ chunk, embedding });
    }

    if (embeddedChunks.length === 0) return;

    const primaryChunk = embeddedChunks[0];
    const primaryEmbedding = primaryChunk.embedding;
    const chunkRows = buildChunkRows({
      memoryId: memory.id,
      userId: memory.userId,
      chunks: embeddedChunks.map(({ chunk, embedding }) => ({ ...chunk, embedding })),
    });

    const { error: chunkError } = await this.supabase
      .from('memory_embedding_chunks')
      .upsert(chunkRows, {
        onConflict: 'memory_id,chunk_index',
      });

    if (chunkError) {
      logger.warn('Failed to persist memory embedding chunks', {
        memoryId: memory.id,
        error: chunkError.message,
      });
      return;
    }

    const { error } = await this.supabase
      .from('memories')
      .update({
        embedding: formatVectorLiteral(primaryEmbedding.vector),
        embedding_chunks_version: MEMORY_EMBEDDING_CHUNKS_VERSION,
        embedding_chunk_count: embeddedChunks.length,
        metadata: {
          ...buildChunkMetadataUpdate({
            provider: primaryEmbedding.provider,
            model: primaryEmbedding.model,
            chunkCount: embeddedChunks.length,
            existingMetadata: memory.metadata || {},
          }),
          embedding: {
            provider: primaryEmbedding.provider,
            model: primaryEmbedding.model,
            dimensions: primaryEmbedding.dimensions,
            updatedAt: new Date().toISOString(),
          },
        } as Database['public']['Tables']['memories']['Update']['metadata'],
      })
      .eq('id', memory.id)
      .eq('user_id', memory.userId);

    if (error) {
      logger.warn('Failed to persist memory embedding', {
        memoryId: memory.id,
        error: error.message,
      });
      return;
    }

    memory.embedding = primaryEmbedding.vector;
    memory.metadata = {
      ...buildChunkMetadataUpdate({
        provider: primaryEmbedding.provider,
        model: primaryEmbedding.model,
        chunkCount: embeddedChunks.length,
        existingMetadata: memory.metadata || {},
      }),
      embedding: {
        provider: primaryEmbedding.provider,
        model: primaryEmbedding.model,
        dimensions: primaryEmbedding.dimensions,
      },
    };
  }

  /**
   * Fetch memories for the bootstrap knowledge summary.
   * Returns all critical memories + recent high memories, ordered by salience (critical first) then recency.
   *
   * High memories use a "last N days OR last M, whichever is more" strategy:
   * fetches both a time-windowed set and a count-limited set, then merges.
   *
   * @param highLimit Min high memories to include regardless of age (default 10)
   * @param highWindowDays Time window for recent high memories (default 7)
   */
  async getKnowledgeMemories(
    userId: string,
    agentId?: string,
    highLimit: number = 10,
    highWindowDays: number = 7,
    context: KnowledgeMemoryContext = {},
    contactId?: string
  ): Promise<Memory[]> {
    const buildQuery = (salience: string, limit: number) => {
      let q = this.supabase
        .from('memories')
        .select('*')
        .eq('user_id', userId)
        .eq('salience', salience)
        .or('expires_at.is.null,expires_at.gt.now()')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (agentId) {
        q = q.or(`agent_id.eq.${agentId},agent_id.is.null`);
      }
      if (contactId) {
        q = q.eq('contact_id', contactId);
      }
      return q;
    };

    const buildWindowedQuery = (salience: string, windowDays: number, limit: number) => {
      const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
      let q = this.supabase
        .from('memories')
        .select('*')
        .eq('user_id', userId)
        .eq('salience', salience)
        .or('expires_at.is.null,expires_at.gt.now()')
        .gte('created_at', cutoff)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (agentId) {
        q = q.or(`agent_id.eq.${agentId},agent_id.is.null`);
      }
      if (contactId) {
        q = q.eq('contact_id', contactId);
      }
      return q;
    };

    // Fetch critical + two high strategies in parallel
    const [criticalResult, highByCountResult, highByWindowResult] = await Promise.all([
      buildQuery('critical', 30),
      buildQuery('high', highLimit),
      buildWindowedQuery('high', highWindowDays, 50),
    ]);

    if (criticalResult.error) {
      logger.error('Failed to fetch critical memories:', criticalResult.error);
    }
    if (highByCountResult.error) {
      logger.error('Failed to fetch high memories (by count):', highByCountResult.error);
    }
    if (highByWindowResult.error) {
      logger.error('Failed to fetch high memories (by window):', highByWindowResult.error);
    }

    const criticalMemories = (criticalResult.data || []).map(this.rowToMemory);

    // Merge the two high strategies — dedupe by ID, keep recency order
    const highById = new Map<string, Memory>();
    for (const row of highByCountResult.data || []) {
      const mem = this.rowToMemory(row);
      highById.set(mem.id, mem);
    }
    for (const row of highByWindowResult.data || []) {
      const mem = this.rowToMemory(row);
      if (!highById.has(mem.id)) highById.set(mem.id, mem);
    }
    const highMemories = Array.from(highById.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );

    const scoredHighMemories = highMemories
      .map((memory) => ({
        memory,
        score: computeKnowledgeMemoryScore(memory, context),
      }))
      .sort(
        (a, b) => b.score - a.score || b.memory.createdAt.getTime() - a.memory.createdAt.getTime()
      )
      .map((entry) => entry.memory);

    // Critical first, then high.
    // Critical remains recency-ordered; high can be boosted by thread/focus relevance.
    return [...criticalMemories, ...scoredHighMemories];
  }

  /**
   * Fetch the most recent memories regardless of salience.
   * Used after compaction to restore context continuity — the agent
   * likely just saved these via `remember` before compaction hit.
   */
  async getRecentMemories(userId: string, agentId?: string, limit: number = 10): Promise<Memory[]> {
    let q = this.supabase
      .from('memories')
      .select('*')
      .eq('user_id', userId)
      .or('expires_at.is.null,expires_at.gt.now()')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (agentId) {
      q = q.or(`agent_id.eq.${agentId},agent_id.is.null`);
    }

    const { data, error } = await q;
    if (error) {
      logger.error('Failed to fetch recent memories:', error);
      return [];
    }
    return (data || []).map(this.rowToMemory);
  }

  // ==================== MEMORY SUMMARY CACHE ====================

  /**
   * Get cached memory summary if it's still fresh (no new memories since computation).
   */
  async getCachedSummary(
    userId: string,
    agentId?: string
  ): Promise<{ summaryText: string; computedAt: Date; memoryCount: number } | null> {
    const cacheKey = agentId || '__shared__';
    const { data, error } = await this.supabase
      .from('memory_summary_cache')
      .select('*')
      .eq('user_id', userId)
      .eq('agent_id', cacheKey)
      .single();

    if (error || !data) return null;

    // Check freshness: is there a memory newer than the cache?
    let freshnessQuery = this.supabase
      .from('memories')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gt('created_at', data.computed_at);

    if (agentId) {
      freshnessQuery = freshnessQuery.or(`agent_id.eq.${agentId},agent_id.is.null`);
    }

    const { count } = await freshnessQuery;
    if (count && count > 0) return null; // Cache is stale

    return {
      summaryText: data.summary_text,
      computedAt: new Date(data.computed_at),
      memoryCount: data.memory_count,
    };
  }

  /**
   * Save a computed memory summary to the cache.
   */
  async setCachedSummary(
    userId: string,
    agentId: string | undefined,
    summaryText: string,
    memoryCount: number
  ): Promise<void> {
    const cacheKey = agentId || '__shared__';
    const { error } = await this.supabase.from('memory_summary_cache').upsert(
      {
        user_id: userId,
        agent_id: cacheKey,
        summary_text: summaryText,
        computed_at: new Date().toISOString(),
        memory_count: memoryCount,
      },
      { onConflict: 'user_id,agent_id' }
    );

    if (error) {
      logger.warn('Failed to cache memory summary:', error);
    }
  }

  /**
   * Get a specific memory by ID
   */
  async getMemory(id: string): Promise<Memory | null> {
    const { data, error } = await this.supabase.from('memories').select('*').eq('id', id).single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      logger.error('Failed to get memory:', error);
      throw new Error(`Failed to get memory: ${error.message}`);
    }

    return data ? this.rowToMemory(data) : null;
  }

  /**
   * Delete a memory (forget)
   */
  async forget(id: string, userId: string): Promise<boolean> {
    const { error } = await this.supabase
      .from('memories')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      logger.error('Failed to forget memory:', error);
      throw new Error(`Failed to forget memory: ${error.message}`);
    }

    return true;
  }

  /**
   * Update memory salience or topics
   */
  async updateMemory(
    id: string,
    userId: string,
    updates: { salience?: Salience; topics?: string[]; metadata?: Record<string, unknown> }
  ): Promise<Memory | null> {
    const updateData: Record<string, unknown> = {};
    if (updates.salience) updateData.salience = updates.salience;
    if (updates.topics) updateData.topics = updates.topics;
    if (updates.metadata) updateData.metadata = updates.metadata;

    const { data, error } = await this.supabase
      .from('memories')
      .update(updateData)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      logger.error('Failed to update memory:', error);
      throw new Error(`Failed to update memory: ${error.message}`);
    }

    return data ? this.rowToMemory(data) : null;
  }

  // ==================== SESSIONS ====================

  /**
   * Start a new session
   */
  async startSession(input: SessionCreateInput): Promise<Session> {
    const identityId =
      input.agentId && input.userId
        ? await resolveIdentityId(this.supabase, input.userId, input.agentId)
        : null;

    const insertData: Record<string, unknown> = {
      ...(input.id ? { id: input.id } : {}),
      user_id: input.userId,
      agent_id: input.agentId,
      identity_id: identityId,
      metadata: input.metadata || {},
    };
    if (input.backend) insertData.backend = input.backend;
    if (input.model) insertData.model = input.model;
    const scopedStudioId = input.studioId;
    if (scopedStudioId !== undefined) {
      insertData.studio_id = scopedStudioId;
    }
    if (input.threadKey) {
      insertData.thread_key = input.threadKey;
    }
    if (input.contactId) {
      insertData.contact_id = input.contactId;
    }

    const { data, error } = await this.supabase
      .from('sessions')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      logger.error('Failed to start session:', error);
      throw new Error(`Failed to start session: ${error.message}`);
    }

    return this.rowToSession(data);
  }

  /**
   * End a session with optional summary
   */
  async endSession(sessionId: string, summary?: string): Promise<Session | null> {
    const { data, error } = await this.supabase
      .from('sessions')
      .update({
        ended_at: new Date().toISOString(),
        lifecycle: 'completed',
        summary,
      })
      .eq('id', sessionId)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      logger.error('Failed to end session:', error);
      throw new Error(`Failed to end session: ${error.message}`);
    }

    return data ? this.rowToSession(data) : null;
  }

  /**
   * Update a session's state (phase, status, backend session ID, etc.)
   */
  async updateSession(
    sessionId: string,
    updates: {
      currentPhase?: string | null;
      lifecycle?: string;
      status?: string;
      backendSessionId?: string;
      context?: string;
      workingDir?: string;
      cliAttached?: boolean;
    }
  ): Promise<Session | null> {
    const dbUpdates: Record<string, unknown> = {};
    // Note: updated_at is handled by the database trigger (update_sessions_updated_at)

    if (updates.currentPhase !== undefined) {
      dbUpdates.current_phase = updates.currentPhase;
    }
    if (updates.lifecycle !== undefined) {
      dbUpdates.lifecycle = updates.lifecycle;
    }
    if (updates.status !== undefined) {
      dbUpdates.status = updates.status;
    }
    if (updates.backendSessionId !== undefined) {
      dbUpdates.backend_session_id = updates.backendSessionId;
      // Also write to claude_session_id for backward compatibility with SessionService
      dbUpdates.claude_session_id = updates.backendSessionId;
    }
    if (updates.context !== undefined) {
      dbUpdates.context = updates.context;
    }
    if (updates.workingDir !== undefined) {
      dbUpdates.working_dir = updates.workingDir;
    }
    if (updates.cliAttached !== undefined) {
      dbUpdates.cli_attached = updates.cliAttached;
    }

    const { data, error } = await this.supabase
      .from('sessions')
      .update(dbUpdates)
      .eq('id', sessionId)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      logger.error('Failed to update session:', error);
      throw new Error(`Failed to update session: ${error.message}`);
    }

    return data ? this.rowToSession(data) : null;
  }

  /**
   * Get a session by ID
   */
  async getSession(id: string): Promise<Session | null> {
    const { data, error } = await this.supabase.from('sessions').select('*').eq('id', id).single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      logger.error('Failed to get session:', error);
      throw new Error(`Failed to get session: ${error.message}`);
    }

    return data ? this.rowToSession(data) : null;
  }

  /**
   * Get active session for a user (most recent without ended_at).
   *
   * studioId behavior:
   *   - undefined: don't filter by studio (find any active session)
   *   - null: match sessions with no studio
   *   - string: match that specific studio
   */
  async getActiveSession(
    userId: string,
    agentId?: string,
    studioId?: string | null,
    contactId?: string
  ): Promise<Session | null> {
    let query = this.supabase
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .is('ended_at', null)
      .neq('lifecycle', 'failed')
      .order('started_at', { ascending: false })
      .limit(1);

    if (agentId) {
      query = query.eq('agent_id', agentId);
    }

    if (studioId !== undefined) {
      if (studioId === null) {
        query = query.is('studio_id', null);
      } else {
        query = query.eq('studio_id', studioId);
      }
    }

    // Per-sender isolation: always scope by contact to prevent collision.
    // Contact sessions match their contact; owner sessions match NULL.
    if (contactId) {
      query = query.eq('contact_id', contactId);
    } else {
      query = query.is('contact_id', null);
    }

    const { data, error } = await query.single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      logger.error('Failed to get active session:', error);
      throw new Error(`Failed to get active session: ${error.message}`);
    }

    return data ? this.rowToSession(data) : null;
  }

  /**
   * Get active session by threadKey for a user+agent, optionally scoped by studio.
   * Returns the most recent active session with a matching thread_key, or null.
   */
  async getActiveSessionByThreadKey(
    userId: string,
    agentId: string,
    threadKey: string,
    studioId?: string | null,
    contactId?: string
  ): Promise<Session | null> {
    let query = this.supabase
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('agent_id', agentId)
      .eq('thread_key', threadKey)
      .is('ended_at', null)
      .neq('lifecycle', 'failed')
      .order('started_at', { ascending: false })
      .limit(1);

    if (studioId !== undefined) {
      if (studioId === null) {
        query = query.is('studio_id', null);
      } else {
        query = query.eq('studio_id', studioId);
      }
    }

    // Per-sender isolation: always scope by contact to prevent collision.
    // Contact sessions match their contact; owner sessions match NULL.
    if (contactId) {
      query = query.eq('contact_id', contactId);
    } else {
      query = query.is('contact_id', null);
    }

    const { data, error } = await query.single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      logger.error('Failed to get active session by threadKey:', error);
      throw new Error(`Failed to get active session by threadKey: ${error.message}`);
    }

    return data ? this.rowToSession(data) : null;
  }

  /**
   * Get recent active sessions for a user (without ended_at), ordered most recent first.
   * Used by bootstrap to return active sessions so the client can pick the right one.
   * Capped to avoid bloating bootstrap response with zombie sessions.
   */
  async getActiveSessions(userId: string, agentId?: string, limit = 10): Promise<Session[]> {
    let query = this.supabase
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .is('ended_at', null)
      .neq('lifecycle', 'failed')
      .order('started_at', { ascending: false })
      .limit(limit);

    if (agentId) {
      query = query.eq('agent_id', agentId);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('Failed to get active sessions:', error);
      throw new Error(`Failed to get active sessions: ${error.message}`);
    }

    return (data || []).map(this.rowToSession);
  }

  /**
   * List sessions for a user
   */
  async listSessions(
    userId: string,
    options: {
      limit?: number;
      offset?: number;
      agentId?: string;
      studioId?: string;
      filterNullStudio?: boolean;
    } = {}
  ): Promise<Session[]> {
    let query = this.supabase
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .order('started_at', { ascending: false });

    if (options.agentId) {
      query = query.eq('agent_id', options.agentId);
    }

    if (options.filterNullStudio) {
      query = query.is('studio_id', null);
    } else if (options.studioId) {
      query = query.eq('studio_id', options.studioId);
    }

    const limit = options.limit || 20;
    const offset = options.offset || 0;
    query = query.range(offset, offset + limit - 1);

    const { data, error } = await query;

    if (error) {
      logger.error('Failed to list sessions:', error);
      throw new Error(`Failed to list sessions: ${error.message}`);
    }

    return (data || []).map(this.rowToSession);
  }

  // ==================== SESSION LOGS ====================

  /**
   * Add a log entry to a session
   */
  async addSessionLog(input: SessionLogCreateInput): Promise<SessionLog> {
    const { data, error } = await this.supabase
      .from('session_logs')
      .insert({
        session_id: input.sessionId,
        content: input.content,
        salience: input.salience || 'medium',
      })
      .select()
      .single();

    if (error) {
      logger.error('Failed to add session log:', error);
      throw new Error(`Failed to add session log: ${error.message}`);
    }

    return this.rowToSessionLog(data);
  }

  /**
   * Get all logs for a session (excludes compacted logs by default)
   */
  async getSessionLogs(sessionId: string, includeCompacted = false): Promise<SessionLog[]> {
    let query = this.supabase
      .from('session_logs')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (!includeCompacted) {
      query = query.is('compacted_at', null);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('Failed to get session logs:', error);
      throw new Error(`Failed to get session logs: ${error.message}`);
    }

    return (data || []).map(this.rowToSessionLog);
  }

  /**
   * Soft-delete session logs by marking them as compacted
   */
  async markLogsCompacted(sessionId: string, memoryId?: string): Promise<number> {
    const { data, error } = await this.supabase
      .from('session_logs')
      .update({
        compacted_at: new Date().toISOString(),
        compacted_into_memory_id: memoryId,
      })
      .eq('session_id', sessionId)
      .is('compacted_at', null)
      .select('id');

    if (error) {
      logger.error('Failed to mark logs as compacted:', error);
      throw new Error(`Failed to mark logs as compacted: ${error.message}`);
    }

    return data?.length || 0;
  }

  /**
   * Mark specific logs as compacted (for granular compaction)
   * Pass memoryId to link to the memory created from the log(s), or undefined if discarded
   */
  async markSpecificLogsCompacted(logIds: string[], memoryId?: string): Promise<number> {
    const { data, error } = await this.supabase
      .from('session_logs')
      .update({
        compacted_at: new Date().toISOString(),
        compacted_into_memory_id: memoryId || null,
      })
      .in('id', logIds)
      .select('id');

    if (error) {
      logger.error('Failed to mark specific logs as compacted:', error);
      throw new Error(`Failed to mark specific logs as compacted: ${error.message}`);
    }

    return data?.length || 0;
  }

  /**
   * Get session logs filtered by salience (excludes compacted logs by default)
   */
  async getSessionLogsBySalience(
    sessionId: string,
    minSalience: 'low' | 'medium' | 'high' | 'critical',
    includeCompacted = false
  ): Promise<SessionLog[]> {
    const salienceOrder = ['low', 'medium', 'high', 'critical'];
    const minIndex = salienceOrder.indexOf(minSalience);
    const validSaliences = salienceOrder.slice(minIndex);

    let query = this.supabase
      .from('session_logs')
      .select('*')
      .eq('session_id', sessionId)
      .in('salience', validSaliences)
      .order('created_at', { ascending: true });

    if (!includeCompacted) {
      query = query.is('compacted_at', null);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('Failed to get session logs by salience:', error);
      throw new Error(`Failed to get session logs by salience: ${error.message}`);
    }

    return (data || []).map(this.rowToSessionLog);
  }

  // ==================== MEMORY HISTORY ====================

  /**
   * Get version history for a specific memory
   */
  async getMemoryHistory(memoryId: string, userId: string): Promise<MemoryHistory[]> {
    const { data, error } = await this.supabase
      .from('memory_history')
      .select('*')
      .eq('memory_id', memoryId)
      .eq('user_id', userId)
      .order('version', { ascending: false });

    if (error) {
      logger.error('Failed to get memory history:', error);
      throw new Error(`Failed to get memory history: ${error.message}`);
    }

    return (data || []).map(this.rowToMemoryHistory.bind(this));
  }

  /**
   * Get all history for a user (recent changes)
   */
  async getUserMemoryHistory(
    userId: string,
    options: { limit?: number; changeType?: 'update' | 'delete' } = {}
  ): Promise<MemoryHistory[]> {
    let query = this.supabase
      .from('memory_history')
      .select('*')
      .eq('user_id', userId)
      .order('archived_at', { ascending: false });

    if (options.changeType) {
      query = query.eq('change_type', options.changeType);
    }

    const limit = options.limit || 50;
    query = query.limit(limit);

    const { data, error } = await query;

    if (error) {
      logger.error('Failed to get user memory history:', error);
      throw new Error(`Failed to get user memory history: ${error.message}`);
    }

    return (data || []).map(this.rowToMemoryHistory.bind(this));
  }

  /**
   * Restore a memory from history (creates new version with old content)
   */
  async restoreMemory(historyId: string, userId: string): Promise<Memory | null> {
    // Get the history entry
    const { data: historyData, error: historyError } = await this.supabase
      .from('memory_history')
      .select('*')
      .eq('id', historyId)
      .eq('user_id', userId)
      .single();

    if (historyError) {
      if (historyError.code === 'PGRST116') return null;
      logger.error('Failed to get history entry:', historyError);
      throw new Error(`Failed to get history entry: ${historyError.message}`);
    }

    const history = this.rowToMemoryHistory(historyData);

    // Check if the original memory still exists
    const existing = await this.getMemory(history.memoryId);

    if (existing) {
      // Update the existing memory with the historical content
      const { data, error } = await this.supabase
        .from('memories')
        .update({
          content: history.content,
          summary: history.summary || null,
          topic_key: history.topicKey || null,
          salience: history.salience,
          topics: history.topics,
          metadata: { ...history.metadata, restored_from_version: history.version },
        })
        .eq('id', history.memoryId)
        .eq('user_id', userId)
        .select()
        .single();

      if (error) {
        logger.error('Failed to restore memory:', error);
        throw new Error(`Failed to restore memory: ${error.message}`);
      }

      return this.rowToMemory(data);
    } else {
      // Memory was deleted, recreate it
      const { data, error } = await this.supabase
        .from('memories')
        .insert({
          user_id: userId,
          content: history.content,
          summary: history.summary || null,
          topic_key: history.topicKey || null,
          source: history.source,
          salience: history.salience,
          topics: history.topics,
          metadata: {
            ...history.metadata,
            restored_from_deleted: true,
            original_id: history.memoryId,
          },
        })
        .select()
        .single();

      if (error) {
        logger.error('Failed to recreate memory:', error);
        throw new Error(`Failed to recreate memory: ${error.message}`);
      }

      return this.rowToMemory(data);
    }
  }

  // ==================== HELPERS ====================

  private rowToMemory(row: MemoryRow | SemanticChunkMatchRow): Memory {
    return {
      id: row.id,
      userId: row.user_id,
      content: row.content,
      summary: row.summary || undefined,
      topicKey: row.topic_key || undefined,
      source: row.source,
      salience: row.salience,
      topics: row.topics,
      agentId: row.agent_id || undefined,
      contactId: (row as MemoryRow).contact_id || undefined,
      embedding: parseEmbeddingValue(row.embedding),
      metadata: row.metadata,
      version: row.version || 1,
      createdAt: new Date(row.created_at),
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
    };
  }

  private rowToMemoryHistory(row: MemoryHistoryRow): MemoryHistory {
    return {
      id: row.id,
      memoryId: row.memory_id,
      userId: row.user_id,
      content: row.content,
      summary: row.summary || undefined,
      topicKey: row.topic_key || undefined,
      source: row.source,
      salience: row.salience,
      topics: row.topics,
      metadata: row.metadata,
      version: row.version,
      createdAt: new Date(row.created_at),
      archivedAt: new Date(row.archived_at),
      changeType: row.change_type,
    };
  }

  private rowToSession(row: SessionRow): Session {
    const studioId = row.studio_id || undefined;
    return {
      id: row.id,
      userId: row.user_id,
      agentId: row.agent_id || undefined,
      studioId,
      threadKey: row.thread_key || undefined,
      lifecycle: (row.lifecycle as Session['lifecycle']) || undefined,
      status: row.status || undefined,
      currentPhase: row.current_phase || undefined,
      backend: row.backend || undefined,
      model: row.model || undefined,
      backendSessionId: row.backend_session_id || undefined,
      claudeSessionId: row.claude_session_id || undefined,
      workingDir: row.working_dir || undefined,
      context: row.context || undefined,
      startedAt: new Date(row.started_at),
      endedAt: row.ended_at ? new Date(row.ended_at) : undefined,
      summary: row.summary || undefined,
      updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
      metadata: row.metadata,
    };
  }

  private rowToSessionLog(row: SessionLogRow): SessionLog {
    return {
      id: row.id,
      sessionId: row.session_id,
      content: row.content,
      salience: row.salience,
      createdAt: new Date(row.created_at),
    };
  }
}
