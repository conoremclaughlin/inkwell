import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  createSupabaseClient,
  MemoryRepository,
  MEMORY_EMBEDDING_CHUNKS_VERSION,
} from '@inklabs/api/benchmarks';
import {
  buildLoCoMoSourceDocuments,
  loadLoCoMoCorpus,
  type LoCoMoConversation,
  type LoCoMoRepresentation,
  type LoCoMoSourceDocument,
} from './benchmark-data/locomo-loader';
import {
  parseLoCoMoPhase,
  parseLoCoMoRepresentation,
  parseLoCoMoSemanticIndex,
  parseLoCoMoTopKs,
  parseOptionalCsv,
  parseOptionalPositiveInt,
  parsePositiveInt,
  type ForcedSemanticIndex,
} from './benchmark-locomo.config';
import {
  buildLoCoMoTargetDocumentIds,
  calculateLoCoMoMetrics,
  getLoCoMoScorableReason,
  type LoCoMoQuestionRun,
} from './benchmark-locomo.logic';
import {
  createLoCoMoRunState,
  createLoCoMoSeedState,
  loadLoCoMoRunState,
  loadLoCoMoSeedState,
  writeJsonAtomic,
  writeLoCoMoRunState,
  writeLoCoMoSeedState,
  type LoCoMoSeedState,
} from './benchmark-locomo.state';

// Deliberately not an SB identity: this isolates persistent benchmark rows from normal
// identity-scoped recall while still using the repository's existing agent_id filter.
const BENCHMARK_AGENT_ID = '__benchmark_locomo__';
const BENCHMARK_TOPIC = 'benchmark:locomo';
const DEFAULT_PROGRESS_EVERY = 25;
const RETRY_ATTEMPTS = 3;

interface LoCoMoMemoryMetadata {
  family: 'locomo';
  seedId: string;
  datasetSha256: string;
  representation: LoCoMoRepresentation;
  sampleId: string;
  documentId: string;
  diaIds: string[];
  contentSha256: string;
}

interface SeedMemoryRow {
  id: string;
  content: string;
  metadata: unknown;
  embedding_chunks_version: number | null;
  embedding_chunk_count: number | null;
}

class RunLogger {
  constructor(private readonly path: string) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
  }

  async log(message: string, details?: Record<string, unknown>): Promise<void> {
    const suffix = details ? ` ${JSON.stringify(details)}` : '';
    const line = `${new Date().toISOString()} ${message}${suffix}`;
    console.log(line);
    await appendFile(this.path, `${line}\n`, 'utf-8');
  }
}

let activeLogger: RunLogger | null = null;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readLoCoMoMetadata(metadata: unknown): LoCoMoMemoryMetadata | null {
  if (!isRecord(metadata) || !isRecord(metadata.benchmark)) return null;
  const value = metadata.benchmark;
  if (
    value.family !== 'locomo' ||
    typeof value.seedId !== 'string' ||
    typeof value.datasetSha256 !== 'string' ||
    (value.representation !== 'turn' && value.representation !== 'session') ||
    typeof value.sampleId !== 'string' ||
    typeof value.documentId !== 'string' ||
    !Array.isArray(value.diaIds) ||
    !value.diaIds.every((diaId) => typeof diaId === 'string') ||
    typeof value.contentSha256 !== 'string'
  ) {
    return null;
  }
  return value as unknown as LoCoMoMemoryMetadata;
}

function readEmbeddingViewCounts(metadata: unknown): Record<string, number> | null {
  if (!isRecord(metadata) || !isRecord(metadata.embedding_chunks)) return null;
  const viewCounts = metadata.embedding_chunks.viewCounts;
  if (!isRecord(viewCounts)) return null;
  return Object.fromEntries(
    Object.entries(viewCounts).filter((entry): entry is [string, number] =>
      Number.isInteger(entry[1])
    )
  );
}

function assertRawContentOnly(row: SeedMemoryRow, documentId: string): void {
  const chunkCount = row.embedding_chunk_count || 0;
  const viewCounts = readEmbeddingViewCounts(row.metadata);
  if (!viewCounts) {
    throw new Error(`${documentId} is missing embedding view-count metadata.`);
  }
  const derivedCount = Object.entries(viewCounts)
    .filter(([chunkType]) => chunkType !== 'content')
    .reduce((sum, [, count]) => sum + count, 0);
  if (viewCounts.content !== chunkCount || derivedCount !== 0) {
    throw new Error(
      `${documentId} is not a raw-content-only seed: ` +
        `chunkCount=${chunkCount}, viewCounts=${JSON.stringify(viewCounts)}`
    );
  }
}

