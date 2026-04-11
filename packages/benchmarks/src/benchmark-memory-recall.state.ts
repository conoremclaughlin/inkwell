import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RecallMode } from './benchmark-memory-recall.types';

export interface SeededCaseState {
  caseId: string;
  topic: string;
  targetMemoryIds: string[];
  distractorMemoryIds: string[];
  seedMs: number;
}

export interface CompletedCaseRunState {
  rank: number | null;
  topSummaries: string[];
  recallMs: number;
}

export interface BenchmarkTimingState {
  seedCaseCount: number;
  seedTotalMs: number;
  recallCaseCount: number;
  recallTotalMs: number;
}

export interface BenchmarkRunState {
  runId: string;
  dataset: string;
  datasetSource: string;
  benchmarkFamily: string | null;
  userId: string;
  modes: RecallMode[];
  outputPath: string;
  seededCases: Record<string, SeededCaseState>;
  completedRuns: Partial<Record<RecallMode, Record<string, CompletedCaseRunState>>>;
  timings: BenchmarkTimingState;
}

export function createInitialBenchmarkRunState(params: {
  runId: string;
  dataset: string;
  datasetSource: string;
  benchmarkFamily: string | null;
  userId: string;
  modes: RecallMode[];
  outputPath: string;
}): BenchmarkRunState {
  return {
    ...params,
    seededCases: {},
    completedRuns: {},
    timings: {
      seedCaseCount: 0,
      seedTotalMs: 0,
      recallCaseCount: 0,
      recallTotalMs: 0,
    },
  };
}

export async function loadBenchmarkRunState(statePath: string): Promise<BenchmarkRunState | null> {
  try {
    const raw = await readFile(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as BenchmarkRunState & {
      seededCases?: Record<
        string,
        SeededCaseState & {
          targetMemoryId?: string;
        }
      >;
    };

    if (parsed.seededCases) {
      for (const seededCase of Object.values(parsed.seededCases)) {
        if (!Array.isArray(seededCase.targetMemoryIds)) {
          seededCase.targetMemoryIds = seededCase.targetMemoryId ? [seededCase.targetMemoryId] : [];
        }
      }
    }

    return parsed as BenchmarkRunState;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeBenchmarkRunState(
  statePath: string,
  state: BenchmarkRunState
): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

export function formatDurationMs(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

export function estimateRemainingDuration(params: {
  completed: number;
  total: number;
  averageMs: number;
}): string {
  const remaining = Math.max(0, params.total - params.completed);
  if (remaining === 0 || params.averageMs <= 0) return '0ms';
  return formatDurationMs(Math.round(remaining * params.averageMs));
}
