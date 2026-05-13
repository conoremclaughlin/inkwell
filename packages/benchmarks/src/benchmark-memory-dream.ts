import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import {
  ClaudeRunner,
  createSupabaseClient,
  type ClaudeRunnerConfig,
  type IRunner,
} from '@inklabs/api/benchmarks';
import { loadLongMemEvalDreamDataset } from './benchmark-data/longmemeval-loader';
import { hasOptionalAnswer } from './benchmark-answer-coverage';
import { loadBenchmarkSeedState } from './benchmark-memory-recall.state';
import {
  applyLocalDreamUpdate,
  buildBatchDreamPrompt,
  buildOnlineDreamPrompt,
  buildOrderedDreamSessions,
  coerceDreamStateUpdate,
  createInitialDreamState,
  renderDreamStateForAnswerCheck,
  type DreamMemoryRow,
  type DreamMode,
  type DreamState,
  type OrderedDreamSession,
} from './benchmark-memory-dream.logic';

const BENCHMARK_TOPIC = 'benchmark:memory-recall';
const DEFAULT_PROGRESS_EVERY = 5;
const DEFAULT_BATCH_CONTENT_EXCERPT_CHARS = 1200;
const DEFAULT_ONLINE_CONTENT_EXCERPT_CHARS = 4000;

interface DreamCaseResult {
  caseId: string;
  query: string;
  answer?: string;
  questionType?: string;
  questionDate?: string;
  answerSessionIds: string[];
  sessionCount: number;
  availableMemorySessionCount: number;
  processedSessionCount: number;
  missingSessionIds: string[];
  extraMemoryIds: string[];
  answerInDream: boolean | null;
  answerInSource: boolean | null;
  finalState: DreamState;
  steps: DreamStepSummary[];
  runnerFailureCount: number;
  runnerCallCount: number;
  truncatedSessionCount: number;
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
  updateStatus: DreamUpdateStatus;
}

type DreamUpdaterKind = 'local' | 'runner';
type DreamBackend = 'codex' | 'claude';
type DreamUpdateStatus = 'local' | 'runner' | 'runner-failed-local-fallback';

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

function parseDreamUpdater(raw: string | undefined): DreamUpdaterKind {
  const normalized = (raw || 'local').trim().toLowerCase();
  if (normalized === 'local' || normalized === 'runner') return normalized;
  console.warn(`[memory-dream] unknown MEMORY_DREAM_UPDATER=${raw}; falling back to local`);
  return 'local';
}

function parseDreamBackend(raw: string | undefined): DreamBackend {
  const normalized = (raw || 'codex').trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'claude') return normalized;
  console.warn(`[memory-dream] unknown MEMORY_DREAM_BACKEND=${raw}; falling back to codex`);
  return 'codex';
}

function parseOptionalPositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function parseCaseIdFilter(raw: string | undefined): Set<string> | null {
  if (!raw?.trim()) return null;
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
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
  runnerCalls: number;
  runnerFailures: number;
}) {
  console.log(
    `[memory-dream] progress cases=${params.completedCases}/${params.totalCases} ` +
      `sessions=${params.processedSessions} runnerCalls=${params.runnerCalls} ` +
      `runnerFailures=${params.runnerFailures} lastCase=${params.lastCaseId} lastMs=${params.lastMs}`
  );
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const fencedJson = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedJson?.[1]?.trim()) return extractJsonObject(fencedJson[1]);
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('Dream runner response did not contain a JSON object');
  }
  return trimmed.slice(firstBrace, lastBrace + 1);
}

function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 700);
}

class RunnerDreamUpdater {
  private readonly runner: IRunner;
  private readonly config: ClaudeRunnerConfig;
  private callCount = 0;
  private failureCount = 0;