function isEmbeddingReady(row: SeedMemoryRow): boolean {
  return (
    row.embedding_chunks_version === MEMORY_EMBEDDING_CHUNKS_VERSION &&
    (row.embedding_chunk_count || 0) > 0
  );
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  return `${(milliseconds / 60_000).toFixed(1)}m`;
}

function progressDetails(completed: number, total: number, totalMs: number) {
  const averageMs = completed > 0 ? totalMs / completed : 0;
  return {
    completed,
    total,
    average: formatDuration(averageMs),
    eta: completed > 0 ? formatDuration((total - completed) * averageMs) : 'unknown',
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function withRetries<T>(
  label: string,
  logger: RunLogger,
  operation: () => Promise<T>
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_ATTEMPTS) break;
      await logger.log(`${label} failed; retrying`, {
        attempt,
        attempts: RETRY_ATTEMPTS,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(250 * attempt);
    }
  }
  throw lastError;
}

function selectSamples(
  samples: LoCoMoConversation[],
  requestedSampleIds: string[] | null
): LoCoMoConversation[] {
  if (!requestedSampleIds) return samples;
  const byId = new Map(samples.map((sample) => [sample.sampleId, sample]));
  const missing = requestedSampleIds.filter((sampleId) => !byId.has(sampleId));
  if (missing.length > 0) {
    throw new Error(`Unknown LOCOMO_SAMPLE_IDS: ${missing.join(', ')}`);
  }
  return requestedSampleIds.map((sampleId) => byId.get(sampleId)!);
}

function assertSeedCompatible(
  state: LoCoMoSeedState,
  expected: {
    seedId: string;
    datasetSha256: string;
    representation: LoCoMoRepresentation;
    embeddingConfigKey: string;
    userId: string;
  }
): void {
  for (const [key, value] of Object.entries(expected)) {
    if (state[key as keyof LoCoMoSeedState] !== value) {
      throw new Error(
        `Seed state mismatch for ${key}: found ${JSON.stringify(state[key as keyof LoCoMoSeedState])}, ` +
          `expected ${JSON.stringify(value)}.`
      );
    }
  }
}

function sampleTopic(seedId: string, sampleId: string): string {
  return `${BENCHMARK_TOPIC}:${seedId}:sample:${sampleId}`;
}

function documentTopic(seedId: string, documentId: string): string {
  return `${BENCHMARK_TOPIC}:${seedId}:document:${documentId}`;
}

async function loadSeedRows(
  supabase: ReturnType<typeof createSupabaseClient>,
  userId: string,
  seedTopic: string
): Promise<Map<string, SeedMemoryRow>> {
  const rows: SeedMemoryRow[] = [];
  const pageSize = 1_000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .from('memories')
      .select('id,content,metadata,embedding_chunks_version,embedding_chunk_count')
      .eq('user_id', userId)
      .eq('agent_id', BENCHMARK_AGENT_ID)
      .contains('topics', [seedTopic])
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`Failed to inspect LoCoMo seed rows: ${error.message}`);
    const page = (data || []) as SeedMemoryRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }

  const byDocumentId = new Map<string, SeedMemoryRow>();
  for (const row of rows) {
    const metadata = readLoCoMoMetadata(row.metadata);
    if (!metadata) {
      throw new Error(`Memory ${row.id} carries seed topic ${seedTopic} without valid metadata.`);
    }
    if (byDocumentId.has(metadata.documentId)) {
      throw new Error(
        `Duplicate source memories found for ${metadata.documentId} under ${seedTopic}. ` +
          'Refusing to produce benchmark results until the duplicate is resolved.'
      );
    }
    byDocumentId.set(metadata.documentId, row);
  }
  return byDocumentId;
}

