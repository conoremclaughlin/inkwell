import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createSupabaseClient, MemoryRepository } from '@inklabs/api/benchmarks';
import {
  buildBenchmarkRecallOptions,
  parseBenchmarkRecallVariant,
} from './benchmark-memory-recall.variant';
import { answerTokenCoverage, hasAnswer, snippetAroundAnswer } from './benchmark-answer-coverage';
import type { RecallMode } from './benchmark-memory-recall.types';

type LongMemEvalTurn = {
  role?: string;
  content?: string;
};

type LongMemEvalInstance = {
  question_id?: string;
  question_type?: string;
  question?: string;
  answer?: string | number;
  question_date?: string;
};

type SeededCase = {
  topic: string;
  targetMemoryIds: string[];
};

type SeedState = {
  seedId: string;
  seededCases: Record<string, SeededCase>;
};

const TOP_K = 5;
const DEFAULT_LONGMEMEVAL_PATH = resolve(process.cwd(), '.cache', 'longmemeval_s_cleaned.json');
const BENCHMARK_AGENT_ID = 'lumen';

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function parseMode(raw?: string): RecallMode {
  if (raw === 'text' || raw === 'semantic' || raw === 'hybrid' || raw === 'auto') return raw;
  return 'semantic';
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf-8')) as T;
}

async function writeJson(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf-8');
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

async function main() {
  const userId = process.env.BENCHMARK_USER_ID;
  if (!userId) {
    throw new Error('BENCHMARK_USER_ID is required.');
  }

  const rawPath = process.env.LONGMEMEVAL_DATASET_PATH || DEFAULT_LONGMEMEVAL_PATH;
  const seedPath =
    process.env.MEMORY_BENCHMARK_SEED_PATH ||
    resolve(
      process.cwd(),
      'output',
      'memory-benchmarks',
      'longmem-100c-all-distractors-20260427.seed.json'
    );
  const outputPath =
    process.env.MEMORY_ANSWER_BENCHMARK_OUTPUT_PATH ||
    resolve(
      process.cwd(),
      'output',
      'memory-answer-benchmarks',
      `longmem-answer-${Date.now()}.json`
    );
  const offset = parseNonNegativeInt(process.env.LONGMEMEVAL_OFFSET, 0);
  const limit = parsePositiveInt(process.env.LONGMEMEVAL_LIMIT, 100);
  const variant = parseBenchmarkRecallVariant(process.env.MEMORY_BENCHMARK_VARIANT);
  const mode = parseMode(process.env.MEMORY_BENCHMARK_MODE);
  const progressEvery = parsePositiveInt(process.env.MEMORY_BENCHMARK_PROGRESS_EVERY, 10);

  const raw = await readJson<LongMemEvalInstance[]>(rawPath);
  const seed = await readJson<SeedState>(seedPath);
  const cases = raw.slice(offset, offset + limit).filter((item) => {
    return (
      item.question_id &&
      item.question &&
      item.answer !== undefined &&
      seed.seededCases[item.question_id]
    );
  });

  const repo = new MemoryRepository(createSupabaseClient());
  const runs = [];
  const startedAt = Date.now();

  console.log(
    `[memory-answer-benchmark] cases=${cases.length} offset=${offset} limit=${limit} variant=${variant} mode=${mode} seed=${seed.seedId}`
  );

  for (const [index, benchCase] of cases.entries()) {
    const caseId = benchCase.question_id!;
    const query = benchCase.question!;
    const answer = benchCase.answer!;
    const seeded = seed.seededCases[caseId];
    const recalled = await repo.recall(
      userId,
      query,
      buildBenchmarkRecallOptions({
        mode,
        variant,
        limit: TOP_K,
        agentId: BENCHMARK_AGENT_ID,
        topics: [seeded.topic],
      })
    );

    const targetIds = new Set(seeded.targetMemoryIds);
    const targetRank = recalled.findIndex((memory) => targetIds.has(memory.id));
    const top1Text = recalled[0]?.content || '';
    const top5Text = recalled.map((memory) => memory.content).join('\n\n---\n\n');
    const top1AnswerCoverage = answerTokenCoverage(top1Text, answer);
    const top5AnswerCoverage = answerTokenCoverage(top5Text, answer);
    const top1ContainsAnswer = hasAnswer(top1Text, answer);
    const top5ContainsAnswer = hasAnswer(top5Text, answer);

    runs.push({
      caseId,
      questionType: benchCase.question_type || null,
      query,
      answer: String(answer),
      targetRank: targetRank >= 0 ? targetRank + 1 : null,
      top1ContainsAnswer,
      top5ContainsAnswer,
      top1AnswerCoverage: round(top1AnswerCoverage),
      top5AnswerCoverage: round(top5AnswerCoverage),
      topSummaries: recalled.map((memory) => memory.summary || memory.content.slice(0, 80)),
      top1Snippet: snippetAroundAnswer(top1Text, answer),
    });

    if ((index + 1) % progressEvery === 0 || index === cases.length - 1) {
      const elapsedMs = Date.now() - startedAt;
      console.log(
        `[memory-answer-benchmark] progress ${index + 1}/${cases.length} elapsed=${Math.round(
          elapsedMs / 1000
        )}s`
      );
    }
  }

  const top1Contains = runs.filter((run) => run.top1ContainsAnswer).length;
  const top5Contains = runs.filter((run) => run.top5ContainsAnswer).length;
  const targetAt1 = runs.filter((run) => run.targetRank === 1).length;
  const targetAt5 = runs.filter((run) => run.targetRank !== null && run.targetRank <= TOP_K).length;
  const payload = {
    settings: {
      dataset: 'longmemeval-s-cleaned',
      rawPath,
      seedPath,
      seedId: seed.seedId,
      offset,
      limit,
      variant,
      mode,
      topK: TOP_K,
      outputPath,
    },
    summary: {
      cases: runs.length,
      targetRecallAt1: round(targetAt1 / runs.length),
      targetRecallAt5: round(targetAt5 / runs.length),
      answerInTop1: round(top1Contains / runs.length),
      answerInTop5: round(top5Contains / runs.length),
      meanTop1AnswerCoverage: round(mean(runs.map((run) => run.top1AnswerCoverage))),
      meanTop5AnswerCoverage: round(mean(runs.map((run) => run.top5AnswerCoverage))),
    },
    misses: runs.filter((run) => !run.top5ContainsAnswer),
    nonTop1Answers: runs.filter((run) => !run.top1ContainsAnswer),
    runs,
  };

  await writeJson(outputPath, payload);
  console.log(JSON.stringify(payload.summary, null, 2));
  console.log(`[memory-answer-benchmark] wrote ${outputPath}`);
}

main().catch((error) => {
  console.error('[memory-answer-benchmark] failed:', error);
  process.exit(1);
});