  constructor(private readonly backend: DreamBackend) {
    this.runner = new ClaudeRunner();
    this.config = {
      workingDirectory: process.env.MEMORY_DREAM_WORKING_DIRECTORY || process.cwd(),
      mcpConfigPath: process.env.MEMORY_DREAM_MCP_CONFIG_PATH || '',
      ...(process.env.MEMORY_DREAM_MODEL && backend === 'claude'
        ? { model: process.env.MEMORY_DREAM_MODEL }
        : {}),
      systemPrompt:
        'You are a deterministic memory dream worker. Do not use tools. Return only strict JSON matching the requested schema.',
      sandboxBypass: false,
    };
  }

  getCallCount(): number {
    return this.callCount;
  }

  getFailureCount(): number {
    return this.failureCount;
  }

  async updateOnline(params: {
    caseId: string;
    question: string;
    previousState: DreamState;
    nextSession: OrderedDreamSession;
    maxContentExcerptChars: number;
    useQuestionHints: boolean;
  }): Promise<DreamState> {
    const prompt = buildOnlineDreamPrompt(params);
    const raw = await this.runPrompt(prompt);
    return coerceDreamStateUpdate(raw, {
      previousState: params.previousState,
      currentSession: params.nextSession,
    });
  }

  async updateBatch(params: {
    caseId: string;
    question: string;
    initialState: DreamState;
    sessions: OrderedDreamSession[];
    maxContentExcerptChars: number;
    useQuestionHints: boolean;
  }): Promise<DreamState> {
    if (params.sessions.length === 0) return params.initialState;
    const prompt = buildBatchDreamPrompt({
      caseId: params.caseId,
      question: params.question,
      sessions: params.sessions,
      mode: params.initialState.mode,
      maxContentExcerptChars: params.maxContentExcerptChars,
      useQuestionHints: params.useQuestionHints,
    });
    const raw = await this.runPrompt(prompt);
    return coerceDreamStateUpdate(raw, {
      previousState: {
        ...params.initialState,
        sessionCount: Math.max(0, params.sessions.length - 1),
      },
      currentSession: params.sessions[params.sessions.length - 1],
    });
  }

  private async runPrompt(prompt: {
    systemPrompt: string;
    schemaDescription: string;
    userPrompt: string;
  }): Promise<unknown> {
    this.callCount += 1;
    const message = [
      prompt.systemPrompt,
      prompt.schemaDescription,
      '',
      'Return only the JSON object. Do not wrap it in Markdown. Do not call tools.',
      '',
      prompt.userPrompt,
    ].join('\n');

    if (this.backend === 'codex') {
      const content = await runCodexExecNoMcp(message);
      try {
        return JSON.parse(extractJsonObject(content));
      } catch (error) {
        this.failureCount += 1;
        throw error;
      }
    }

    const result = await this.runner.run(message, { config: this.config });
    if (!result.success) {
      this.failureCount += 1;
      throw new Error(result.error || `${this.backend} dream runner failed`);
    }

    const content =
      result.finalTextResponse ||
      result.responses
        .map((response) => response.content)
        .filter(Boolean)
        .join('\n');
    if (!content.trim()) {
      this.failureCount += 1;
      throw new Error(`${this.backend} dream runner returned no text`);
    }

    try {
      return JSON.parse(extractJsonObject(content));
    } catch (error) {
      this.failureCount += 1;
      throw error;
    }
  }
}

