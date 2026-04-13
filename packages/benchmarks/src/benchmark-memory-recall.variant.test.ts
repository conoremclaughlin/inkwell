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

  it('describes the default variant explicitly', () => {
    expect(describeBenchmarkRecallVariant('default')).toEqual({
      name: 'default',
      semanticChunkTypes: 'default',
      hybridChunkStrategy: 'default',
      applyChunkTypeBoosts: true,
      applyMultiViewBoost: true,
      applyChronologyBoost: true,
    });
  });
});
