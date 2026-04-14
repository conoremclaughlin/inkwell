import type { MemoryHybridChunkStrategy, MemorySearchOptions } from '@inklabs/api/benchmarks';
import type { RecallMode } from './benchmark-memory-recall.types';

export type BenchmarkRecallVariant =
  | 'default'
  | 'content-only'
  | 'derived-only'
  | 'multiview-no-boost'
  | 'multiview-no-chrono';

const VARIANT_ALIASES: Record<string, BenchmarkRecallVariant> = {
  default: 'default',
  full: 'default',
  'content-only': 'content-only',
  content: 'content-only',
  raw: 'content-only',
  'derived-only': 'derived-only',
  derived: 'derived-only',
  'multiview-no-boost': 'multiview-no-boost',
  noboost: 'multiview-no-boost',
  'multi-view-no-boost': 'multiview-no-boost',
  'multiview-no-chrono': 'multiview-no-chrono',
  'no-chrono': 'multiview-no-chrono',
  'multi-view-no-chrono': 'multiview-no-chrono',
};

export function parseBenchmarkRecallVariant(raw?: string): BenchmarkRecallVariant {
  if (!raw) return 'default';
  const normalized = raw.trim().toLowerCase();
  const variant = VARIANT_ALIASES[normalized];
  if (!variant) {
    console.warn(`[memory-benchmark] Unrecognized variant "${raw}", falling back to "default"`);
    return 'default';
  }
  return variant;
}

function buildVariantSemanticOptions(
  variant: BenchmarkRecallVariant
): Partial<MemorySearchOptions> {
  switch (variant) {
    case 'content-only':
      return {
        semanticChunkTypes: ['content'],
        applyChunkTypeBoosts: false,
      };
    case 'derived-only':
      return {
        semanticChunkTypes: ['summary', 'fact', 'topic', 'entity'],
        applyChunkTypeBoosts: false,
      };
    case 'multiview-no-boost':
      return {
        semanticChunkTypes: ['summary', 'fact', 'topic', 'entity', 'content'],
        applyChunkTypeBoosts: false,
      };
    case 'multiview-no-chrono':
      return {};
    case 'default':
    default:
      return {};
  }
}

function buildVariantHybridOptions(
  variant: BenchmarkRecallVariant
): Pick<
  MemorySearchOptions,
  'hybridChunkStrategy' | 'applyChunkTypeBoosts' | 'applyMultiViewBoost' | 'applyChronologyBoost'
> {
  const base: Pick<
    MemorySearchOptions,
    'hybridChunkStrategy' | 'applyChunkTypeBoosts' | 'applyMultiViewBoost' | 'applyChronologyBoost'
  > = {
    hybridChunkStrategy: 'default',
    applyChunkTypeBoosts: true,
    applyMultiViewBoost: true,
    applyChronologyBoost: true,
  };

  switch (variant) {
    case 'content-only':
      return {
        hybridChunkStrategy: 'content-only',
        applyChunkTypeBoosts: false,
        applyMultiViewBoost: false,
        applyChronologyBoost: false,
      };
    case 'derived-only':
      return {
        hybridChunkStrategy: 'derived-only',
        applyChunkTypeBoosts: false,
        applyMultiViewBoost: false,
        applyChronologyBoost: false,
      };
    case 'multiview-no-boost':
      return {
        hybridChunkStrategy: 'default',
        applyChunkTypeBoosts: false,
        applyMultiViewBoost: false,
        applyChronologyBoost: false,
      };
    case 'multiview-no-chrono':
      return {
        ...base,
        applyChronologyBoost: false,
      };
    case 'default':
    default:
      return base;
  }
}

export function buildBenchmarkRecallOptions(params: {
  mode: RecallMode;
  variant: BenchmarkRecallVariant;
  limit: number;
  agentId: string;
  topics: string[];
}): MemorySearchOptions {
  const base: MemorySearchOptions = {
    recallMode: params.mode,
    limit: params.limit,
    agentId: params.agentId,
    includeShared: true,
    topics: params.topics,
  };

  if (params.mode === 'semantic' || params.mode === 'auto') {
    return {
      ...base,
      ...buildVariantSemanticOptions(params.variant),
    };
  }

  if (params.mode === 'hybrid') {
    return {
      ...base,
      ...buildVariantHybridOptions(params.variant),
    };
  }

  return base;
}

export function describeBenchmarkRecallVariant(variant: BenchmarkRecallVariant): {
  name: BenchmarkRecallVariant;
  semanticChunkTypes: MemorySearchOptions['semanticChunkTypes'] | 'default';
  hybridChunkStrategy: MemoryHybridChunkStrategy;
  applyChunkTypeBoosts: boolean;
  applyMultiViewBoost: boolean;
  applyChronologyBoost: boolean;
} {
  const semanticOptions = buildVariantSemanticOptions(variant);
  const hybridOptions = buildVariantHybridOptions(variant);

  return {
    name: variant,
    semanticChunkTypes: semanticOptions.semanticChunkTypes || 'default',
    hybridChunkStrategy: hybridOptions.hybridChunkStrategy || 'default',
    applyChunkTypeBoosts: hybridOptions.applyChunkTypeBoosts !== false,
    applyMultiViewBoost: hybridOptions.applyMultiViewBoost !== false,
    applyChronologyBoost: hybridOptions.applyChronologyBoost !== false,
  };
}
