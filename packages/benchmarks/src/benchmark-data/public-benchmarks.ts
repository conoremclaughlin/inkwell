export type PublicBenchmarkFamily = 'longmemeval' | 'locomo' | 'convomem' | 'membench';

export interface PublicBenchmarkDescriptor {
  family: PublicBenchmarkFamily;
  displayName: string;
  primaryQuestion: string;
  whyItMatters: string;
  recommendedMetrics: string[];
  implementationNotes: string[];
}

export const PUBLIC_BENCHMARKS: PublicBenchmarkDescriptor[] = [
  {
    family: 'longmemeval',
    displayName: 'LongMemEval',
    primaryQuestion: 'Can the system retrieve the right conversational memory over long horizons?',
    whyItMatters:
      'This is the cleanest first benchmark for Inkwell memory retrieval because it tests long-horizon conversational recall without being Ink-specific.',
    recommendedMetrics: ['recall@1', 'recall@3', 'recall@5', 'mrr', 'ndcg', 'latency'],
    implementationNotes: [
      'Start here first.',
      'Evaluate raw text, semantic, hybrid, chunked, and optional rerank tiers separately.',
      'Keep a no-LLM baseline as the primary honest comparison point.',
    ],
  },
  {
    family: 'locomo',
    displayName: 'LoCoMo',
    primaryQuestion:
      'Can the system retrieve and support questions that require temporal and multi-hop conversational reasoning?',
    whyItMatters:
      'LoCoMo adds pressure from temporal reasoning and cross-session dependencies, which are central to continuity claims.',
    recommendedMetrics: ['recall@5', 'recall@10', 'category breakdown', 'latency'],
    implementationNotes: [
      'Be careful with top-k settings so retrieval remains meaningful.',
      'Report category-level results, not just one overall score.',
    ],
  },
  {
    family: 'convomem',
    displayName: 'ConvoMem',
    primaryQuestion: 'How well does the system perform on large-scale conversational memory retrieval?',
    whyItMatters:
      'Useful for measuring scale and broader conversational coverage once LongMemEval and LoCoMo are stable.',
    recommendedMetrics: ['recall@k', 'category breakdown', 'latency'],
    implementationNotes: [
      'Good follow-up benchmark after LongMemEval parity.',
      'Useful for testing whether dream-phase extraction helps or hurts at scale.',
    ],
  },
  {
    family: 'membench',
    displayName: 'MemBench / BEAM-style suites',
    primaryQuestion:
      'How well does the system behave under broader noisy-memory and long-context retrieval pressure?',
    whyItMatters:
      'This is useful for the quality-vs-efficiency story and for comparing long-context memory tradeoffs.',
    recommendedMetrics: ['benchmark-specific score', 'latency', 'cost', 'token efficiency'],
    implementationNotes: [
      'Use this after the core conversational benchmarks are wired in.',
      'Helpful for positioning Ink against systems that emphasize token-efficient long-context memory.',
    ],
  },
];

export function getPublicBenchmarkDescriptor(
  family: PublicBenchmarkFamily
): PublicBenchmarkDescriptor {
  const descriptor = PUBLIC_BENCHMARKS.find((entry) => entry.family === family);
  if (!descriptor) throw new Error(`Unknown public benchmark family: ${family}`);
  return descriptor;
}
