import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';
import { EmbeddingRouter } from '../../services/embeddings/router';
import { formatVectorLiteral } from '../../services/embeddings/memory-chunks';
import { logger } from '../../utils/logger';

type ArtifactRow = Database['public']['Tables']['artifacts']['Row'];

export interface ArtifactSearchOptions {
  artifactType?: string;
  tags?: string[];
  visibility?: string;
  workspaceId?: string;
  limit?: number;
  offset?: number;
}

export type ArtifactSearchMode = 'text' | 'semantic' | 'hybrid' | 'auto';

export interface ArtifactSearchResult {
  id: string;
  uri: string;
  title: string;
  content: string;
  artifactType: string;
  tags: string[];
  version: number;
  updatedAt: string;
  workspaceId: string | null;
  textScore?: number;
  semanticScore?: number;
  finalScore: number;
}

interface MatchArtifactsArgs {
  query_embedding: string;
  match_threshold: number;
  match_count: number;
  p_user_id: string;
  p_workspace_id?: string;
  p_artifact_type?: string;
  p_tags?: string[];
  p_visibility?: string;
}

interface MatchArtifactsRpcClient {
  rpc(
    fn: 'match_artifacts',
    args: MatchArtifactsArgs
  ): { data: SemanticMatchRow[] | null; error: { message: string } | null };
}

interface SemanticMatchRow extends ArtifactRow {
  similarity: number;
}

export class ArtifactSearchRepository {
  private embeddingRouter: EmbeddingRouter;

  constructor(private supabase: SupabaseClient<Database>) {
    this.embeddingRouter = new EmbeddingRouter();
  }

  async search(
    userId: string,
    query: string,
    mode: ArtifactSearchMode,
    options: ArtifactSearchOptions = {}
  ): Promise<ArtifactSearchResult[]> {
    const limit = options.limit || 20;
    const offset = options.offset || 0;
    const effectiveMode =
      mode === 'auto' ? (this.embeddingRouter.isEnabled() ? 'hybrid' : 'text') : mode;

    switch (effectiveMode) {
      case 'text':
        return this.textSearch(userId, query, options, limit, offset);
      case 'semantic':
        return this.semanticSearch(userId, query, options, limit, offset);
      case 'hybrid':
        return this.hybridSearch(userId, query, options, limit, offset);
      default:
        return this.textSearch(userId, query, options, limit, offset);
    }
  }

  private async textSearch(
    userId: string,
    query: string,
    options: ArtifactSearchOptions,
    limit: number,
    offset: number
  ): Promise<ArtifactSearchResult[]> {
    let queryBuilder = this.supabase
      .from('artifacts')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    queryBuilder = this.applyFilters(queryBuilder, options);

    if (query) {
      const terms = this.buildSearchTerms(query);
      if (terms.length > 0) {
        const clauses = terms.flatMap((term) => [
          `title.ilike.%${term}%`,
          `content.ilike.%${term}%`,
        ]);
        queryBuilder = queryBuilder.or(clauses.join(','));
      }
    }

    queryBuilder = queryBuilder.range(offset, offset + limit - 1);

    const { data, error } = await queryBuilder;

    if (error) {
      logger.error('Artifact text search failed', { error: error.message });
      throw new Error(`Artifact text search failed: ${error.message}`);
    }

    return (data || []).map((row) => {
      const textScore = query ? this.computeTextScore(query, row) : 0;
      return this.rowToResult(row, { textScore, finalScore: textScore });
    });
  }

