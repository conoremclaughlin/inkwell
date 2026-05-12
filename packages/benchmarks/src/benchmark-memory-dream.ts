import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSupabaseClient } from '@inklabs/api/benchmarks';
import { loadLongMemEvalDreamDataset } from './benchmark-data/longmemeval-loader';
import { hasOptionalAnswer } from './benchmark-answer-coverage';
import { loadBenchmarkSeedState } from './benchmark-memory-recall.state';
import {
  applyLocalDreamUpdate,
  buildOrderedDreamSessions,
  createInitialDreamState,
  renderDreamStateForAnswerCheck,
  type DreamMemoryRow,
  type DreamMode,
  type DreamState,
} from './benchmark-memory-dream.logic';

const BENCHMARK_TOPIC = 'benchmark:memory-recall';
const DEFAULT_PROGRESS_EVERY = 5;

interface DreamCaseResult {
  caseId: string;
  query: string;
  answer?: string;
  questionType?: string;
  questionDate?: string;
  answerSessionIds: string[];
  sessionCount: number;
  processedSessionCount: number;
  missingSessionIds: string[];
  extraMemoryIds: string[];
  answerInDream: boolean | null;
  answerInSource: boolean | null;
  finalState: DreamState;
  steps: DreamStepSummary[];
}

interface DreamStepSummary {
  sessionId: string;
  memoryId: string;
  index: number;
  hasAnswer: boolean;
  isAnswerSession: boolean;
  entityCount: number;
  durableFactCount: number;
  currentStateCount: number;
  temporalEventCount: number;
}

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function parsePositiveInt(raw: string | undefined, defaultValue: number): number {
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultValue;
}

function parseDreamMode(raw: string | undefined): DreamMode {
  const normalized = (raw || 'online').trim().toLowerCase();
  if (normalized === 'online' || normalized === 'batch') return normalized;
  console.warn(`[memory-dream] unknown MEMORY_DREAM_MODE=${raw}; falling back to online`);
  return 'online';
}

async function writeJsonOutput(outputPath: string, payload: unknown): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf-8');
}

async function loadCaseMemories(params: {
  supabase: ReturnType<typeof createSupabaseClient>;
  userId: string;
  topic: string;
  limit: number;
}): Promise<DreamMemoryRow[]> {
  const { data, error } = await params.supabase
    .from('memories')
    .select('id,content,summary,metadata,created_at')
    .eq('user_id', params.userId)
    .contains('topics', [params.topic])
    .order('created_at', { ascending: true })
    .limit(params.limit);

  if (error) throw new Error(`Failed to load dream memories for ${params.topic}: ${error.message}`);
  return (data || []) as DreamMemoryRow[];
}

function buildSourceText(sessions: { content: string }[]): string {
  return sessions
    .map((session) => session.content.replace(/^session\s+[^\r\n]+[\r\n]+/i, ''))
    .join('\n\n');
}

function logProgress(params: {
  completedCases: number;
  totalCases: number;
  processedSessions: number;
  lastCaseId: string;
  lastMs: number;
}) {
  console.log(
    `[memory-dream] progress cases=${params.completedCases}/${params.totalCases} ` +
      `sessions=${params.processedSessions} lastCase=${params.lastCaseId} lastMs=${params.lastMs}`
  );
}

