import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import {
  getDefaultVettedModel,
  VETTED_EMBEDDING_MODELS,
  type EmbeddingProviderKind,
  type VettedEmbeddingModel,
} from './vetted-models';

export interface EmbeddingResult {
  vector: number[];
  provider: EmbeddingProviderKind;
  model: string;
  dimensions: number;
}

export interface EmbeddingRuntimeConfig {
  enabled: boolean;
  provider: EmbeddingProviderKind;
  model: string;
  dimensions: number;
  queryThreshold: number;
  matchCountMultiplier: number;
  ollamaBaseUrl: string;
  openaiBaseUrl: string;
  hasOpenAIKey: boolean;
}

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';
const MEMORY_EMBEDDING_SCHEMA_DIMENSIONS = 1024;

function findVettedModel(
  provider: EmbeddingProviderKind,
  model: string
): VettedEmbeddingModel | null {
  return (
    VETTED_EMBEDDING_MODELS.find(
      (candidate) => candidate.provider === provider && candidate.model === model
    ) || null
  );
}

function assertExpectedDimensions(
  vector: number[],
  expectedDimensions: number,
  provider: EmbeddingProviderKind,
  model: string
): number[] {
  if (vector.length !== expectedDimensions) {
    throw new Error(
      `${provider}:${model} returned ${vector.length} dimensions, expected ${expectedDimensions}`
    );
  }
  return vector;
}

function buildRuntimeConfig(): EmbeddingRuntimeConfig {
  const provider = env.MEMORY_EMBEDDING_PROVIDER || 'ollama';
  const model = env.MEMORY_EMBEDDING_MODEL || getDefaultVettedModel(provider);
  const configuredDimensions = env.MEMORY_EMBEDDING_DIMENSIONS;
  const dimensions = MEMORY_EMBEDDING_SCHEMA_DIMENSIONS; // Current memories.embedding column is vector(1024)

  if (configuredDimensions !== dimensions) {
    logger.warn('Overriding configured memory embedding dimensions to match schema', {
      configuredDimensions,
      enforcedDimensions: dimensions,
    });
  }

  const vettedModel = findVettedModel(provider, model);
  if (vettedModel && !vettedModel.dimensions.includes(dimensions)) {
    logger.warn('Selected embedding model does not advertise support for schema dimensions', {
      provider,
      model,
      schemaDimensions: dimensions,
      supportedDimensions: vettedModel.dimensions,
    });
  }

  return {
    enabled: env.MEMORY_EMBEDDINGS_ENABLED,
    provider,
    model,
    dimensions,
    queryThreshold: env.MEMORY_EMBEDDING_QUERY_THRESHOLD,
    matchCountMultiplier: env.MEMORY_EMBEDDING_MATCH_COUNT_MULTIPLIER,
    ollamaBaseUrl: env.OLLAMA_BASE_URL,
    openaiBaseUrl: env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL,
    hasOpenAIKey: Boolean(env.OPENAI_API_KEY),
  };
}

export class EmbeddingRouter {
  private readonly config: EmbeddingRuntimeConfig;

  constructor(config: EmbeddingRuntimeConfig = buildRuntimeConfig()) {
    this.config = config;
  }

  getRuntimeConfig(): EmbeddingRuntimeConfig {
    return this.config;
  }

  listVettedModels() {
    return VETTED_EMBEDDING_MODELS;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  async embedDocument(text: string): Promise<EmbeddingResult | null> {
    return this.embed(text);
  }

  async embedQuery(text: string): Promise<EmbeddingResult | null> {
    return this.embed(text);
  }

  private async embed(text: string): Promise<EmbeddingResult | null> {
    if (!this.config.enabled) return null;
    const input = text.trim();
    if (!input) return null;

    try {
      if (this.config.provider === 'openai') {
        return await this.embedWithOpenAI(input);
      }
      return await this.embedWithOllama(input);
    } catch (primaryError) {
      logger.warn('Primary embedding provider failed, attempting fallback', {
        provider: this.config.provider,
        model: this.config.model,
        error: primaryError instanceof Error ? primaryError.message : String(primaryError),
      });

      try {
        if (this.config.provider === 'ollama' && this.config.hasOpenAIKey) {
          const fallback = await this.embedWithOpenAI(
            input,
            getDefaultVettedModel('openai'),
            this.config.dimensions
          );
          logger.info('Embedding fallback succeeded', {
            from: 'ollama',
            to: 'openai',
            model: fallback.model,
          });
          return fallback;
        }

        if (this.config.provider === 'openai') {
          const fallback = await this.embedWithOllama(
            input,
            getDefaultVettedModel('ollama'),
            this.config.dimensions
          );
          logger.info('Embedding fallback succeeded', {
            from: 'openai',
            to: 'ollama',
            model: fallback.model,
          });
          return fallback;
        }
      } catch (fallbackError) {
        logger.warn('Embedding fallback failed', {
          provider: this.config.provider,
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        });
      }

      return null;
    }
  }

  private async embedWithOllama(
    text: string,
    model: string = this.config.model,
    dimensions: number = this.config.dimensions
  ): Promise<EmbeddingResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${this.config.ollamaBaseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          input: [text],
          truncate: true,
          dimensions,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Ollama embed failed (${response.status})`);
      }

      const data = (await response.json()) as {
        embeddings?: number[][];
        embedding?: number[];
      };

      const rawVector = data.embeddings?.[0] || data.embedding;
      if (!rawVector || !Array.isArray(rawVector)) {
        throw new Error('Ollama embed returned no embedding vector');
      }

      const vector = assertExpectedDimensions(rawVector, dimensions, 'ollama', model);
      return { vector, provider: 'ollama', model, dimensions: vector.length };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async embedWithOpenAI(
    text: string,
    model: string = this.config.model,
    dimensions: number = this.config.dimensions
  ): Promise<EmbeddingResult> {
    if (!env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not configured');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${this.config.openaiBaseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          input: text,
          dimensions,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`OpenAI embeddings failed (${response.status})`);
      }

      const data = (await response.json()) as {
        data?: Array<{ embedding?: number[] }>;
      };
      const rawVector = data.data?.[0]?.embedding;
      if (!rawVector || !Array.isArray(rawVector)) {
        throw new Error('OpenAI embeddings returned no embedding vector');
      }
      const vector = assertExpectedDimensions(rawVector, dimensions, 'openai', model);
      return { vector, provider: 'openai', model, dimensions: vector.length };
    } finally {
      clearTimeout(timeout);
    }
  }
}
