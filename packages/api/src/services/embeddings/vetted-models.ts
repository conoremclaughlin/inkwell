export type EmbeddingProviderKind = 'ollama' | 'openai';

export interface VettedEmbeddingModel {
  provider: EmbeddingProviderKind;
  model: string;
  recommendedFor: string;
  dimensions: number[];
  notes: string;
  default?: boolean;
}

/**
 * Vetted models for PCP memory embeddings.
 * Keep this list intentionally small and operationally safe.
 */
export const VETTED_EMBEDDING_MODELS: VettedEmbeddingModel[] = [
  {
    provider: 'ollama',
    model: 'mxbai-embed-large',
    recommendedFor: 'Best local quality (recommended local default)',
    dimensions: [1024],
    notes: 'Higher quality local embeddings; larger model footprint.',
    default: true,
  },
  {
    provider: 'ollama',
    model: 'nomic-embed-text',
    recommendedFor: 'Balanced local quality/speed',
    dimensions: [768, 512, 256, 128, 64],
    notes: 'Good local option when lower dimensionality is desired.',
  },
  {
    provider: 'ollama',
    model: 'all-minilm',
    recommendedFor: 'Fastest lightweight local baseline',
    dimensions: [384],
    notes: 'Small footprint; useful for quick experiments.',
  },
  {
    provider: 'openai',
    model: 'text-embedding-3-small',
    recommendedFor: 'Reliable API default',
    dimensions: [1536, 1024, 512, 256],
    notes: 'Strong cost/performance API model for production defaults.',
    default: true,
  },
  {
    provider: 'openai',
    model: 'text-embedding-3-large',
    recommendedFor: 'Highest API retrieval quality',
    dimensions: [3072, 2048, 1024, 512, 256],
    notes: 'Highest quality API option with larger vectors/cost.',
  },
];

export function getDefaultVettedModel(provider: EmbeddingProviderKind): string {
  return (
    VETTED_EMBEDDING_MODELS.find((m) => m.provider === provider && m.default)?.model ||
    (provider === 'ollama' ? 'mxbai-embed-large' : 'text-embedding-3-small')
  );
}