async function main() {
  const userId = process.env.BENCHMARK_USER_ID || process.env.MEMORY_DREAM_USER_ID;
  if (!userId) {
    throw new Error('BENCHMARK_USER_ID or MEMORY_DREAM_USER_ID is required');
  }

  const mode = parseDreamMode(process.env.MEMORY_DREAM_MODE);
  if (mode === 'batch') {
    console.warn(
      '[memory-dream] MEMORY_DREAM_MODE=batch is reserved for a future batch reducer; current runner still applies the online local reducer'
    );
  }
  const strictSeed = parseBoolean(process.env.MEMORY_DREAM_STRICT_SEED, true);
  const writeSteps = parseBoolean(process.env.MEMORY_DREAM_WRITE_STEPS, true);
  const memoryLoadLimit = parsePositiveInt(process.env.MEMORY_DREAM_MEMORY_LOAD_LIMIT, 1000);
  const progressEvery = parsePositiveInt(
    process.env.MEMORY_DREAM_PROGRESS_EVERY,
    DEFAULT_PROGRESS_EVERY
  );
  const seedPath =
    process.env.MEMORY_DREAM_SEED_PATH ||
    process.env.MEMORY_BENCHMARK_SEED_PATH ||
    resolve(process.cwd(), 'output', 'memory-benchmarks', 'memory-benchmark.seed.json');
  const runId = process.env.MEMORY_DREAM_RUN_ID || `memory-dream-${Date.now()}-${randomUUID()}`;
  const outputPath =
    process.env.MEMORY_DREAM_OUTPUT_PATH ||
    resolve(process.cwd(), 'output', 'memory-dreams', `${runId}.json`);

  const [{ cases, source }, seedState] = await Promise.all([
    loadLongMemEvalDreamDataset(),
    loadBenchmarkSeedState(seedPath),
  ]);
  if (!seedState) throw new Error(`Missing seed state at ${seedPath}`);

  const supabase = createSupabaseClient();
  const results: DreamCaseResult[] = [];
  let processedSessions = 0;

  console.log(
    `[memory-dream] start mode=${mode} cases=${cases.length} seedId=${seedState.seedId} seedPath=${seedPath}`
  );
  console.log(`[memory-dream] source=${source} outputPath=${outputPath} writeSteps=${writeSteps}`);

  for (const [caseIndex, dreamCase] of cases.entries()) {
    const startedAt = Date.now();
    const seededCase = seedState.seededCases[dreamCase.id];
    if (!seededCase) {
      const message = `Seed state does not include case ${dreamCase.id}`;
      if (strictSeed) throw new Error(message);
      console.warn(`[memory-dream] ${message}; skipping`);
      continue;
    }

    const rows = await loadCaseMemories({
      supabase,
      userId,
      topic: seededCase.topic || `${BENCHMARK_TOPIC}:${seedState.seedId}:${dreamCase.id}`,
      limit: memoryLoadLimit,
    });
    const ordered = buildOrderedDreamSessions(dreamCase, rows);
    if (strictSeed && ordered.missingSessionIds.length > 0) {
      throw new Error(
        `Case ${dreamCase.id} is missing seeded sessions: ${ordered.missingSessionIds.join(', ')}`
      );
    }

    let state = createInitialDreamState(dreamCase.id, mode);
    const steps: DreamStepSummary[] = [];

    for (const [sessionIndex, session] of ordered.sessions.entries()) {
      state = applyLocalDreamUpdate(state, session);
      processedSessions += 1;
      if (writeSteps) {
        steps.push({
          sessionId: session.sessionId,
          memoryId: session.memoryId,
          index: sessionIndex,
          hasAnswer: session.hasAnswer,
          isAnswerSession: session.isAnswerSession,
          entityCount: state.entities.length,
          durableFactCount: state.durableFacts.length,
          currentStateCount: state.currentStates.length,
          temporalEventCount: state.temporalEvents.length,
        });
      }
    }

    const renderedDream = renderDreamStateForAnswerCheck(state);
    const sourceText = buildSourceText(ordered.sessions);
    results.push({
      caseId: dreamCase.id,
      query: dreamCase.query,
      answer: dreamCase.answer,
      questionType: dreamCase.questionType,
      questionDate: dreamCase.questionDate,
      answerSessionIds: dreamCase.answerSessionIds,
      sessionCount: dreamCase.sessions.length,
      processedSessionCount: ordered.sessions.length,
      missingSessionIds: ordered.missingSessionIds,
      extraMemoryIds: ordered.extraMemoryIds,
      answerInDream: hasOptionalAnswer(renderedDream, dreamCase.answer),
      answerInSource: hasOptionalAnswer(sourceText, dreamCase.answer),
      finalState: state,
      steps,
    });

    if ((caseIndex + 1) % progressEvery === 0 || caseIndex === cases.length - 1) {
      logProgress({
        completedCases: caseIndex + 1,
        totalCases: cases.length,
        processedSessions,
        lastCaseId: dreamCase.id,
        lastMs: Date.now() - startedAt,
      });
    }
  }

  const answerable = results.filter((result) => result.answerInSource === true);
  const payload = {
    runId,
    settings: {
      mode,
      dataset: 'longmemeval-s-cleaned',
      source,
      seedId: seedState.seedId,
      seedPath,
      outputPath,
      caseCount: cases.length,
      strictSeed,
      writeSteps,
      memoryLoadLimit,
      note: 'First-pass dream run uses existing per-memory LLM extraction views and a local online reducer. It does not write new DB memories or embeddings. Batch mode is accepted for future experiments but currently uses the same online reducer.',
    },
    summary: {
      cases: results.length,
      processedSessions,
      missingSessionCount: results.reduce(
        (sum, result) => sum + result.missingSessionIds.length,
        0
      ),
      answerInSource: results.filter((result) => result.answerInSource === true).length,
      answerInDream: results.filter((result) => result.answerInDream === true).length,
      answerInDreamWhenSourceHasAnswer: answerable.filter((result) => result.answerInDream === true)
        .length,
      answerableCases: answerable.length,
    },
    results,
  };

  await writeJsonOutput(outputPath, payload);
  console.log(JSON.stringify(payload.summary, null, 2));
  console.log(`[memory-dream] complete outputPath=${outputPath}`);
}

main().catch((error) => {
  console.error('[memory-dream] failed:', error);
  process.exit(1);
});
