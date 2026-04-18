import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSupabaseClient, MemoryRepository } from '@inklabs/api/benchmarks';
import { getBenchmarkDataset } from './benchmark-data/datasets';
import { loadHfBenchmarkDataset } from './benchmark-data/hf-loader';
import { loadLoCoMoDataset } from './benchmark-data/locomo-loader';
import { loadLongMemEvalDataset } from './benchmark-data/longmemeval-loader';
import {
  PUBLIC_BENCHMARKS,
  type PublicBenchmarkFamily,
  getPublicBenchmarkDescriptor,
} from './benchmark-data/public-benchmarks';
import {
  buildBenchmarkRecallOptions,
  describeBenchmarkRecallVariant,
  parseBenchmarkRecallVariant,
} from './benchmark-memory-recall.variant';
import {
  createInitialBenchmarkSeedState,
  createInitialBenchmarkRunState,
  estimateRemainingDuration,
  formatDurationMs,
  loadBenchmarkRunState,
  loadBenchmarkSeedState,
  writeBenchmarkSeedState,
  writeBenchmarkRunState,
} from './benchmark-memory-recall.state';
import type { RecallMode } from './benchmark-memory-recall.types';

function parseBenchmarkFamily(raw?: string): PublicBenchmarkFamily | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  const match = PUBLIC_BENCHMARKS.find((entry) => entry.family === normalized);
  return match ? match.family : null;
}

interface CaseRun {
  caseId: string;
  query: string;
  mode: RecallMode;
  rank: number | null;
  topSummaries: string[];
}

interface SummaryMetric {
  mode: RecallMode;
  cases: number;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  mrr: number;
}

const TOP_K = 5;
const BENCHMARK_TOPIC = 'benchmark:memory-recall';
const BENCHMARK_AGENT_ID = 'lumen';
const DEFAULT_DATASET = 'internal-gold-v1';
const RETRY_ATTEMPTS = 3;
const DEFAULT_PROGRESS_EVERY = 25;
type BenchmarkPhase = 'all' | 'seed' | 'recall';

function parseModes(raw?: string): RecallMode[] {
  if (!raw) return ['text', 'semantic', 'hybrid'];
  const parsed = raw
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean) as RecallMode[];
  return parsed.length > 0 ? parsed : ['text', 'semantic', 'hybrid'];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function parsePositiveInt(raw: string | undefined, defaultValue: number): number {
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.floor(parsed);
}

function parseBenchmarkPhase(raw?: string): BenchmarkPhase {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'seed' || normalized === 'recall' || normalized === 'all') return normalized;
  return 'all';
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function buildRepresentationKey(): string {
  const parts = [
    'chunked',
    process.env.MEMORY_EMBEDDINGS_ENABLED || 'default',
    process.env.MEMORY_EMBEDDING_PROVIDER || 'default',
    process.env.MEMORY_EMBEDDING_MODEL || 'default',
    process.env.MEMORY_LLM_EXTRACTION_ENABLED || 'false',
    process.env.MEMORY_LLM_ENTITY_ENABLED || 'false',
    process.env.MEMORY_LLM_DURABLE_FACT_ENABLED || 'false',
    process.env.MEMORY_LLM_SUMMARY_ENABLED || 'false',
    process.env.MEMORY_LLM_CURRENT_STATE_ENABLED || 'false',
  ];
  return slugify(parts.join('-'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTargetDocuments(benchCase: {
  targetContent?: string;
  targetContents?: string[];
}): string[] {
  if (Array.isArray(benchCase.targetContents) && benchCase.targetContents.length > 0) {
    return benchCase.targetContents;
  }

  if (typeof benchCase.targetContent === 'string' && benchCase.targetContent.trim().length > 0) {
    return [benchCase.targetContent];
  }

  throw new Error('Benchmark case must define targetContent or targetContents.');
}

async function withRetries<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_ATTEMPTS) break;
      console.warn(
        `[memory-benchmark] ${label} failed on attempt ${attempt}/${RETRY_ATTEMPTS}; retrying...`,
        error
      );
      await sleep(250 * attempt);
    }
  }

  throw lastError;
}

