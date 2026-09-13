import type { MemorySemanticIndex } from '@inklabs/api/benchmarks';
import type { LoCoMoRepresentation } from './benchmark-data/locomo-loader';
import type { LoCoMoPhase } from './benchmark-locomo.state';

export const DEFAULT_LOCOMO_TOP_KS = [1, 3, 5, 10] as const;
export type ForcedSemanticIndex = Exclude<MemorySemanticIndex, 'runtime-configured'>;

export function parseLoCoMoPhase(raw: string | undefined): LoCoMoPhase {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'seed' || normalized === 'recall' || normalized === 'all') {
    return normalized;
  }
  throw new Error('LOCOMO_PHASE is required and must be seed, recall, or all.');
}

export function parseLoCoMoRepresentation(raw: string | undefined): LoCoMoRepresentation {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'turn' || normalized === 'session') return normalized;
  throw new Error('LOCOMO_REPRESENTATION is required and must be turn or session.');
}

export function parseLoCoMoSemanticIndex(raw: string | undefined): ForcedSemanticIndex {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'memory-single-vector' || normalized === 'memory-chunks') {
    return normalized;
  }
  if (!normalized) return 'memory-chunks';
  throw new Error(
    'LOCOMO_SEMANTIC_INDEX must be memory-chunks or memory-single-vector when provided.'
  );
}

export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${JSON.stringify(raw)}.`);
  }
  return parsed;
}

export function parseOptionalPositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  return parsePositiveInt(raw, 1);
}

export function parseLoCoMoTopKs(raw: string | undefined): number[] {
  const values = (raw ? raw.split(',') : DEFAULT_LOCOMO_TOP_KS).map((value) =>
    typeof value === 'number' ? value : Number(value.trim())
  );
  if (values.length === 0 || values.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error('LOCOMO_TOP_KS must be a comma-separated list of positive integers.');
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

export function parseOptionalCsv(raw: string | undefined): string[] | null {
  if (!raw?.trim()) return null;
  const values = [
    ...new Set(
      raw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ];
  return values.length > 0 ? values : null;
}
