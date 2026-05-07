import { createSupabaseClient } from '../data/supabase/client';
import type { Database } from '../data/supabase/types';
import {
  buildDurableFactEmbeddingTexts,
  buildEntityEmbeddingTexts,
  buildSummaryEmbeddingTexts,
  normalizeMemoryExtractions,
  type MemoryExtractions,
} from '../services/memory-llm-extraction';
import { env } from '../config/env';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

type MemoryRow = Pick<
  Database['public']['Tables']['memories']['Row'],
  'id' | 'content' | 'summary' | 'topic_key' | 'topics' | 'metadata'
>;

type CaseRole = 'target' | 'distractor' | 'unknown';

interface SeedCase {
  caseId: string;
  topic: string;
  targetMemoryIds: string[];
  distractorMemoryIds: string[];
}

interface SeedFile {
  seedId: string;
  seededCases: Record<string, SeedCase>;
}

interface LongMemCase {
  question_id: string;
  question_type: string;
  question: string;
  answer: string | number;
  answer_session_ids: string[];
}

interface RoleInfo {
  caseId: string;
  role: CaseRole;
}

interface AuditedMemory {
  row: MemoryRow;
  extraction: MemoryExtractions | null;
  role: RoleInfo;
}

interface CaseCoverage {
  caseId: string;
  questionType: string;
  question: string;
  answer: string;
  targetMemoryIds: string[];
  targetContentHasAnswer: boolean;
  targetExtractionInputHasAnswer: boolean;
  targetOverInputLimit: boolean;
  entityHasAnswer: boolean;
  durableFactHasAnswer: boolean;
  summaryHasAnswer: boolean;
  derivedHasAnswer: boolean;
  maxDerivedAnswerTokenCoverage: number;
  sourceSnippet: string;
  derivedSnippet: string;
}

interface AuditSummary {
  generatedAt: string;
  topic: string;
  seedId: string | null;
  totalMemories: number;
  roleCounts: Record<CaseRole, number>;
  completeExtractionCount: number;
  missingExtractionCount: number;
  normalizedPresence: {
    entity: number;
    durableFact: number;
    summary: number;
    rawEntity: number;
    rawDurableFact: number;
    rawSummary: number;
  };
  extractionCounts: {
    entityItems: number;
    durableFactItems: number;
    summaryKeyPoints: number;
    emptyEntityMemories: number;
    emptyDurableFactMemories: number;
  };
  rawOverflowCounts: {
    entity: number;
    durableFact: number;
    summaryKeyPoints: number;
  };
  labelLeakCounts: {
    benchmarkTerms: number;
    targetDistractorTerms: number;
  };
  contentLimit: {
    maxInputChars: number;
    overLimitMemories: number;
    overLimitTargets: number;
  };
  entityTypeCounts: Record<string, number>;
  durableFactCategoryCounts: Record<string, number>;
  answerCoverage: {
    cases: number;
    targetContentHasAnswer: number;
    targetExtractionInputHasAnswer: number;
    entityHasAnswer: number;
    durableFactHasAnswer: number;
    summaryHasAnswer: number;
    derivedHasAnswer: number;
    derivedMissWhenTargetContentHasAnswer: number;
    derivedMissWhenTargetExtractionInputHasAnswer: number;
  };
}

function parsePositiveInt(raw: string | undefined, defaultValue: number): number {
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultValue;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeText(text: string | number): string {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ANSWER_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'his',
  'i',
  'in',
  'is',
  'it',
  'my',
  'of',
  'on',
  'or',
  'our',
  'she',
  'that',
  'the',
  'their',
  'they',
  'to',
  'was',
  'were',
  'with',
  'you',
]);

function answerTokenCoverage(text: string, answer: string | number): number {
  const normalizedText = normalizeText(text);
  const normalizedAnswer = normalizeText(answer);
  if (!normalizedAnswer) return 0;
  if (normalizedText.includes(normalizedAnswer)) return 1;
  const tokens = normalizedAnswer
    .split(' ')
    .filter((token) => token.length >= 3 || /^\d+$/.test(token))
    .filter((token) => !ANSWER_STOPWORDS.has(token));
  if (tokens.length === 0) return 0;
  const hitCount = tokens.filter((token) => normalizedText.includes(token)).length;
  return hitCount / tokens.length;
}

function hasAnswer(text: string, answer: string | number): boolean {
  const coverage = answerTokenCoverage(text, answer);
  if (coverage >= 0.8) return true;
  const normalizedAnswer = normalizeText(answer);
  return normalizedAnswer.length >= 4 && normalizeText(text).includes(normalizedAnswer);
}