function buildSummaryMetrics(modes: RecallMode[], runs: CaseRun[]): SummaryMetric[] {
  return modes.map((mode) => {
    const modeRuns = runs.filter((r) => r.mode === mode);
    const reciprocalRanks = modeRuns.map((r) => (r.rank ? 1 / r.rank : 0));
    const hitsAt1 = modeRuns.filter((r) => r.rank === 1).length / modeRuns.length;
    const hitsAt3 = modeRuns.filter((r) => r.rank !== null && r.rank <= 3).length / modeRuns.length;
    const hitsAt5 = modeRuns.filter((r) => r.rank !== null && r.rank <= 5).length / modeRuns.length;

    return {
      mode,
      cases: modeRuns.length,
      recallAt1: round(hitsAt1),
      recallAt3: round(hitsAt3),
      recallAt5: round(hitsAt5),
      mrr: round(mean(reciprocalRanks)),
    };
  });
}

async function persistRun(
  supabase: any,
  params: {
    runId: string;
    userId: string;
    dataset: string;
    topK: number;
    caseCount: number;
    modes: RecallMode[];
    summary: SummaryMetric[];
    runs: CaseRun[];
    datasetSource: string;
    benchmarkFamily: PublicBenchmarkFamily | null;
    variantName: string;
  }
): Promise<void> {
  const {
    runId,
    userId,
    dataset,
    topK,
    caseCount,
    modes,
    summary,
    runs,
    datasetSource,
    benchmarkFamily,
    variantName,
  } = params;

  const modeRows = summary.map((metric) => ({
    run_id: runId,
    mode: metric.mode,
    cases: metric.cases,
    recall_at_1: metric.recallAt1,
    recall_at_3: metric.recallAt3,
    recall_at_5: metric.recallAt5,
    mrr: metric.mrr,
  }));

  const caseRows = runs.map((run) => ({
    run_id: runId,
    case_id: run.caseId,
    mode: run.mode,
    query: run.query,
    rank: run.rank,
    top_summaries: run.topSummaries,
  }));

  const runRow = {
    run_id: runId,
    user_id: userId,
    dataset,
    provider: process.env.MEMORY_EMBEDDING_PROVIDER || 'default',
    model: process.env.MEMORY_EMBEDDING_MODEL || 'default',
    embeddings_enabled: parseBoolean(process.env.MEMORY_EMBEDDINGS_ENABLED, false),
    top_k: topK,
    case_count: caseCount,
    modes,
    summary,
    metadata: {
      benchmarkTopic: BENCHMARK_TOPIC,
      benchmarkAgentId: BENCHMARK_AGENT_ID,
      datasetSource,
      benchmarkFamily,
      variant: variantName,
      benchmarkFamilyDescriptor: benchmarkFamily
        ? getPublicBenchmarkDescriptor(benchmarkFamily)
        : null,
    },
  };

  const { error: runError } = await supabase.from('memory_recall_benchmark_runs').insert(runRow);
  if (runError) throw new Error(`Failed to persist benchmark run: ${runError.message}`);

  const { error: metricsError } = await supabase
    .from('memory_recall_benchmark_metrics')
    .insert(modeRows);
  if (metricsError) throw new Error(`Failed to persist benchmark metrics: ${metricsError.message}`);

  const { error: caseError } = await supabase
    .from('memory_recall_benchmark_case_results')
    .insert(caseRows);
  if (caseError) throw new Error(`Failed to persist benchmark case results: ${caseError.message}`);
}

async function writeJsonOutput(outputPath: string, payload: unknown): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf-8');
}

function logProgress(params: {
  label: string;
  completed: number;
  total: number;
  durationMs: number;
  averageMs: number;
}) {
  console.log(
    `[memory-benchmark] ${params.label} ${params.completed}/${params.total} ` +
      `last=${formatDurationMs(params.durationMs)} avg=${formatDurationMs(Math.round(params.averageMs))} ` +
      `eta=${estimateRemainingDuration({
        completed: params.completed,
        total: params.total,
        averageMs: params.averageMs,
      })}`
  );
}

async function loadBenchmarkCases(dataset: string) {
  if (dataset === 'hf') {
    const hf = await loadHfBenchmarkDataset();
    return { cases: hf.cases, source: hf.source };
  }

  if (dataset === 'longmemeval-s-cleaned') {
    const longmemeval = await loadLongMemEvalDataset();
    return { cases: longmemeval.cases, source: longmemeval.source };
  }

  if (dataset === 'locomo10') {
    const locomo = await loadLoCoMoDataset();
    return { cases: locomo.cases, source: locomo.source };
  }

  return { cases: getBenchmarkDataset(dataset), source: `builtin:${dataset}` };
}

