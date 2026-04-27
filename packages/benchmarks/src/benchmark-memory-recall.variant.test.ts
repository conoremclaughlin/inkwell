import { describe, expect, it } from 'vitest';
import {
  buildBenchmarkRecallOptions,
  describeBenchmarkRecallVariant,
  parseBenchmarkRecallVariant,
} from './benchmark-memory-recall.variant';

describe('benchmark-memory-recall variants', () => {
  it('parses friendly aliases', () => {
    expect(parseBenchmarkRecallVariant(undefined)).toBe('default');
    expect(parseBenchmarkRecallVariant('raw')).toBe('content-only');
    expect(parseBenchmarkRecallVariant('content+entity')).toBe('content-plus-entity');
    expect(parseBenchmarkRecallVariant('parallel-content-entity')).toBe(
      'content-plus-entity-parallel'
    );
    expect(parseBenchmarkRecallVariant('entities')).toBe('entity-only');
    expect(parseBenchmarkRecallVariant('durable-facts')).toBe('fact-only');
    expect(parseBenchmarkRecallVariant('derived')).toBe('derived-only');
    expect(parseBenchmarkRecallVariant('no-chrono')).toBe('multiview-no-chrono');
    expect(parseBenchmarkRecallVariant('unknown')).toBe('default');
  });

  it('builds content-only hybrid options without boosts', () => {
    expect(
      buildBenchmarkRecallOptions({
        mode: 'hybrid',
        variant: 'content-only',
        limit: 5,
        agentId: 'lumen',
        topics: ['benchmark:memory-recall:case-1'],
      })
    ).toMatchObject({
      recallMode: 'hybrid',
      limit: 5,
      agentId: 'lumen',
      topics: ['benchmark:memory-recall:case-1'],
      hybridChunkStrategy: 'content-only',
      applyChunkTypeBoosts: false,
      applyMultiViewBoost: false,
      applyChronologyBoost: false,
    });
  });

  it('builds semantic derived-only options', () => {
    expect(
      buildBenchmarkRecallOptions({
        mode: 'semantic',
        variant: 'derived-only',
        limit: 5,
        agentId: 'lumen',
        topics: ['benchmark:memory-recall:case-2'],
      })
    ).toMatchObject({
      recallMode: 'semantic',
      semanticChunkTypes: ['summary', 'fact', 'topic', 'entity'],
      applyChunkTypeBoosts: false,
    });
  });

  it('builds explicit entity-only options for semantic and hybrid recall', () => {
    expect(
      buildBenchmarkRecallOptions({
        mode: 'semantic',
        variant: 'entity-only',
        limit: 5,
        agentId: 'lumen',
        topics: ['benchmark:memory-recall:case-entity'],
      })
    ).toMatchObject({
      recallMode: 'semantic',
      semanticChunkTypes: ['entity'],
      applyChunkTypeBoosts: false,
    });

    expect(
      buildBenchmarkRecallOptions({
        mode: 'hybrid',
        variant: 'entity-only',
        limit: 5,
        agentId: 'lumen',
        topics: ['benchmark:memory-recall:case-entity'],
      })
    ).toMatchObject({
      recallMode: 'hybrid',
      semanticChunkTypes: ['entity'],
      hybridChunkStrategy: 'derived-only',
      applyChunkTypeBoosts: false,
      applyMultiViewBoost: false,
      applyChronologyBoost: false,
    });
  });

  it('builds explicit content-plus-entity options for semantic and hybrid recall', () => {
    expect(
      buildBenchmarkRecallOptions({
        mode: 'semantic',
        variant: 'content-plus-entity',
        limit: 5,
        agentId: 'lumen',
        topics: ['benchmark:memory-recall:case-content-entity'],
      })
    ).toMatchObject({
      recallMode: 'semantic',
      semanticChunkTypes: ['content', 'entity'],
      applyChunkTypeBoosts: false,
    });

    expect(
      buildBenchmarkRecallOptions({
        mode: 'hybrid',
        variant: 'content-plus-entity',
        limit: 5,
        agentId: 'lumen',
        topics: ['benchmark:memory-recall:case-content-entity'],
      })
    ).toMatchObject({
      recallMode: 'hybrid',
      semanticChunkTypes: ['content', 'entity'],
      hybridChunkStrategy: 'default',
      applyChunkTypeBoosts: false,
      applyMultiViewBoost: false,
      applyChronologyBoost: false,
    });
  });

  it('builds explicit content-plus-entity-parallel options for semantic and hybrid recall', () => {
    expect(
      buildBenchmarkRecallOptions({
        mode: 'semantic',
        variant: 'content-plus-entity-parallel',
        limit: 5,
        agentId: 'lumen',
        topics: ['benchmark:memory-recall:case-content-entity-parallel'],
      })
    ).toMatchObject({
      recallMode: 'semantic',
      semanticChunkTypes: ['content', 'entity'],
      semanticQueryStrategy: 'parallel-content-entity',
      applyChunkTypeBoosts: false,
    });

    expect(
      buildBenchmarkRecallOptions({
        mode: 'hybrid',
        variant: 'content-plus-entity-parallel',
        limit: 5,
        agentId: 'lumen',
        topics: ['benchmark:memory-recall:case-content-entity-parallel'],
      })
    ).toMatchObject({
      recallMode: 'hybrid',
      semanticChunkTypes: ['content', 'entity'],
      semanticQueryStrategy: 'parallel-content-entity',
      hybridChunkStrategy: 'default',
      applyChunkTypeBoosts: false,
      applyMultiViewBoost: false,
      applyChronologyBoost: false,
    });
  });

  it('describes the default variant explicitly', () => {
    expect(describeBenchmarkRecallVariant('default')).toEqual({
      name: 'default',
      semanticChunkTypes: 'default',
      semanticQueryStrategy: undefined,
      hybridChunkStrategy: 'default',
      applyChunkTypeBoosts: false,
      applyMultiViewBoost: false,
      applyChronologyBoost: false,
    });
  });

  it('keeps semantic defaults for multiview-no-chrono', () => {
    expect(
      buildBenchmarkRecallOptions({
        mode: 'semantic',
        variant: 'multiview-no-chrono',
        limit: 5,
        agentId: 'lumen',
        topics: ['benchmark:memory-recall:case-3'],
      })
    ).toMatchObject({
      recallMode: 'semantic',
      limit: 5,
      agentId: 'lumen',
      topics: ['benchmark:memory-recall:case-3'],
    });
    expect(
      buildBenchmarkRecallOptions({
        mode: 'semantic',
        variant: 'multiview-no-chrono',
        limit: 5,
        agentId: 'lumen',
        topics: ['benchmark:memory-recall:case-3'],
      })
    ).not.toHaveProperty('semanticChunkTypes');
  });

  it('disables all boosts for multiview-no-boost', () => {
    expect(
      buildBenchmarkRecallOptions({
        mode: 'hybrid',
        variant: 'multiview-no-boost',
        limit: 5,
        agentId: 'lumen',
        topics: ['benchmark:memory-recall:case-4'],
      })
    ).toMatchObject({
      recallMode: 'hybrid',
      hybridChunkStrategy: 'multi-view',
      applyChunkTypeBoosts: false,
      applyMultiViewBoost: false,
      applyChronologyBoost: false,
    });
  });
});
