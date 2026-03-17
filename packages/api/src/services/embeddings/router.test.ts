import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../config/env';
import { EmbeddingRouter, type EmbeddingRuntimeConfig } from './router';

const baseConfig: EmbeddingRuntimeConfig = {
  enabled: true,
  provider: 'openai',
  model: 'text-embedding-3-small',
  dimensions: 1024,
  queryThreshold: 0.2,
  matchCountMultiplier: 5,
  ollamaBaseUrl: 'http://localhost:11434',
  openaiBaseUrl: 'https://api.openai.com',
  hasOpenAIKey: true,
};

describe('EmbeddingRouter', () => {
  const originalOpenAIKey = env.OPENAI_API_KEY;

  beforeEach(() => {
    (env as { OPENAI_API_KEY?: string }).OPENAI_API_KEY = 'test-key';
  });

  afterEach(() => {
    (env as { OPENAI_API_KEY?: string }).OPENAI_API_KEY = originalOpenAIKey;
    vi.restoreAllMocks();
  });

  it('accepts exact-dimension OpenAI embeddings without normalization', async () => {
    const vector = [0.1, 0.2, 0.3];
    const fetchMock = vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: vector }] }),
    } as Response);

    const router = new EmbeddingRouter({ ...baseConfig, dimensions: 3 });
    const result = await router.embedQuery('hello world');

    expect(result).toEqual({
      vector,
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 3,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"dimensions":3'),
      })
    );
  });

  it('fails closed when Ollama returns the wrong dimensionality', async () => {
    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }),
    } as Response);

    const router = new EmbeddingRouter({
      ...baseConfig,
      provider: 'ollama',
      model: 'mxbai-embed-large',
      dimensions: 4,
      hasOpenAIKey: false,
    });

    const result = await router.embedDocument('doc');
    expect(result).toBeNull();
  });
});