async function runCodexExecNoMcp(message: string): Promise<string> {
  const scratchDir = await mkdtemp(join(tmpdir(), 'ink-memory-dream-codex-'));
  const outputPath = join(scratchDir, 'last-message.txt');
  const codexBin = process.env.MEMORY_DREAM_CODEX_BIN || 'codex';
  const model = process.env.MEMORY_DREAM_MODEL || 'gpt-5.5';
  const timeoutMs = parsePositiveInt(process.env.MEMORY_DREAM_CODEX_TIMEOUT_MS, 10 * 60 * 1000);
  const args = [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--ephemeral',
    '--json',
    '-C',
    process.env.MEMORY_DREAM_WORKING_DIRECTORY || '/tmp',
    '-m',
    model,
    '-o',
    outputPath,
    '-',
  ];

  try {
    return await new Promise<string>((resolvePromise, rejectPromise) => {
      const proc = spawn(codexBin, args, {
        cwd: process.env.MEMORY_DREAM_WORKING_DIRECTORY || '/tmp',
        env: process.env,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let stderr = '';
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill('SIGTERM');
        rejectPromise(new Error(`Codex dream runner timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      proc.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        rejectPromise(error);
      });
      proc.on('close', async (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code !== 0) {
          rejectPromise(
            new Error(
              `Codex dream runner exited with code ${code} signal=${signal || 'none'}: ${stderr.slice(
                -2000
              )}`
            )
          );
          return;
        }
        try {
          resolvePromise(await readFile(outputPath, 'utf-8'));
        } catch (error) {
          rejectPromise(error);
        }
      });
      proc.stdin.end(message);
    });
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

async function main() {
  const userId = process.env.BENCHMARK_USER_ID || process.env.MEMORY_DREAM_USER_ID;
  if (!userId) {
    throw new Error('BENCHMARK_USER_ID or MEMORY_DREAM_USER_ID is required');
  }

  const mode = parseDreamMode(process.env.MEMORY_DREAM_MODE);
  const updaterKind = parseDreamUpdater(process.env.MEMORY_DREAM_UPDATER);
  const backend = parseDreamBackend(process.env.MEMORY_DREAM_BACKEND);
  const strictSeed = parseBoolean(process.env.MEMORY_DREAM_STRICT_SEED, true);
  const writeSteps = parseBoolean(process.env.MEMORY_DREAM_WRITE_STEPS, true);
  const memoryLoadLimit = parsePositiveInt(process.env.MEMORY_DREAM_MEMORY_LOAD_LIMIT, 1000);
  const maxSessionsPerCase = parseOptionalPositiveInt(
    process.env.MEMORY_DREAM_MAX_SESSIONS_PER_CASE
  );
  const batchContentExcerptChars = parsePositiveInt(
    process.env.MEMORY_DREAM_BATCH_CONTENT_EXCERPT_CHARS,
    DEFAULT_BATCH_CONTENT_EXCERPT_CHARS
  );
  const onlineContentExcerptChars = parsePositiveInt(
    process.env.MEMORY_DREAM_ONLINE_CONTENT_EXCERPT_CHARS,
    DEFAULT_ONLINE_CONTENT_EXCERPT_CHARS
  );
  const caseIdFilter = parseCaseIdFilter(process.env.MEMORY_DREAM_CASE_IDS);
  const useQuestionHints = parseBoolean(process.env.MEMORY_DREAM_USE_QUERY_HINTS, false);
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

  const selectedCases = caseIdFilter
    ? cases.filter((benchmarkCase) => caseIdFilter.has(benchmarkCase.id))
    : cases;
  if (selectedCases.length === 0) {
    throw new Error(
      `No LongMemEval cases matched MEMORY_DREAM_CASE_IDS=${process.env.MEMORY_DREAM_CASE_IDS}`
    );
  }

  const supabase = createSupabaseClient();
  const runnerUpdater = updaterKind === 'runner' ? new RunnerDreamUpdater(backend) : null;
  const results: DreamCaseResult[] = [];
  let processedSessions = 0;
  let runnerFailures = 0;
  let runnerCalls = 0;

  console.log(
    `[memory-dream] start mode=${mode} updater=${updaterKind} backend=${backend} ` +
      `cases=${selectedCases.length}/${cases.length} seedId=${seedState.seedId} seedPath=${seedPath}`
  );
  console.log(`[memory-dream] source=${source} outputPath=${outputPath} writeSteps=${writeSteps}`);

  for (const [caseIndex, dreamCase] of selectedCases.entries()) {
    const startedAt = Date.now();
    const caseRunnerCallsStart = runnerCalls;
    const caseRunnerFailuresStart = runnerFailures;
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
    const sessions = maxSessionsPerCase
      ? ordered.sessions.slice(0, maxSessionsPerCase)
      : ordered.sessions;
    const truncatedSessionCount = ordered.sessions.length - sessions.length;

    if (runnerUpdater && mode === 'batch') {
      let updateStatus: DreamUpdateStatus = 'runner';
      try {
        state = await runnerUpdater.updateBatch({
          caseId: dreamCase.id,
          question: dreamCase.query,
          initialState: state,
          sessions,
          maxContentExcerptChars: batchContentExcerptChars,
          useQuestionHints,
        });
      } catch (error) {
        updateStatus = 'runner-failed-local-fallback';
        console.warn(
          `[memory-dream] runner batch failed case=${dreamCase.id}; falling back to local reducer: ${compactError(error)}`
        );
        for (const session of sessions) state = applyLocalDreamUpdate(state, session);
      }
      processedSessions += sessions.length;
      runnerCalls = runnerUpdater.getCallCount();
      runnerFailures = runnerUpdater.getFailureCount();
      if (writeSteps) {
        for (const [sessionIndex, session] of sessions.entries()) {
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
            updateStatus,
          });
        }
      }
    } else {
      for (const [sessionIndex, session] of sessions.entries()) {
        let updateStatus: DreamUpdateStatus = 'local';
        if (runnerUpdater) {
          try {
            state = await runnerUpdater.updateOnline({
              caseId: dreamCase.id,
              question: dreamCase.query,
              previousState: state,
              nextSession: session,
              maxContentExcerptChars: onlineContentExcerptChars,
              useQuestionHints,
            });
            updateStatus = 'runner';
          } catch (error) {
            updateStatus = 'runner-failed-local-fallback';
            console.warn(
              `[memory-dream] runner online update failed case=${dreamCase.id} session=${session.sessionId}; falling back to local reducer: ${compactError(error)}`
            );
            state = applyLocalDreamUpdate(state, session);
          }
          runnerCalls = runnerUpdater.getCallCount();
          runnerFailures = runnerUpdater.getFailureCount();
        } else {
          state = applyLocalDreamUpdate(state, session);
        }
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
            updateStatus,
          });
        }
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
      availableMemorySessionCount: ordered.sessions.length,
      processedSessionCount: sessions.length,
      missingSessionIds: ordered.missingSessionIds,
      extraMemoryIds: ordered.extraMemoryIds,
      answerInDream: hasOptionalAnswer(renderedDream, dreamCase.answer),
      answerInSource: hasOptionalAnswer(sourceText, dreamCase.answer),
      finalState: state,
      steps,
      runnerFailureCount: runnerFailures - caseRunnerFailuresStart,
      runnerCallCount: runnerCalls - caseRunnerCallsStart,
      truncatedSessionCount,
    });

    if ((caseIndex + 1) % progressEvery === 0 || caseIndex === selectedCases.length - 1) {
      logProgress({
        completedCases: caseIndex + 1,
        totalCases: selectedCases.length,
        processedSessions,
        lastCaseId: dreamCase.id,
        lastMs: Date.now() - startedAt,
        runnerCalls,
        runnerFailures,
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
      caseCount: selectedCases.length,
      totalLoadedCases: cases.length,
      updater: updaterKind,
      backend: updaterKind === 'runner' ? backend : null,
      strictSeed,
      writeSteps,
      memoryLoadLimit,
      maxSessionsPerCase,
      batchContentExcerptChars,
      onlineContentExcerptChars,
      useQuestionHints,
      caseIdFilter: caseIdFilter ? Array.from(caseIdFilter) : null,
      note:
        updaterKind === 'runner'
          ? 'Runner dream pass writes local JSON only. Online mode updates prior compact state plus one episode; batch mode reconciles a chronological case slice in one runner call. Neither mode writes DB memories or embeddings. By default the dream worker is not shown the future evaluation query; MEMORY_DREAM_USE_QUERY_HINTS=true enables query-hinted diagnostic runs.'
          : 'Local dream run uses existing per-memory LLM extraction views and a deterministic online reducer. It does not write new DB memories or embeddings.',
    },
    summary: {
      cases: results.length,
      processedSessions,
      runnerCalls,
      runnerFailures,
      truncatedSessionCount: results.reduce((sum, result) => sum + result.truncatedSessionCount, 0),
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
