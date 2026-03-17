import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSupabaseClient } from '../data/supabase/client';
import { MemoryRepository } from '../data/repositories/memory-repository';
import { getBootstrapRelevanceDataset } from './benchmark-data/datasets';

type Mode = 'baseline' | 'thread_aware';

interface CaseRun {
  caseId: string;
  mode: Mode;
  threadKey: string;
  rank: number | null;
  topSummaries: string[];
}

interface SummaryMetric {
  mode: Mode;
  cases: number;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  mrr: number;
}

const BENCHMARK_TOPIC = 'benchmark:bootstrap-relevance';
const BENCHMARK_AGENT_ID = 'lumen';
const DEFAULT_DATASET = 'bootstrap-relevance-v1';
const TOP_K = 5;

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((acc, val) => acc + val, 0) / values.length;
}

function buildSummaryMetrics(modes: Mode[], runs: CaseRun[]): SummaryMetric[] {
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

async function writeJsonOutput(outputPath: string, payload: unknown): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf-8');
}

async function persistRun(
  supabase: any,
  params: {
    runId: string;
    userId: string;
    dataset: string;
    modes: Mode[];
    summary: SummaryMetric[];
    runs: CaseRun[];
    caseCount: number;
  }
): Promise<void> {
  const modeRows = params.summary.map((metric) => ({
    run_id: params.runId,
    mode: metric.mode,
    cases: metric.cases,
    recall_at_1: metric.recallAt1,
    recall_at_3: metric.recallAt3,
    recall_at_5: metric.recallAt5,
    mrr: metric.mrr,
  }));

  const caseRows = params.runs.map((run) => ({
    run_id: params.runId,
    case_id: run.caseId,
    mode: run.mode,
    query: run.threadKey,
    rank: run.rank,
    top_summaries: run.topSummaries,
  }));

  const runRow = {
    run_id: params.runId,
    user_id: params.userId,
    dataset: params.dataset,
    provider: process.env.MEMORY_EMBEDDING_PROVIDER || 'bootstrap',
    model: process.env.MEMORY_EMBEDDING_MODEL || 'relevance',
    embeddings_enabled: true,
    top_k: TOP_K,
    case_count: params.caseCount,
    modes: params.modes,
    summary: params.summary,
    metadata: {
      benchmarkType: 'bootstrap_relevance',
      benchmarkTopic: BENCHMARK_TOPIC,
      benchmarkAgentId: BENCHMARK_AGENT_ID,
    },
  };

  const { error: runError } = await supabase.from('memory_recall_benchmark_runs').insert(runRow);
  if (runError) throw new Error(`Failed to persist benchmark run: ${runError.message}`);

  const { error: metricError } = await supabase
    .from('memory_recall_benchmark_metrics')
    .insert(modeRows);
  if (metricError) throw new Error(`Failed to persist benchmark metrics: ${metricError.message}`);

  const { error: caseError } = await supabase
    .from('memory_recall_benchmark_case_results')
    .insert(caseRows);
  if (caseError) throw new Error(`Failed to persist benchmark case results: ${caseError.message}`);
}

async function main() {
  const userId = process.env.BENCHMARK_USER_ID;
  if (!userId) {
    throw new Error(
      'BENCHMARK_USER_ID is required. Example: BENCHMARK_USER_ID=<uuid> yarn benchmark:bootstrap-relevance'
    );
  }

  const datasetName = process.env.BOOTSTRAP_BENCHMARK_DATASET || DEFAULT_DATASET;
  const dataset = getBootstrapRelevanceDataset(datasetName);
  const persistResults = parseBoolean(process.env.BOOTSTRAP_BENCHMARK_PERSIST, true);
  const writeOutputFile = parseBoolean(process.env.BOOTSTRAP_BENCHMARK_WRITE_FILE, true);

  const runId = `bootbench-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const outputPath =
    process.env.BOOTSTRAP_BENCHMARK_OUTPUT_PATH ||
    resolve(process.cwd(), 'output', 'bootstrap-benchmarks', `${runId}.json`);

  const supabase = createSupabaseClient();
  const repo = new MemoryRepository(supabase);
  const createdMemoryIds: string[] = [];
  const caseTargets: Record<string, string> = {};
  const modes: Mode[] = ['baseline', 'thread_aware'];

  try {
    for (const testCase of dataset) {
      const caseTopic = `${BENCHMARK_TOPIC}:${runId}:${testCase.id}`;

      // Intentionally create target first so baseline recency order is disadvantaged.
      const target = await repo.remember({
        userId,
        agentId: BENCHMARK_AGENT_ID,
        content: testCase.targetContent,
        summary: `bootstrap target ${testCase.id}`,
        source: 'observation',
        salience: 'high',
        topicKey: testCase.targetTopicKey,
        topics: [BENCHMARK_TOPIC, caseTopic, testCase.targetTopicKey],
        metadata: { threadKey: testCase.threadKey },
      });
      createdMemoryIds.push(target.id);
      caseTargets[testCase.id] = target.id;

      for (let i = 0; i < testCase.distractors.length; i += 1) {
        const distractor = await repo.remember({
          userId,
          agentId: BENCHMARK_AGENT_ID,
          content: testCase.distractors[i],
          summary: `bootstrap distractor ${testCase.id} #${i + 1}`,
          source: 'observation',
          salience: 'high',
          topicKey: `${BENCHMARK_TOPIC}:${testCase.id}:distractor:${i + 1}`,
          topics: [BENCHMARK_TOPIC, caseTopic],
        });
        createdMemoryIds.push(distractor.id);
      }
    }

    const runs: CaseRun[] = [];

    for (const mode of modes) {
      for (const testCase of dataset) {
        const context =
          mode === 'thread_aware'
            ? { threadKey: testCase.threadKey, focusText: testCase.focusText }
            : {};

        const results = await repo.getKnowledgeMemories(
          userId,
          BENCHMARK_AGENT_ID,
          20,
          30,
          context
        );
        const filtered = results.filter((memory) =>
          memory.topics.some((topic) =>
            topic.includes(`${BENCHMARK_TOPIC}:${runId}:${testCase.id}`)
          )
        );

        const topResults = filtered.slice(0, TOP_K);
        const rank = topResults.findIndex((m) => m.id === caseTargets[testCase.id]);

        runs.push({
          caseId: testCase.id,
          mode,
          threadKey: testCase.threadKey,
          rank: rank >= 0 ? rank + 1 : null,
          topSummaries: topResults.map((m) => m.summary || m.content.slice(0, 80)),
        });
      }
    }

    const summary = buildSummaryMetrics(modes, runs);

    if (persistResults) {
      await persistRun(supabase as any, {
        runId,
        userId,
        dataset: datasetName,
        modes,
        summary,
        runs,
        caseCount: dataset.length,
      });
    }

    const payload = {
      runId,
      settings: {
        dataset: datasetName,
        caseCount: dataset.length,
        topK: TOP_K,
        persistResults,
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
  console.error('[bootstrap-benchmark] failed:', error);
  process.exit(1);
});