function compact(text: string, maxChars = 500): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function snippetAroundAnswer(text: string, answer: string | number, maxChars = 700): string {
  const normalizedAnswer = normalizeText(answer);
  const normalizedText = normalizeText(text);
  const index = normalizedAnswer ? normalizedText.indexOf(normalizedAnswer) : -1;
  if (index < 0) return compact(text, maxChars);

  // Indexes after normalization are approximate; use a proportional source slice.
  const ratio = index / Math.max(normalizedText.length, 1);
  const sourceIndex = Math.floor(text.length * ratio);
  const start = Math.max(0, sourceIndex - Math.floor(maxChars / 2));
  return compact(text.slice(start, start + maxChars), maxChars);
}

function extractionText(
  extraction: MemoryExtractions | null,
  kind?: 'entity' | 'durable' | 'summary'
) {
  if (!extraction) return '';
  const parts: string[] = [];
  if ((!kind || kind === 'entity') && extraction.entity) {
    parts.push(buildEntityEmbeddingTexts(extraction.entity).join('\n'));
  }
  if ((!kind || kind === 'durable') && extraction.durable_fact) {
    parts.push(buildDurableFactEmbeddingTexts(extraction.durable_fact).join('\n'));
  }
  if ((!kind || kind === 'summary') && extraction.summary) {
    parts.push(buildSummaryEmbeddingTexts(extraction.summary).join('\n'));
  }
  return parts.join('\n');
}

function rawArrayLength(raw: unknown, key: 'entities' | 'durableFacts' | 'keyPoints'): number {
  const value = asRecord(raw)[key];
  return Array.isArray(value) ? value.length : 0;
}

async function loadJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function loadAllMemories(params: {
  userId: string;
  topic: string;
  pageSize: number;
}): Promise<MemoryRow[]> {
  const supabase = createSupabaseClient();
  const rows: MemoryRow[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('memories')
      .select('id,content,summary,topic_key,topics,metadata')
      .eq('user_id', params.userId)
      .contains('topics', [params.topic])
      .order('created_at', { ascending: true })
      .range(offset, offset + params.pageSize - 1);

    if (error) throw new Error(`Failed to load memories: ${error.message}`);
    const page = (data || []) as MemoryRow[];
    rows.push(...page);
    if (page.length < params.pageSize) break;
    offset += params.pageSize;
  }

  return rows;
}

function buildRoleMap(seed: SeedFile | null): Map<string, RoleInfo> {
  const roleByMemoryId = new Map<string, RoleInfo>();
  if (!seed) return roleByMemoryId;

  for (const [caseId, seededCase] of Object.entries(seed.seededCases)) {
    for (const memoryId of seededCase.targetMemoryIds || []) {
      roleByMemoryId.set(memoryId, { caseId, role: 'target' });
    }
    for (const memoryId of seededCase.distractorMemoryIds || []) {
      roleByMemoryId.set(memoryId, { caseId, role: 'distractor' });
    }
  }

  return roleByMemoryId;
}

function increment(counter: Record<string, number>, key: string) {
  counter[key] = (counter[key] || 0) + 1;
}