async function main() {
  const userId = process.env.BENCHMARK_USER_ID;
  if (!userId) {
    throw new Error(
      'BENCHMARK_USER_ID is required. Example: BENCHMARK_USER_ID=<uuid> yarn benchmark:memory-recall'
    );
  }

  const dataset = process.env.MEMORY_BENCHMARK_DATASET || DEFAULT_DATASET;
  const { cases: benchmarkCases, source: datasetSource } = await loadBenchmarkCases(dataset);
  const benchmarkFamily = parseBenchmarkFamily(process.env.MEMORY_BENCHMARK_FAMILY);
  const variant = parseBenchmarkRecallVariant(process.env.MEMORY_BENCHMARK_VARIANT);
  const modes = parseModes(process.env.MEMORY_BENCHMARK_MODES);
  const persistResults = parseBoolean(process.env.MEMORY_BENCHMARK_PERSIST, true);
  const writeOutputFile = parseBoolean(process.env.MEMORY_BENCHMARK_WRITE_FILE, true);
  const progressEvery = parsePositiveInt(
    process.env.MEMORY_BENCHMARK_PROGRESS_EVERY,
    DEFAULT_PROGRESS_EVERY
  );
  const phase = parseBenchmarkPhase(process.env.MEMORY_BENCHMARK_PHASE);
  const representationKey = buildRepresentationKey();

  const requestedRunId = process.env.MEMORY_BENCHMARK_RUN_ID;
  const runId = requestedRunId || `membench-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const seedId =
    process.env.MEMORY_BENCHMARK_SEED_ID ||
    `${slugify(dataset)}-${benchmarkFamily || 'custom'}-${representationKey}`;
  const outputPath =
    process.env.MEMORY_BENCHMARK_OUTPUT_PATH ||
    resolve(process.cwd(), 'output', 'memory-benchmarks', `${runId}.json`);
  const statePath =
    process.env.MEMORY_BENCHMARK_STATE_PATH ||
    resolve(process.cwd(), 'output', 'memory-benchmarks', `${runId}.state.json`);
  const seedPath =
    process.env.MEMORY_BENCHMARK_SEED_PATH ||
    resolve(process.cwd(), 'output', 'memory-benchmarks', `${seedId}.seed.json`);
  const existingSeedState = await loadBenchmarkSeedState(seedPath);
  const existingState = await loadBenchmarkRunState(statePath);
  const reuseSeeded = parseBoolean(
    process.env.MEMORY_BENCHMARK_REUSE_SEEDED,
    !!existingSeedState || !!existingState
  );
  const keepSeeded = parseBoolean(process.env.MEMORY_BENCHMARK_KEEP_SEEDED, true);
  const variantDescriptor = describeBenchmarkRecallVariant(variant);

  const supabase = createSupabaseClient();
  const repo = new MemoryRepository(supabase);
  const createdMemoryIds: string[] = [];

  const caseTargets: Record<string, string[]> = {};
  const caseTopics: Record<string, string[]> = {};
  const seedState =
    existingSeedState ||
    createInitialBenchmarkSeedState({
      seedId,
      dataset,
      datasetSource,
      benchmarkFamily,
      userId,
      representationKey,
    });
  const runState =
    existingState ||
    createInitialBenchmarkRunState({
      runId,
      seedId,
      dataset,
      datasetSource,
      benchmarkFamily,
      variant,
      userId,
      modes,
      outputPath,
    });

  if (!existingSeedState) {
    await writeBenchmarkSeedState(seedPath, seedState);
  }

  if (existingState) {
    console.log(
      `[memory-benchmark] Resuming run ${runState.runId} from ${statePath} ` +
        `(seeded=${Object.keys(runState.seededCases).length}, ` +
        `completed=${Object.values(runState.completedRuns).reduce((acc, runs) => acc + Object.keys(runs || {}).length, 0)})`
    );
  } else {
    await writeBenchmarkRunState(statePath, runState);
  }

  console.log(
    `[memory-benchmark] phase=${phase} seedId=${seedId} representation=${representationKey} seedPath=${seedPath}`
  );
  console.log(
    `[memory-benchmark] variant=${variantDescriptor.name} ` +
      `semanticChunkTypes=${Array.isArray(variantDescriptor.semanticChunkTypes) ? variantDescriptor.semanticChunkTypes.join('|') : variantDescriptor.semanticChunkTypes} ` +
      `hybridChunkStrategy=${variantDescriptor.hybridChunkStrategy} ` +
      `chunkBoost=${variantDescriptor.applyChunkTypeBoosts} multiView=${variantDescriptor.applyMultiViewBoost} chronology=${variantDescriptor.applyChronologyBoost}`
  );

  try {
    for (const [index, benchCase] of benchmarkCases.entries()) {
      const caseTopic = `${BENCHMARK_TOPIC}:${seedState.seedId}:${benchCase.id}`;
      caseTopics[benchCase.id] = [caseTopic];

      const seededCase = seedState.seededCases[benchCase.id] || runState.seededCases[benchCase.id];
      if (reuseSeeded && seededCase) {
        caseTargets[benchCase.id] = seededCase.targetMemoryIds;
        caseTopics[benchCase.id] = [seededCase.topic];
        runState.seededCases[benchCase.id] = seededCase;
        continue;
      }

      if (phase === 'recall') {
        throw new Error(
          `Missing seeded case for ${benchCase.id} in recall-only mode. Seed path: ${seedPath}`
        );
      }

      const seedStartedAt = Date.now();
      const targetMemoryIds: string[] = [];
      const targetDocuments = getTargetDocuments(benchCase);

      for (let i = 0; i < targetDocuments.length; i += 1) {
        const target = await withRetries(
          `remember target ${benchCase.id}${targetDocuments.length > 1 ? ` #${i + 1}` : ''}`,
          () =>
            repo.remember({
              userId,
              agentId: BENCHMARK_AGENT_ID,
              content: targetDocuments[i],
              summary:
                targetDocuments.length > 1
                  ? `benchmark target ${benchCase.id} #${i + 1}`
                  : `benchmark target ${benchCase.id}`,
              source: 'observation',
              salience: 'low',
              topicKey: BENCHMARK_TOPIC,
              topics: [BENCHMARK_TOPIC, caseTopic],
            })
        );
        createdMemoryIds.push(target.id);
        targetMemoryIds.push(target.id);
      }
      caseTargets[benchCase.id] = targetMemoryIds;
      const distractorIds: string[] = [];

      for (let i = 0; i < benchCase.distractors.length; i += 1) {
        const distractor = await withRetries(`remember distractor ${benchCase.id} #${i + 1}`, () =>
          repo.remember({
            userId,
            agentId: BENCHMARK_AGENT_ID,
            content: benchCase.distractors[i],
            summary: `benchmark distractor ${benchCase.id} #${i + 1}`,
            source: 'observation',
            salience: 'low',
            topicKey: BENCHMARK_TOPIC,
            topics: [BENCHMARK_TOPIC, caseTopic],
          })
        );
        createdMemoryIds.push(distractor.id);
        distractorIds.push(distractor.id);
      }

      const seedMs = Date.now() - seedStartedAt;
      const seededCaseState = {
        caseId: benchCase.id,
        topic: caseTopic,
        targetMemoryIds,
        distractorMemoryIds: distractorIds,
        seedMs,
      };
      seedState.seededCases[benchCase.id] = seededCaseState;
      runState.seededCases[benchCase.id] = seededCaseState;
      seedState.timings.seedCaseCount += 1;
      seedState.timings.seedTotalMs += seedMs;
      runState.timings.seedCaseCount = seedState.timings.seedCaseCount;
      runState.timings.seedTotalMs = seedState.timings.seedTotalMs;
      await writeBenchmarkSeedState(seedPath, seedState);
      await writeBenchmarkRunState(statePath, runState);

      if ((index + 1) % progressEvery === 0 || index === benchmarkCases.length - 1) {
        logProgress({
          label: 'seeded cases',
          completed: Object.keys(seedState.seededCases).length,
          total: benchmarkCases.length,
          durationMs: seedMs,
          averageMs: seedState.timings.seedTotalMs / Math.max(1, seedState.timings.seedCaseCount),
        });
      }
    }

    if (phase === 'seed') {
      console.log(
        JSON.stringify(
          {
            seedId,
            seedPath,
            dataset,
            datasetSource,
            benchmarkFamily,
            representationKey,
            seededCaseCount: Object.keys(seedState.seededCases).length,
            timings: {
              seedCaseCount: seedState.timings.seedCaseCount,
              seedTotalMs: seedState.timings.seedTotalMs,
              seedAverageMs:
                seedState.timings.seedTotalMs / Math.max(1, seedState.timings.seedCaseCount),
            },
          },
          null,
          2
        )
      );
      return;
    }

    const runs: CaseRun[] = [];

    for (const mode of modes) {
      const completedForMode = (runState.completedRuns[mode] ||= {});
      console.log(
        `[memory-benchmark] starting recall mode=${mode} completed=${Object.keys(completedForMode).length}/${benchmarkCases.length}`
      );

      for (const [index, benchCase] of benchmarkCases.entries()) {
        const resumed = completedForMode[benchCase.id];
        if (resumed) {
          runs.push({
            caseId: benchCase.id,
            query: benchCase.query,
            mode,
            rank: resumed.rank,
            topSummaries: resumed.topSummaries,
          });
          continue;
        }

        const recallStartedAt = Date.now();
        const results = await withRetries(`recall ${benchCase.id} (${mode})`, () =>
          repo.recall(
            userId,
            benchCase.query,
            buildBenchmarkRecallOptions({
              mode,
              variant,
              limit: TOP_K,
              agentId: BENCHMARK_AGENT_ID,
              topics: caseTopics[benchCase.id],
            })
          )
        );

        const expectedIds = new Set(caseTargets[benchCase.id]);
        const rank = results.findIndex((m) => expectedIds.has(m.id));
        const recallMs = Date.now() - recallStartedAt;

        const caseRun: CaseRun = {
          caseId: benchCase.id,
          query: benchCase.query,
          mode,
          rank: rank >= 0 ? rank + 1 : null,
          topSummaries: results.map((m) => m.summary || m.content.slice(0, 80)),
        };
        runs.push(caseRun);
        completedForMode[benchCase.id] = {
          rank: caseRun.rank,
          topSummaries: caseRun.topSummaries,
          recallMs,
        };
        runState.timings.recallCaseCount += 1;
        runState.timings.recallTotalMs += recallMs;
        await writeBenchmarkRunState(statePath, runState);

        const completedCount = Object.keys(completedForMode).length;
        if (completedCount % progressEvery === 0 || index === benchmarkCases.length - 1) {
          logProgress({
            label: `recalled ${mode}`,
            completed: completedCount,
            total: benchmarkCases.length,
            durationMs: recallMs,
            averageMs:
              runState.timings.recallTotalMs / Math.max(1, runState.timings.recallCaseCount),
          });
        }
      }
    }

    const summary = buildSummaryMetrics(modes, runs);

    if (persistResults) {
      await persistRun(supabase as any, {
        runId,
        userId,
        dataset,
        topK: TOP_K,
        caseCount: benchmarkCases.length,
        modes,
        summary,
        runs,
        datasetSource,
        benchmarkFamily,
        variantName: variantDescriptor.name,
      });
    }

    const payload = {
      runId,
      settings: {
        dataset,
        model: process.env.MEMORY_EMBEDDING_MODEL || 'default',
        provider: process.env.MEMORY_EMBEDDING_PROVIDER || 'default',
        embeddingsEnabled: process.env.MEMORY_EMBEDDINGS_ENABLED || 'default',
        topK: TOP_K,
        benchmarkCases: benchmarkCases.length,
        persistResults,
        datasetSource,
        benchmarkFamily,
        benchmarkFamilyDescriptor: benchmarkFamily
          ? getPublicBenchmarkDescriptor(benchmarkFamily)
          : null,
        variant: variantDescriptor,
        statePath,
        seedPath,
        reuseSeeded,
        keepSeeded,
        phase,
        seedCaseCount: Object.keys(seedState.seededCases).length,
        timings: {
          seedCaseCount: seedState.timings.seedCaseCount,
          seedTotalMs: seedState.timings.seedTotalMs,
          seedAverageMs:
            seedState.timings.seedTotalMs / Math.max(1, seedState.timings.seedCaseCount),
          recallCaseCount: runState.timings.recallCaseCount,
          recallTotalMs: runState.timings.recallTotalMs,
          recallAverageMs:
            runState.timings.recallTotalMs / Math.max(1, runState.timings.recallCaseCount),
        },
      },
      summary,
      runs,
      outputPath: writeOutputFile ? outputPath : null,
      statePath,
      seedPath,
    };

    if (writeOutputFile) {
      await writeJsonOutput(outputPath, payload);
    }

    console.log(JSON.stringify(payload, null, 2));
  } finally {
    if (!keepSeeded) {
      for (const memoryId of createdMemoryIds) {
        try {
          await repo.forget(memoryId, userId);
        } catch {
          // best-effort cleanup
        }
      }
    }
  }
}

main().catch((error) => {
  console.error('[memory-benchmark] failed:', error);
  process.exit(1);
});
