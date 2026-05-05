import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  batchMemoryExtractionResponseSchema,
  buildBatchExtractionPrompt,
  buildCurrentStateEmbeddingTexts,
  buildCurrentStateExtractionPrompt,
  buildDurableFactEmbeddingTexts,
  buildDurableFactExtractionPrompt,
  buildEntityEmbeddingTexts,
  buildEntityExtractionPrompt,
  buildSummaryEmbeddingTexts,
  buildSummaryExtractionPrompt,
  currentStateExtractionSchema,
  durableFactExtractionSchema,
  entityExtractionSchema,
  MemoryLlmExtractor,
  memoryExtractionsSchema,
  normalizeMemoryExtractions,
  summaryExtractionSchema,
} from './memory-llm-extraction';

describe('memory-llm-extraction', () => {
  const source = {
    summary: 'Discussed dev server behavior and merge process',
    content:
      'The current dev server auto-restarts when files change. We decided that every PR needs sibling review before merging to main. Wren and Lumen discussed the memory benchmark document and current architecture.',
    topicKey: 'project:ink/memory-benchmarks',
    topics: ['person:wren', 'person:lumen', 'process:pr-review'],
    source: 'observation',
    salience: 'high',
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds an entity prompt with explicit extraction guidance', () => {
    const prompt = buildEntityExtractionPrompt(source);
    expect(prompt.kind).toBe('entity');
    expect(prompt.systemPrompt).toContain('strict JSON');
    expect(prompt.userPrompt).toContain('Return at most 8 entities');
    expect(prompt.userPrompt).toContain('Memory text');
  });

  it('builds a durable fact prompt with decision and process emphasis', () => {
    const prompt = buildDurableFactExtractionPrompt(source);
    expect(prompt.kind).toBe('durable_fact');
    expect(prompt.userPrompt).toContain('decision');
    expect(prompt.userPrompt).toContain('process');
    expect(prompt.schemaDescription).toContain('durableFacts');
  });

  it('builds a summary prompt oriented to actionability', () => {
    const prompt = buildSummaryExtractionPrompt(source);
    expect(prompt.kind).toBe('summary');
    expect(prompt.userPrompt).toContain('actionRelevance');
    expect(prompt.systemPrompt).toContain('decision support');
  });

  it('builds a current-state prompt for volatile operational status', () => {
    const prompt = buildCurrentStateExtractionPrompt(source);
    expect(prompt.kind).toBe('current_state');
    expect(prompt.userPrompt).toContain('present or near-present operational state');
    expect(prompt.userPrompt).toContain('dev server auto-restarts');
  });

  it('builds a batch extraction prompt that keeps memories independent', () => {
    const prompt = buildBatchExtractionPrompt(
      [
        { memoryId: 'memory-a', source },
        {
          memoryId: 'memory-b',
          source: {
            ...source,
            content: 'A separate memory mentioned Conor and the benchmark plan.',
          },
        },
      ],
      ['entity', 'durable_fact', 'summary']
    );

    expect(prompt.systemPrompt).toContain('Treat each memory independently');
    expect(prompt.userPrompt).toContain('memory-a');
    expect(prompt.userPrompt).toContain('memory-b');
    expect(prompt.userPrompt).toContain('summarize only that single source memory');
    expect(prompt.schemaDescription).toContain('"results"');
    expect(prompt.schemaDescription).toContain('"durable_fact"');
  });

  it('formats embedding texts from structured entity extraction', () => {
    const parsed = entityExtractionSchema.parse({
      entities: [
        {
          name: 'Wren',
          aliases: ['wren'],
          entityType: 'person',
          description: 'Collaborator reviewing benchmark architecture',
          evidence: 'Wren and Lumen discussed the memory benchmark document.',
        },
      ],
    });

    expect(buildEntityEmbeddingTexts(parsed)).toEqual([
      expect.stringContaining('entity: Wren; type: person'),
    ]);
  });

  it('formats embedding texts from durable fact extraction', () => {
    const parsed = durableFactExtractionSchema.parse({
      durableFacts: [
        {
          fact: 'Every PR needs sibling review before merging to main.',
          category: 'process',
          subject: 'PR',
          object: 'sibling review',
          evidence: 'We decided that every PR needs sibling review before merging to main.',
        },
      ],
    });

    expect(buildDurableFactEmbeddingTexts(parsed)).toEqual([
      expect.stringContaining('category: process'),
    ]);
  });

  it('formats embedding texts from summary extraction', () => {
    const parsed = summaryExtractionSchema.parse({
      summary: 'The team discussed benchmark architecture and merge process constraints.',
      keyPoints: ['dev server auto-restarts', 'sibling review before merge'],
      actionRelevance: 'Helps future agents follow merge process and interpret current dev state.',
    });

    expect(buildSummaryEmbeddingTexts(parsed)[0]).toContain('action relevance');
  });

  it('formats embedding texts from current-state extraction', () => {
    const parsed = currentStateExtractionSchema.parse({
      state: 'Dev server auto-restarts on file change.',
      scope: 'local dev server',
      status: 'running',
      volatility: 'volatile',
      evidence: 'The current dev server auto-restarts when files change.',
    });

    expect(buildCurrentStateEmbeddingTexts(parsed)[0]).toContain('volatility: volatile');
  });

  it('normalizes extraction metadata', () => {
    const normalized = normalizeMemoryExtractions({
      version: 1,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      extractedAt: '2026-04-18T12:00:00.000Z',
      summary: {
        summary: 'Summary text',
        keyPoints: [],
        actionRelevance: 'Useful later',
      },
    });

    expect(normalized).toEqual(
      memoryExtractionsSchema.parse({
        version: 1,
        provider: 'openai',
        model: 'gpt-4.1-mini',
        extractedAt: '2026-04-18T12:00:00.000Z',
        summary: {
          summary: 'Summary text',
          keyPoints: [],
          actionRelevance: 'Useful later',
        },
      })
    );
  });

  it('parses batched extraction responses', () => {
    const parsed = batchMemoryExtractionResponseSchema.parse({
      results: [
        {
          memoryId: 'memory-a',
          entity: { entities: [] },
          durable_fact: { durableFacts: [] },
          summary: {
            summary: 'A memory about benchmark architecture.',
            keyPoints: ['benchmark architecture'],
            actionRelevance: 'Helps retrieve the benchmark discussion later.',
          },
        },
      ],
    });

    expect(parsed.results[0]?.memoryId).toBe('memory-a');
    expect(parsed.results[0]?.summary?.summary).toContain('benchmark architecture');
  });

  it('runs enabled extraction kinds and returns typed metadata', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    entities: [
                      {
                        name: 'Wren',
                        aliases: ['wren'],
                        entityType: 'person',
                        description: 'Reviewer',
                        evidence: 'Wren reviewed the benchmark.',
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'Benchmark review covered feature flags.',
                    keyPoints: ['feature flags', 'typed indexes'],
                    actionRelevance: 'Helps route future experiments.',
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        )
      );

    const extractor = new MemoryLlmExtractor({
      enabled: true,
      model: 'gpt-4.1-mini',
      baseUrl: 'https://api.openai.com',
      hasApiKey: true,
      maxInputChars: 5000,
      enabledKinds: ['entity', 'summary'],
    });

    const result = await extractor.extract(source);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result?.provider).toBe('openai');
    expect(result?.entity?.entities[0]?.name).toBe('Wren');
    expect(result?.summary?.summary).toContain('Benchmark review');
    expect(result?.durable_fact).toBeUndefined();
  });
});