function auditCaseCoverage(params: {
  seed: SeedFile;
  dataset: LongMemCase[];
  memoryById: Map<string, AuditedMemory>;
}): CaseCoverage[] {
  const datasetById = new Map(params.dataset.map((item) => [item.question_id, item]));
  const cases: CaseCoverage[] = [];

  for (const [caseId, seededCase] of Object.entries(params.seed.seededCases)) {
    const benchmarkCase = datasetById.get(caseId);
    if (!benchmarkCase) continue;
    const targetMemories = seededCase.targetMemoryIds
      .map((memoryId) => params.memoryById.get(memoryId))
      .filter((item): item is AuditedMemory => Boolean(item));
    const targetContent = targetMemories.map((item) => item.row.content).join('\n\n');
    const targetExtractionInput = targetMemories
      .map((item) =>
        [item.row.summary || '', item.row.content.slice(0, env.MEMORY_LLM_MAX_INPUT_CHARS)].join(
          '\n'
        )
      )
      .join('\n\n');
    const targetOverInputLimit = targetMemories.some(
      (item) => item.row.content.length > env.MEMORY_LLM_MAX_INPUT_CHARS
    );
    const entityText = targetMemories
      .map((item) => extractionText(item.extraction, 'entity'))
      .join('\n');
    const durableText = targetMemories
      .map((item) => extractionText(item.extraction, 'durable'))
      .join('\n');
    const summaryText = targetMemories
      .map((item) => extractionText(item.extraction, 'summary'))
      .join('\n');
    const derivedText = [entityText, durableText, summaryText].join('\n');

    cases.push({
      caseId,
      questionType: benchmarkCase.question_type,
      question: benchmarkCase.question,
      answer: String(benchmarkCase.answer),
      targetMemoryIds: seededCase.targetMemoryIds,
      targetContentHasAnswer: hasAnswer(targetContent, benchmarkCase.answer),
      targetExtractionInputHasAnswer: hasAnswer(targetExtractionInput, benchmarkCase.answer),
      targetOverInputLimit,
      entityHasAnswer: hasAnswer(entityText, benchmarkCase.answer),
      durableFactHasAnswer: hasAnswer(durableText, benchmarkCase.answer),
      summaryHasAnswer: hasAnswer(summaryText, benchmarkCase.answer),
      derivedHasAnswer: hasAnswer(derivedText, benchmarkCase.answer),
      maxDerivedAnswerTokenCoverage: answerTokenCoverage(derivedText, benchmarkCase.answer),
      sourceSnippet: snippetAroundAnswer(targetContent, benchmarkCase.answer),
      derivedSnippet: compact(derivedText, 900),
    });
  }

  return cases;
}