async function loadSeedRowById(
  supabase: ReturnType<typeof createSupabaseClient>,
  memoryId: string
): Promise<SeedMemoryRow> {
  const { data, error } = await supabase
    .from('memories')
    .select('id,content,metadata,embedding_chunks_version,embedding_chunk_count')
    .eq('id', memoryId)
    .single();
  if (error || !data) {
    throw new Error(`Failed to verify seeded memory ${memoryId}: ${error?.message || 'not found'}`);
  }
  return data as SeedMemoryRow;
}

async function seedDocuments(params: {
  documents: LoCoMoSourceDocument[];
  state: LoCoMoSeedState;
  statePath: string;
  datasetSha256: string;
  userId: string;
  logger: RunLogger;
  progressEvery: number;
}): Promise<void> {
  const { documents, state, statePath, datasetSha256, userId, logger, progressEvery } = params;
  const supabase = createSupabaseClient();
  const repository = new MemoryRepository(supabase);
  const seedTopic = `${BENCHMARK_TOPIC}:${state.seedId}`;
  const databaseRows = await loadSeedRows(supabase, userId, seedTopic);
  let totalMs = 0;
  let completed = 0;

  await logger.log('seed progress', progressDetails(0, documents.length, 0));

  for (const document of documents) {
    const contentSha256 = sha256(document.content);
    let row = databaseRows.get(document.documentId);
    if (row) {
      const metadata = readLoCoMoMetadata(row.metadata);
      if (
        !metadata ||
        metadata.seedId !== state.seedId ||
        metadata.datasetSha256 !== datasetSha256 ||
        metadata.representation !== document.representation ||
        metadata.sampleId !== document.sampleId ||
        metadata.contentSha256 !== contentSha256 ||
        sha256(row.content) !== contentSha256
      ) {
        throw new Error(
          `Seed ID collision or source drift for ${document.documentId}. Use a new LOCOMO_SEED_ID.`
        );
      }

      if (!isEmbeddingReady(row)) {
        await logger.log('removing incomplete source memory before retry', {
          documentId: document.documentId,
          memoryId: row.id,
        });
        await repository.forget(row.id, userId);
        databaseRows.delete(document.documentId);
        delete state.documents[document.documentId];
        row = undefined;
      }
    }

    const startedAt = Date.now();
    if (!row) {
      const metadata: LoCoMoMemoryMetadata = {
        family: 'locomo',
        seedId: state.seedId,
        datasetSha256,
        representation: document.representation,
        sampleId: document.sampleId,
        documentId: document.documentId,
        diaIds: document.diaIds,
        contentSha256,
      };
      row = await withRetries(`seed ${document.documentId}`, logger, async () => {
        const memory = await repository.remember({
          userId,
          agentId: BENCHMARK_AGENT_ID,
          content: document.content,
          summary: `LoCoMo raw ${document.representation} ${document.documentId}`,
          source: 'benchmark:locomo',
          salience: 'low',
          topicKey: BENCHMARK_TOPIC,
          topics: [
            BENCHMARK_TOPIC,
            seedTopic,
            sampleTopic(state.seedId, document.sampleId),
            documentTopic(state.seedId, document.documentId),
          ],
          metadata: { benchmark: metadata },
        });
        const persisted = await loadSeedRowById(supabase, memory.id);
        if (!isEmbeddingReady(persisted)) {
          await repository.forget(memory.id, userId);
          throw new Error('content embedding did not persist');
        }
        return persisted;
      });
      databaseRows.set(document.documentId, row);
    }

    assertRawContentOnly(row, document.documentId);
    const seedMs = Date.now() - startedAt;
    totalMs += seedMs;
    completed += 1;
    state.documents[document.documentId] = {
      documentId: document.documentId,
      sampleId: document.sampleId,
      memoryId: row.id,
      topic: sampleTopic(state.seedId, document.sampleId),
      contentSha256,
      contentCharacters: document.content.length,
      embeddingReady: true,
      embeddingChunkCount: row.embedding_chunk_count || 0,
      seedMs,
    };
    await writeLoCoMoSeedState(statePath, state);

    if (completed % progressEvery === 0 || completed === documents.length) {
      await logger.log('seed progress', {
        ...progressDetails(completed, documents.length, totalMs),
        documentId: document.documentId,
        last: formatDuration(seedMs),
      });
    }
  }
}