  private async semanticSearch(
    userId: string,
    query: string,
    options: ArtifactSearchOptions,
    limit: number,
    offset: number
  ): Promise<ArtifactSearchResult[]> {
    if (!query) return [];

    const queryEmbedding = await this.embeddingRouter.embedQuery(query);
    if (!queryEmbedding) {
      logger.warn('Artifact semantic search: embedding generation failed, falling back to text');
      return this.textSearch(userId, query, options, limit, offset);
    }

    const config = this.embeddingRouter.getRuntimeConfig();
    const matchCount = Math.max(
      limit,
      (offset + limit) * Math.max(1, config.matchCountMultiplier || 1)
    );

    const rpcArgs: MatchArtifactsArgs = {
      query_embedding: formatVectorLiteral(queryEmbedding.vector),
      match_threshold: config.queryThreshold,
      match_count: matchCount,
      p_user_id: userId,
      p_workspace_id: options.workspaceId,
      p_artifact_type: options.artifactType,
      p_tags: options.tags && options.tags.length > 0 ? options.tags : undefined,
      p_visibility: options.visibility,
    };

    const rpcClient = this.supabase as unknown as MatchArtifactsRpcClient;
    const { data, error } = await rpcClient.rpc('match_artifacts', rpcArgs);

    if (error) {
      logger.warn('Artifact semantic search RPC failed, falling back to text', {
        error: error.message,
      });
      return this.textSearch(userId, query, options, limit, offset);
    }

    const rows = ((data || []) as SemanticMatchRow[]).slice(offset, offset + limit);
    return rows.map((row) => {
      const semanticScore = Math.max(0, Math.min(1, row.similarity ?? 0));
      return this.rowToResult(row, { semanticScore, finalScore: semanticScore });
    });
  }

  private async hybridSearch(
    userId: string,
    query: string,
    options: ArtifactSearchOptions,
    limit: number,
    offset: number
  ): Promise<ArtifactSearchResult[]> {
    const config = this.embeddingRouter.getRuntimeConfig();
    const candidatePool = Math.max(
      limit,
      (offset + limit) * Math.max(1, config.matchCountMultiplier)
    );

    const [semanticResults, textResults] = await Promise.all([
      this.semanticSearch(userId, query, options, limit, offset),
      this.textSearch(userId, query, options, candidatePool, 0),
    ]);

    const byId = new Map<string, ArtifactSearchResult>();

    for (const result of semanticResults) {
      byId.set(result.id, result);
    }

    for (const result of textResults) {
      const existing = byId.get(result.id);
      if (existing) {
        existing.textScore = result.textScore;
      } else {
        byId.set(result.id, result);
      }
    }

    const merged = Array.from(byId.values()).map((result) => ({
      ...result,
      finalScore: (result.semanticScore ?? 0) * 0.7 + (result.textScore ?? 0) * 0.3,
    }));

    merged.sort((a, b) => b.finalScore - a.finalScore || b.updatedAt.localeCompare(a.updatedAt));

    return merged.slice(offset, offset + limit);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private applyFilters(query: any, options: ArtifactSearchOptions) {
    if (options.workspaceId) {
      query = query.eq('workspace_id', options.workspaceId);
    }
    if (options.artifactType) {
      query = query.eq('artifact_type', options.artifactType);
    }
    if (options.tags && options.tags.length > 0) {
      query = query.overlaps('tags', options.tags);
    }
    if (options.visibility) {
      query = query.eq('visibility', options.visibility);
    }
    return query;
  }

  private buildSearchTerms(query: string): string[] {
    const full = query
      .trim()
      .replace(/[,%()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const tokens = full
      .split(' ')
      .filter((t) => t.length > 2)
      .sort((a, b) => b.length - a.length)
      .slice(0, 3);
    return Array.from(new Set([full, ...tokens].filter(Boolean)));
  }

  private computeTextScore(query: string, row: ArtifactRow): number {
    const queryLower = query.toLowerCase();
    const tokens = queryLower.split(/\s+/).filter((t) => t.length > 2);
    if (tokens.length === 0) return 0;

    const haystack = `${row.title} ${row.content} ${(row.tags || []).join(' ')}`.toLowerCase();
    const overlapCount = tokens.filter((token) => haystack.includes(token)).length;
    let score = overlapCount / tokens.length;

    if (haystack.includes(queryLower)) score += 0.2;
    if (row.title.toLowerCase().includes(queryLower)) score += 0.2;

    return Math.min(1, score);
  }

  private rowToResult(
    row: ArtifactRow,
    scores: { textScore?: number; semanticScore?: number; finalScore: number }
  ): ArtifactSearchResult {
    return {
      id: row.id,
      uri: row.uri,
      title: row.title,
      content: row.content,
      artifactType: row.artifact_type,
      tags: row.tags || [],
      version: row.version ?? 1,
      updatedAt: row.updated_at ?? row.created_at ?? new Date().toISOString(),
      workspaceId: row.workspace_id,
      textScore: scores.textScore,
      semanticScore: scores.semanticScore,
      finalScore: scores.finalScore,
    };
  }
}