function summarizeAudits(params: {
  topic: string;
  seed: SeedFile | null;
  audited: AuditedMemory[];
  caseCoverage: CaseCoverage[];
}): AuditSummary {
  const roleCounts: Record<CaseRole, number> = { target: 0, distractor: 0, unknown: 0 };
  const entityTypeCounts: Record<string, number> = {};
  const durableFactCategoryCounts: Record<string, number> = {};
  const normalizedPresence = {
    entity: 0,
    durableFact: 0,
    summary: 0,
    rawEntity: 0,
    rawDurableFact: 0,
    rawSummary: 0,
  };
  const extractionCounts = {
    entityItems: 0,
    durableFactItems: 0,
    summaryKeyPoints: 0,
    emptyEntityMemories: 0,
    emptyDurableFactMemories: 0,
  };
  const rawOverflowCounts = { entity: 0, durableFact: 0, summaryKeyPoints: 0 };
  const labelLeakCounts = { benchmarkTerms: 0, targetDistractorTerms: 0 };
  const contentLimit = {
    maxInputChars: env.MEMORY_LLM_MAX_INPUT_CHARS,
    overLimitMemories: 0,
    overLimitTargets: 0,
  };

  let completeExtractionCount = 0;
  let missingExtractionCount = 0;

  for (const item of params.audited) {
    roleCounts[item.role.role] += 1;
    if (item.row.content.length > env.MEMORY_LLM_MAX_INPUT_CHARS) {
      contentLimit.overLimitMemories += 1;
      if (item.role.role === 'target') contentLimit.overLimitTargets += 1;
    }

    const extraction = item.extraction;
    if (!extraction) {
      missingExtractionCount += 1;
      continue;
    }
    const hasAllKinds = Boolean(extraction.entity && extraction.durable_fact && extraction.summary);
    if (
      hasAllKinds &&
      extraction.raw?.entity &&
      extraction.raw?.durable_fact &&
      extraction.raw?.summary
    ) {
      completeExtractionCount += 1;
    }

    if (extraction.entity) {
      normalizedPresence.entity += 1;
      extractionCounts.entityItems += extraction.entity.entities.length;
      if (extraction.entity.entities.length === 0) extractionCounts.emptyEntityMemories += 1;
      for (const entity of extraction.entity.entities)
        increment(entityTypeCounts, entity.entityType);
    }
    if (extraction.durable_fact) {
      normalizedPresence.durableFact += 1;
      extractionCounts.durableFactItems += extraction.durable_fact.durableFacts.length;
      if (extraction.durable_fact.durableFacts.length === 0) {
        extractionCounts.emptyDurableFactMemories += 1;
      }
      for (const fact of extraction.durable_fact.durableFacts) {
        increment(durableFactCategoryCounts, fact.category);
      }
    }
    if (extraction.summary) {
      normalizedPresence.summary += 1;
      extractionCounts.summaryKeyPoints += extraction.summary.keyPoints.length;
    }

    if (extraction.raw?.entity) {
      normalizedPresence.rawEntity += 1;
      if (
        rawArrayLength(extraction.raw.entity, 'entities') >
        (extraction.entity?.entities.length || 0)
      ) {
        rawOverflowCounts.entity += 1;
      }
    }
    if (extraction.raw?.durable_fact) {
      normalizedPresence.rawDurableFact += 1;
      if (
        rawArrayLength(extraction.raw.durable_fact, 'durableFacts') >
        (extraction.durable_fact?.durableFacts.length || 0)
      ) {
        rawOverflowCounts.durableFact += 1;
      }
    }
    if (extraction.raw?.summary) {
      normalizedPresence.rawSummary += 1;
      if (
        rawArrayLength(extraction.raw.summary, 'keyPoints') >
        (extraction.summary?.keyPoints.length || 0)
      ) {
        rawOverflowCounts.summaryKeyPoints += 1;
      }
    }

    const text = normalizeText(extractionText(extraction));
    if (text.includes('benchmark')) labelLeakCounts.benchmarkTerms += 1;
    if (
      /\b(benchmark target|benchmark distractor|target memory|distractor memory|target source|distractor source|target session|distractor session|target case|distractor case)\b/.test(
        text
      )
    ) {
      labelLeakCounts.targetDistractorTerms += 1;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    topic: params.topic,
    seedId: params.seed?.seedId || null,
    totalMemories: params.audited.length,
    roleCounts,
    completeExtractionCount,
    missingExtractionCount,
    normalizedPresence,
    extractionCounts,
    rawOverflowCounts,
    labelLeakCounts,
    contentLimit,
    entityTypeCounts,
    durableFactCategoryCounts,
    answerCoverage: {
      cases: params.caseCoverage.length,
      targetContentHasAnswer: params.caseCoverage.filter((item) => item.targetContentHasAnswer)
        .length,
      targetExtractionInputHasAnswer: params.caseCoverage.filter(
        (item) => item.targetExtractionInputHasAnswer
      ).length,
      entityHasAnswer: params.caseCoverage.filter((item) => item.entityHasAnswer).length,
      durableFactHasAnswer: params.caseCoverage.filter((item) => item.durableFactHasAnswer).length,
      summaryHasAnswer: params.caseCoverage.filter((item) => item.summaryHasAnswer).length,
      derivedHasAnswer: params.caseCoverage.filter((item) => item.derivedHasAnswer).length,
      derivedMissWhenTargetContentHasAnswer: params.caseCoverage.filter(
        (item) => item.targetContentHasAnswer && !item.derivedHasAnswer
      ).length,
      derivedMissWhenTargetExtractionInputHasAnswer: params.caseCoverage.filter(
        (item) => item.targetExtractionInputHasAnswer && !item.derivedHasAnswer
      ).length,
    },
  };
}

function buildMarkdownReport(params: {
  summary: AuditSummary;
  misses: CaseCoverage[];
  lowCoverage: CaseCoverage[];
  samples: CaseCoverage[];
}): string {
  const lines: string[] = [];
  const pct = (count: number, total: number) =>
    total === 0 ? '0.0%' : `${((count / total) * 100).toFixed(1)}%`;

  lines.push(`# Memory LLM Extraction Audit`);
  lines.push('');
  lines.push(`Generated: ${params.summary.generatedAt}`);
  lines.push(`Topic: \`${params.summary.topic}\``);
  if (params.summary.seedId) lines.push(`Seed: \`${params.summary.seedId}\``);
  lines.push('');
  lines.push('## Aggregate integrity');
  lines.push('');
  lines.push(`- Memories: ${params.summary.totalMemories}`);
  lines.push(
    `- Roles: target=${params.summary.roleCounts.target}, distractor=${params.summary.roleCounts.distractor}, unknown=${params.summary.roleCounts.unknown}`
  );
  lines.push(
    `- Complete normalized+raw extraction rows: ${params.summary.completeExtractionCount}`
  );
  lines.push(`- Missing extraction rows: ${params.summary.missingExtractionCount}`);
  lines.push(
    `- Content over LLM input cap (${params.summary.contentLimit.maxInputChars} chars): ${params.summary.contentLimit.overLimitMemories} memories, including ${params.summary.contentLimit.overLimitTargets} targets`
  );
  lines.push(
    `- Label leakage: benchmark terms in ${params.summary.labelLeakCounts.benchmarkTerms}, target/distractor terms in ${params.summary.labelLeakCounts.targetDistractorTerms}`
  );
  lines.push(
    `- Raw overflow preserved: entity=${params.summary.rawOverflowCounts.entity}, durable_fact=${params.summary.rawOverflowCounts.durableFact}, summary_key_points=${params.summary.rawOverflowCounts.summaryKeyPoints}`
  );
  lines.push('');
  lines.push('## Target-answer coverage heuristic');
  lines.push('');
  lines.push(
    `- Target source text contains answer: ${params.summary.answerCoverage.targetContentHasAnswer}/${params.summary.answerCoverage.cases} (${pct(params.summary.answerCoverage.targetContentHasAnswer, params.summary.answerCoverage.cases)})`
  );
  lines.push(
    `- Extraction-visible target input contains answer: ${params.summary.answerCoverage.targetExtractionInputHasAnswer}/${params.summary.answerCoverage.cases} (${pct(params.summary.answerCoverage.targetExtractionInputHasAnswer, params.summary.answerCoverage.cases)})`
  );
  lines.push(
    `- Entity view contains answer: ${params.summary.answerCoverage.entityHasAnswer}/${params.summary.answerCoverage.cases} (${pct(params.summary.answerCoverage.entityHasAnswer, params.summary.answerCoverage.cases)})`
  );
  lines.push(
    `- Durable-fact view contains answer: ${params.summary.answerCoverage.durableFactHasAnswer}/${params.summary.answerCoverage.cases} (${pct(params.summary.answerCoverage.durableFactHasAnswer, params.summary.answerCoverage.cases)})`
  );
  lines.push(
    `- Summary view contains answer: ${params.summary.answerCoverage.summaryHasAnswer}/${params.summary.answerCoverage.cases} (${pct(params.summary.answerCoverage.summaryHasAnswer, params.summary.answerCoverage.cases)})`
  );
  lines.push(
    `- Any derived view contains answer: ${params.summary.answerCoverage.derivedHasAnswer}/${params.summary.answerCoverage.cases} (${pct(params.summary.answerCoverage.derivedHasAnswer, params.summary.answerCoverage.cases)})`
  );
  lines.push(
    `- Derived miss when target content has answer: ${params.summary.answerCoverage.derivedMissWhenTargetContentHasAnswer}`
  );
  lines.push(
    `- Derived miss when extraction-visible target input has answer: ${params.summary.answerCoverage.derivedMissWhenTargetExtractionInputHasAnswer}`
  );
  lines.push('');
  lines.push('## Entity types');
  lines.push('');
  for (const [type, count] of Object.entries(params.summary.entityTypeCounts).sort(
    (a, b) => b[1] - a[1]
  )) {
    lines.push(`- ${type}: ${count}`);
  }
  lines.push('');
  lines.push('## Durable fact categories');
  lines.push('');
  for (const [type, count] of Object.entries(params.summary.durableFactCategoryCounts).sort(
    (a, b) => b[1] - a[1]
  )) {
    lines.push(`- ${type}: ${count}`);
  }
  lines.push('');
  lines.push('## Cases where target text had answer but derived views missed it');
  lines.push('');
  for (const item of params.misses) {
    lines.push(`### ${item.caseId} — ${item.questionType}`);
    lines.push(`- Q: ${item.question}`);
    lines.push(`- A: ${item.answer}`);
    lines.push(`- Extraction-visible input has answer: ${item.targetExtractionInputHasAnswer}`);
    lines.push(`- Target over input cap: ${item.targetOverInputLimit}`);
    lines.push(`- Derived answer token coverage: ${item.maxDerivedAnswerTokenCoverage.toFixed(2)}`);
    lines.push(`- Source: ${item.sourceSnippet}`);
    lines.push(`- Derived: ${item.derivedSnippet}`);
    lines.push('');
  }
  lines.push('## Low derived answer-coverage samples');
  lines.push('');
  for (const item of params.lowCoverage) {
    lines.push(`### ${item.caseId} — ${item.questionType}`);
    lines.push(`- Q: ${item.question}`);
    lines.push(`- A: ${item.answer}`);
    lines.push(`- Source has answer: ${item.targetContentHasAnswer}`);
    lines.push(`- Extraction-visible input has answer: ${item.targetExtractionInputHasAnswer}`);
    lines.push(`- Target over input cap: ${item.targetOverInputLimit}`);
    lines.push(
      `- Entity/fact/summary hit: ${item.entityHasAnswer}/${item.durableFactHasAnswer}/${item.summaryHasAnswer}`
    );
    lines.push(`- Derived answer token coverage: ${item.maxDerivedAnswerTokenCoverage.toFixed(2)}`);
    lines.push(`- Source: ${item.sourceSnippet}`);
    lines.push(`- Derived: ${item.derivedSnippet}`);
    lines.push('');
  }
  lines.push('## Representative target samples');
  lines.push('');
  for (const item of params.samples) {
    lines.push(`### ${item.caseId} — ${item.questionType}`);
    lines.push(`- Q: ${item.question}`);
    lines.push(`- A: ${item.answer}`);
    lines.push(`- Target source has answer: ${item.targetContentHasAnswer}`);
    lines.push(`- Extraction-visible input has answer: ${item.targetExtractionInputHasAnswer}`);
    lines.push(`- Target over input cap: ${item.targetOverInputLimit}`);
    lines.push(
      `- Entity/fact/summary hit: ${item.entityHasAnswer}/${item.durableFactHasAnswer}/${item.summaryHasAnswer}`
    );
    lines.push(`- Source: ${item.sourceSnippet}`);
    lines.push(`- Derived: ${item.derivedSnippet}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function main() {
  const userId = process.env.MEMORY_LLM_AUDIT_USER_ID || process.env.BENCHMARK_USER_ID;
  if (!userId) throw new Error('MEMORY_LLM_AUDIT_USER_ID or BENCHMARK_USER_ID is required');

  const topic = process.env.MEMORY_LLM_AUDIT_TOPIC;
  if (!topic) throw new Error('MEMORY_LLM_AUDIT_TOPIC is required');

  const pageSize = Math.min(parsePositiveInt(process.env.MEMORY_LLM_AUDIT_PAGE_SIZE, 1000), 1000);
  const sampleLimit = parsePositiveInt(process.env.MEMORY_LLM_AUDIT_SAMPLE_LIMIT, 12);
  const outputPath =
    process.env.MEMORY_LLM_AUDIT_OUTPUT_PATH ||
    resolve(
      process.cwd(),
      'output',
      'memory-extraction-audits',
      `memory-llm-audit-${Date.now()}.json`
    );
  const markdownPath =
    process.env.MEMORY_LLM_AUDIT_MARKDOWN_PATH || outputPath.replace(/\.json$/i, '.md');
  const seedPath = process.env.MEMORY_LLM_AUDIT_SEED_PATH;
  const datasetPath = process.env.MEMORY_LLM_AUDIT_DATASET_PATH;

  const [seed, dataset, rows] = await Promise.all([
    seedPath ? loadJsonFile<SeedFile>(seedPath) : Promise.resolve(null),
    datasetPath ? loadJsonFile<LongMemCase[]>(datasetPath) : Promise.resolve([]),
    loadAllMemories({ userId, topic, pageSize }),
  ]);

  const roleMap = buildRoleMap(seed);
  const audited = rows.map((row): AuditedMemory => {
    const metadata = asRecord(row.metadata);
    const extraction = normalizeMemoryExtractions(metadata.llm_extractions);
    return {
      row,
      extraction,
      role: roleMap.get(row.id) || { caseId: 'unknown', role: 'unknown' },
    };
  });
  const memoryById = new Map(audited.map((item) => [item.row.id, item]));
  const caseCoverage = seed
    ? auditCaseCoverage({
        seed,
        dataset,
        memoryById,
      })
    : [];
  const summary = summarizeAudits({ topic, seed, audited, caseCoverage });
  const misses = caseCoverage
    .filter((item) => item.targetContentHasAnswer && !item.derivedHasAnswer)
    .sort((a, b) => a.maxDerivedAnswerTokenCoverage - b.maxDerivedAnswerTokenCoverage)
    .slice(0, sampleLimit);
  const lowCoverage = caseCoverage
    .filter((item) => !item.derivedHasAnswer)
    .sort((a, b) => a.maxDerivedAnswerTokenCoverage - b.maxDerivedAnswerTokenCoverage)
    .slice(0, sampleLimit);
  const samples = caseCoverage.filter((item) => item.derivedHasAnswer).slice(0, sampleLimit);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        summary,
        misses,
        lowCoverage,
        samples,
        caseCoverage,
      },
      null,
      2
    )}\n`
  );
  await writeFile(markdownPath, buildMarkdownReport({ summary, misses, lowCoverage, samples }));

  console.log(`[memory-llm-audit] output=${outputPath}`);
  console.log(`[memory-llm-audit] markdown=${markdownPath}`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
