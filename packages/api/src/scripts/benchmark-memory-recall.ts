import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSupabaseClient } from '../data/supabase/client';
import { MemoryRepository } from '../data/repositories/memory-repository';
import { getBenchmarkDataset } from './benchmark-data/datasets';
import { loadHfBenchmarkDataset } from './benchmark-data/hf-loader';
import { type PublicBenchmarkFamily, getPublicBenchmarkDescriptor } from './benchmark-data/public-benchmarks';

type RecallMode = 'text' | 'semantic' | 'hybrid' | 'auto';

function parseBenchmarkFamily(raw?: string): PublicBenchmarkFamily | null {
  if (!raw) return null;
  return getPublicBenchmarkDescriptor(raw.trim().toLowerCase() as PublicBenchmarkFamily).family;
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
const MAX_CONTENT_CHARS = 1200;

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

function clampContent(text: string): string {
  if (text.length <= MAX_CONTENT_CHARS) return text;
  return `${text.slice(0, MAX_CONTENT_CHARS)}...`;
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
  }
): Promise<void> {
  const { runId, userId, dataset, topK, caseCount, modes, summary, runs, datasetSource, benchmarkFamily } = params;

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

async function loadBenchmarkCases(dataset: string) {
  if (dataset === 'hf') {
    const hf = await loadHfBenchmarkDataset();
    return { cases: hf.cases, source: hf.source };
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
  const modes = parseModes(process.env.MEMORY_BENCHMARK_MODES);
  const persistResults = parseBoolean(process.env.MEMORY_BENCHMARK_PERSIST, true);
  const writeOutputFile = parseBoolean(process.env.MEMORY_BENCHMARK_WRITE_FILE, true);

  const runId = `membench-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const outputPath =
    process.env.MEMORY_BENCHMARK_OUTPUT_PATH ||
    resolve(process.cwd(), 'output', 'memory-benchmarks', `${runId}.json`);

  const supabase = createSupabaseClient();
  const repo = new MemoryRepository(supabase);
  const createdMemoryIds: string[] = [];

  const caseTargets: Record<string, string> = {};
  const caseTopics: Record<string, string[]> = {};

  try {
    for (const benchCase of benchmarkCases) {
      const caseTopic = `${BENCHMARK_TOPIC}:${runId}:${benchCase.id}`;
      caseTopics[benchCase.id] = [caseTopic];

      const target = await repo.remember({
        userId,
        agentId: BENCHMARK_AGENT_ID,
        content: clampContent(benchCase.targetContent),
        summary: `benchmark target ${benchCase.id}`,
        source: 'observation',
        salience: 'low',
        topicKey: BENCHMARK_TOPIC,
        topics: [BENCHMARK_TOPIC, caseTopic],
      });
      createdMemoryIds.push(target.id);
      caseTargets[benchCase.id] = target.id;

      for (let i = 0; i < benchCase.distractors.length; i += 1) {
        const distractor = await repo.remember({
          userId,
          agentId: BENCHMARK_AGENT_ID,
          content: clampContent(benchCase.distractors[i]),
          summary: `benchmark distractor ${benchCase.id} #${i + 1}`,
          source: 'observation',
          salience: 'low',
          topicKey: BENCHMARK_TOPIC,
          topics: [BENCHMARK_TOPIC, caseTopic],
        });
        createdMemoryIds.push(distractor.id);
      }
    }

    const runs: CaseRun[] = [];

    for (const mode of modes) {
      for (const benchCase of benchmarkCases) {
        const results = await repo.recall(userId, benchCase.query, {
          recallMode: mode,
          limit: TOP_K,
          agentId: BENCHMARK_AGENT_ID,
          includeShared: true,
          topics: caseTopics[benchCase.id],
        });

        const expectedId = caseTargets[benchCase.id];
        const rank = results.findIndex((m) => m.id === expectedId);

        runs.push({
          caseId: benchCase.id,
          query: benchCase.query,
          mode,
          rank: rank >= 0 ? rank + 1 : null,
          topSummaries: results.map((m) => m.summary || m.content.slice(0, 80)),
        });
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
      },
      summary,
      runs,
      outputPath: writeOutputFile ? outputPath : null,
    };

    if (writeOutputFile) {
      await writeJsonOutput(outputPath, payload);
    }

    console.log(JSON.stringify(payload, null, 2));
  } finally {
    for (const memoryId of createdMemoryIds) {
      try {
        await repo.forget(memoryId, userId);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

main().catch((error) => {
  console.error('[memory-benchmark] failed:', error);
  process.exit(1);
});