async function recallQuestions(params: {
  samples: LoCoMoConversation[];
  seedState: LoCoMoSeedState;
  runId: string;
  seedStatePath: string;
  runStatePath: string;
  resultPath: string;
  datasetSha256: string;
  datasetSource: string;
  representation: LoCoMoRepresentation;
  semanticIndex: ForcedSemanticIndex;
  topKs: number[];
  questionLimit: number | null;
  userId: string;
  logger: RunLogger;
  progressEvery: number;
  corpusAudit: unknown;
}): Promise<void> {
  const {
    samples,
    seedState,
    runId,
    seedStatePath,
    runStatePath,
    resultPath,
    datasetSha256,
    datasetSource,
    representation,
    semanticIndex,
    topKs,
    questionLimit,
    userId,
    logger,
    progressEvery,
    corpusAudit,
  } = params;
  const allQuestions = samples.flatMap((sample) =>
    sample.questions.map((question) => ({ sample, question }))
  );
  const questions = questionLimit ? allQuestions.slice(0, questionLimit) : allQuestions;
  const sampleIds = samples.map((sample) => sample.sampleId);
  let runState = await loadLoCoMoRunState(runStatePath);
  if (runState) {
    const mismatches = [
      runState.runId !== runId && 'runId',
      runState.seedId !== seedState.seedId && 'seedId',
      runState.datasetSha256 !== datasetSha256 && 'datasetSha256',
      runState.representation !== representation && 'representation',
      runState.semanticIndex !== semanticIndex && 'semanticIndex',
      JSON.stringify(runState.topKs) !== JSON.stringify(topKs) && 'topKs',
      JSON.stringify(runState.sampleIds) !== JSON.stringify(sampleIds) && 'sampleIds',
      runState.questionLimit !== questionLimit && 'questionLimit',
      runState.userId !== userId && 'userId',
    ].filter(Boolean);
    if (mismatches.length > 0) {
      throw new Error(
        `Run state is incompatible with current configuration: ${mismatches.join(', ')}`
      );
    }
  } else {
    runState = createLoCoMoRunState({
      runId,
      seedId: seedState.seedId,
      datasetSha256,
      representation,
      semanticIndex,
      topKs,
      sampleIds,
      questionLimit,
      userId,
      agentId: BENCHMARK_AGENT_ID,
    });
    await writeLoCoMoRunState(runStatePath, runState);
  }

  const repository = new MemoryRepository(createSupabaseClient());
  const maxK = Math.max(...topKs);
  let totalMs = Object.values(runState.completedQuestions).reduce(
    (sum, result) => sum + result.recallMs,
    0
  );
  let completed = Object.keys(runState.completedQuestions).length;
  await logger.log('recall progress', progressDetails(completed, questions.length, totalMs));

  for (const { sample, question } of questions) {
    if (runState.completedQuestions[question.questionId]) continue;
    const targetDocumentIds = buildLoCoMoTargetDocumentIds(sample, question, representation);
    for (const targetDocumentId of targetDocumentIds) {
      if (!seedState.documents[targetDocumentId]?.embeddingReady) {
        throw new Error(`Question ${question.questionId} targets unseeded ${targetDocumentId}.`);
      }
    }

    const unscorableReason = getLoCoMoScorableReason(question);
    const startedAt = Date.now();
    const candidates = await withRetries(`recall ${question.questionId}`, logger, () =>
      repository.recallWithScores(userId, question.question, {
        recallMode: 'semantic',
        semanticIndex,
        semanticChunkTypes: ['content'],
        applyChunkTypeBoosts: false,
        agentId: BENCHMARK_AGENT_ID,
        includeShared: false,
        topics: [sampleTopic(seedState.seedId, sample.sampleId)],
        limit: maxK,
      })
    );
    const recallMs = Date.now() - startedAt;
    const retrieved = candidates.map((candidate) => {
      const metadata = readLoCoMoMetadata(candidate.memory.metadata);
      if (!metadata) {
        throw new Error(`Recalled memory ${candidate.memory.id} lacks LoCoMo source metadata.`);
      }
      return {
        memoryId: candidate.memory.id,
        documentId: metadata.documentId,
        semanticScore: candidate.semanticScore,
        finalScore: candidate.finalScore,
      };
    });
    const targets = new Set(targetDocumentIds);
    const firstRelevantIndex = retrieved.findIndex(
      (document) => document.documentId && targets.has(document.documentId)
    );
    const result: LoCoMoQuestionRun = {
      questionId: question.questionId,
      sampleId: sample.sampleId,
      question: question.question,
      answer: question.answer,
      category: question.category,
      categoryName: question.categoryName,
      evidenceIds: question.evidenceIds,
      unresolvedEvidenceIds: question.unresolvedEvidenceIds,
      malformedEvidence: question.malformedEvidence,
      targetDocumentIds,
      scorable: !unscorableReason,
      ...(unscorableReason ? { unscorableReason } : {}),
      firstRelevantRank: firstRelevantIndex >= 0 ? firstRelevantIndex + 1 : null,
      retrieved,
      recallMs,
    };
    runState.completedQuestions[question.questionId] = result;
    await writeLoCoMoRunState(runStatePath, runState);
    totalMs += recallMs;
    completed += 1;

    if (completed % progressEvery === 0 || completed === questions.length) {
      await logger.log('recall progress', {
        ...progressDetails(completed, questions.length, totalMs),
        questionId: question.questionId,
        last: formatDuration(recallMs),
      });
    }
  }

  const orderedRuns = questions.map(
    ({ question }) => runState!.completedQuestions[question.questionId]
  );
  const metrics = calculateLoCoMoMetrics(orderedRuns, topKs);
  await writeJsonAtomic(resultPath, {
    version: 1,
    runId,
    seedId: seedState.seedId,
    datasetSource,
    datasetSha256,
    representation,
    retrieval: {
      mode: 'semantic',
      semanticIndex,
      semanticIndexSemantics:
        semanticIndex === 'memory-chunks'
          ? 'best matching persisted content chunk per source memory'
          : 'memories.embedding; this is the first content chunk when a source exceeds the model limit',
      semanticChunkTypes: ['content'],
      topKs,
      queryScope: 'one LoCoMo conversation/sample',
    },
    selection: {
      sampleIds,
      questionLimit,
      questions: questions.length,
      sourceDocuments: Object.values(seedState.documents).filter((document) =>
        sampleIds.includes(document.sampleId)
      ).length,
    },
    embedding: {
      configKey: seedState.embeddingConfigKey,
      chunksVersion: MEMORY_EMBEDDING_CHUNKS_VERSION,
      rawContentOnly: true,
    },
    corpusAudit,
    metrics,
    runs: orderedRuns,
    paths: { seedStatePath, runStatePath, resultPath },
    completedAt: new Date().toISOString(),
  });
  await logger.log('recall complete', {
    resultPath,
    questions: metrics.questions,
    scorableQuestions: metrics.scorableQuestions,
    mrrAtMaxK: metrics.mrrAtMaxK,
    maxK: metrics.maxK,
    hitAnyAtMaxK: metrics.byK[String(metrics.maxK)]?.hitAny,
  });
}

async function main(): Promise<void> {
  const phase = parseLoCoMoPhase(process.env.LOCOMO_PHASE);
  const representation = parseLoCoMoRepresentation(process.env.LOCOMO_REPRESENTATION);
  const semanticIndex = parseLoCoMoSemanticIndex(process.env.LOCOMO_SEMANTIC_INDEX);
  const userId = process.env.BENCHMARK_USER_ID?.trim();
  if (!userId) throw new Error('BENCHMARK_USER_ID is required.');
  if (process.env.MEMORY_EMBEDDINGS_ENABLED !== 'true') {
    throw new Error('MEMORY_EMBEDDINGS_ENABLED=true is required for a LoCoMo semantic run.');
  }

  const corpus = await loadLoCoMoCorpus();
  const samples = selectSamples(corpus.samples, parseOptionalCsv(process.env.LOCOMO_SAMPLE_IDS));
  const documents = samples.flatMap((sample) => buildLoCoMoSourceDocuments(sample, representation));
  const topKs = parseLoCoMoTopKs(process.env.LOCOMO_TOP_KS);
  const questionLimit = parseOptionalPositiveInt(process.env.LOCOMO_QUESTION_LIMIT);
  const progressEvery = parsePositiveInt(process.env.LOCOMO_PROGRESS_EVERY, DEFAULT_PROGRESS_EVERY);
  const provider = process.env.MEMORY_EMBEDDING_PROVIDER || 'ollama';
  const model = process.env.MEMORY_EMBEDDING_MODEL || 'mxbai-embed-large';
  const dimensions = process.env.MEMORY_EMBEDDING_DIMENSIONS || '1024';
  const embeddingConfigKey = slugify(
    `raw-content-only-chunks-v${MEMORY_EMBEDDING_CHUNKS_VERSION}-${provider}-${model}-${dimensions}`
  );
  const defaultSeedId = slugify(
    `locomo10-${corpus.datasetSha256.slice(0, 12)}-${representation}-${embeddingConfigKey}`
  );
  const seedId = process.env.LOCOMO_SEED_ID?.trim() || defaultSeedId;
  const runId =
    process.env.LOCOMO_RUN_ID?.trim() ||
    `locomo-${representation}-${semanticIndex}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const outputDirectory = resolve(process.cwd(), 'output', 'locomo');
  const seedStatePath =
    process.env.LOCOMO_SEED_STATE_PATH || resolve(outputDirectory, `${seedId}.seed.json`);
  const runStatePath =
    process.env.LOCOMO_RUN_STATE_PATH || resolve(outputDirectory, `${runId}.state.json`);
  const resultPath =
    process.env.LOCOMO_RESULT_PATH || resolve(outputDirectory, `${runId}.result.json`);
  const logPath = process.env.LOCOMO_LOG_PATH || resolve(outputDirectory, `${runId}.${phase}.log`);
  const logger = new RunLogger(logPath);
  activeLogger = logger;
  await logger.initialize();
  await logger.log('LoCoMo benchmark starting', {
    phase,
    representation,
    semanticIndex,
    seedId,
    runId,
    datasetSource: corpus.source,
    datasetSha256: corpus.datasetSha256,
    samples: samples.length,
    sourceDocuments: documents.length,
    questionsAvailable: samples.reduce((sum, sample) => sum + sample.questions.length, 0),
    questionLimit,
    topKs,
    seedStatePath,
    runStatePath,
    resultPath,
    logPath,
  });

  let seedState = await loadLoCoMoSeedState(seedStatePath);
  if (seedState) {
    assertSeedCompatible(seedState, {
      seedId,
      datasetSha256: corpus.datasetSha256,
      representation,
      embeddingConfigKey,
      userId,
    });
  } else {
    if (phase === 'recall') {
      throw new Error(`Recall phase requires an existing seed state at ${seedStatePath}.`);
    }
    seedState = createLoCoMoSeedState({
      seedId,
      datasetSource: corpus.source,
      datasetSha256: corpus.datasetSha256,
      representation,
      embeddingConfigKey,
      userId,
      agentId: BENCHMARK_AGENT_ID,
    });
    await writeLoCoMoSeedState(seedStatePath, seedState);
  }

  if (phase === 'seed' || phase === 'all') {
    await seedDocuments({
      documents,
      state: seedState,
      statePath: seedStatePath,
      datasetSha256: corpus.datasetSha256,
      userId,
      logger,
      progressEvery,
    });
    await logger.log('seed complete', {
      seedStatePath,
      selectedDocuments: documents.length,
      stateDocuments: Object.keys(seedState.documents).length,
      contentCharacters: documents.reduce((sum, document) => sum + document.content.length, 0),
      embeddingChunks: documents.reduce(
        (sum, document) =>
          sum + (seedState!.documents[document.documentId]?.embeddingChunkCount || 0),
        0
      ),
    });
  }

  if (phase === 'recall' || phase === 'all') {
    await recallQuestions({
      samples,
      seedState,
      runId,
      seedStatePath,
      runStatePath,
      resultPath,
      datasetSha256: corpus.datasetSha256,
      datasetSource: corpus.source,
      representation,
      semanticIndex,
      topKs,
      questionLimit,
      userId,
      logger,
      progressEvery,
      corpusAudit: corpus.audit,
    });
  }
}

main().catch(async (error) => {
  if (activeLogger) {
    try {
      await activeLogger.log('LoCoMo benchmark failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // Preserve the original failure even if the log file itself became unavailable.
    }
  }
  console.error('[locomo-benchmark] failed:', error);
  process.exitCode = 1;
});
