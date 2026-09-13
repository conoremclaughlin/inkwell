import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { BenchmarkCase } from './datasets';

const DEFAULT_LOCOMO_URL =
  'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json';

const turnSchema = z
  .object({
    speaker: z.string(),
    dia_id: z.string(),
    text: z.string(),
    img_url: z.union([z.string(), z.array(z.string())]).optional(),
    blip_caption: z.string().optional(),
    query: z.string().optional(),
  })
  .passthrough();

const questionSchema = z
  .object({
    question: z.string(),
    answer: z.union([z.string(), z.number()]).optional(),
    adversarial_answer: z.union([z.string(), z.number()]).optional(),
    evidence: z.array(z.string()).optional().default([]),
    category: z.number().int().min(1).max(5),
  })
  .passthrough();

const sampleSchema = z
  .object({
    sample_id: z.string(),
    conversation: z.record(z.unknown()),
    qa: z.array(questionSchema),
  })
  .passthrough();

const datasetSchema = z.array(sampleSchema);

export type LoCoMoQuestionCategory = 1 | 2 | 3 | 4 | 5;
export type LoCoMoRepresentation = 'turn' | 'session';

export const LOCOMO_CATEGORY_NAMES: Record<LoCoMoQuestionCategory, string> = {
  1: 'single-hop',
  2: 'temporal',
  3: 'multi-hop',
  4: 'open-domain',
  5: 'adversarial',
};

export interface LoCoMoTurn {
  diaId: string;
  rawDiaId: string;
  speaker: string;
  text: string;
  sessionNumber: number;
  sessionDateTime?: string;
  imageUrls: string[];
  imageCaption?: string;
  imageQuery?: string;
}

export interface LoCoMoSession {
  documentId: string;
  sessionNumber: number;
  dateTime?: string;
  turns: LoCoMoTurn[];
}

export interface LoCoMoQuestion {
  questionId: string;
  questionIndex: number;
  question: string;
  answer: string;
  adversarialAnswer?: string;
  category: LoCoMoQuestionCategory;
  categoryName: string;
  rawEvidenceIds: string[];
  evidenceIds: string[];
  unresolvedEvidenceIds: string[];
  malformedEvidence: string[];
  repairedEvidence: Array<{ raw: string; normalized: string[] }>;
}

export interface LoCoMoConversation {
  sampleId: string;
  speakerA?: string;
  speakerB?: string;
  sessions: LoCoMoSession[];
  questions: LoCoMoQuestion[];
}

export interface LoCoMoAudit {
  samples: number;
  sessions: number;
  turns: number;
  questions: number;
  questionsByCategory: Record<string, number>;
  questionsWithoutEvidence: number;
  questionsWithFullyResolvedEvidence: number;
  questionsWithPartiallyResolvedEvidence: number;
  questionsWithMalformedEvidence: number;
  rawEvidenceReferences: number;
  normalizedEvidenceReferences: number;
  repairedEvidenceFields: number;
  unresolvedEvidenceIds: number;
}

export interface LoCoMoCorpus {
  samples: LoCoMoConversation[];
  source: string;
  datasetSha256: string;
  audit: LoCoMoAudit;
}

export interface LoCoMoSourceDocument {
  documentId: string;
  sampleId: string;
  representation: LoCoMoRepresentation;
  sessionNumber: number;
  sessionDateTime?: string;
  diaId?: string;
  diaIds: string[];
  content: string;
}

interface LoadedSource {
  rawText: string;
  source: string;
}

function canonicalizeDiaId(raw: string): string | null {
  const match = /^D:?(\d+):0*(\d+)$/.exec(raw.trim());
  if (!match) return null;
  return `D${Number(match[1])}:${Number(match[2])}`;
}

/**
 * LoCoMo contains a few evidence fields with multiple IDs packed into one string,
 * a stray colon (`D:11:26`), or a leading-zero turn (`D30:05`). We preserve the
 * raw field and normalize only IDs that are unambiguous.
 */
export function normalizeLoCoMoEvidenceField(raw: string): string[] {
  const matches = [...raw.matchAll(/D:?(\d+):0*(\d+)/g)];
  return matches.map((match) => `D${Number(match[1])}:${Number(match[2])}`);
}

function readSpeaker(conversation: Record<string, unknown>, key: string): string | undefined {
  const value = conversation[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractSessions(sampleId: string, conversation: Record<string, unknown>): LoCoMoSession[] {
  const sessions: LoCoMoSession[] = [];
  const seenDiaIds = new Set<string>();

  for (const [key, value] of Object.entries(conversation)) {
    const match = /^session_(\d+)$/.exec(key);
    if (!match || !Array.isArray(value)) continue;

    const sessionNumber = Number(match[1]);
    const dateTimeValue = conversation[`session_${sessionNumber}_date_time`];
    const dateTime =
      typeof dateTimeValue === 'string' && dateTimeValue.trim() ? dateTimeValue.trim() : undefined;
    const turns = value.map((input, turnIndex) => {
      const parsed = turnSchema.parse(input);
      const diaId = canonicalizeDiaId(parsed.dia_id);
      if (!diaId) {
        throw new Error(
          `Invalid LoCoMo dia_id ${JSON.stringify(parsed.dia_id)} in ${sampleId}/${key} turn ${turnIndex + 1}`
        );
      }
      if (seenDiaIds.has(diaId)) {
        throw new Error(`Duplicate LoCoMo dia_id ${diaId} in ${sampleId}`);
      }
      seenDiaIds.add(diaId);

      return {
        diaId,
        rawDiaId: parsed.dia_id,
        speaker: parsed.speaker.trim(),
        text: parsed.text.trim(),
        sessionNumber,
        sessionDateTime: dateTime,
        imageUrls:
          typeof parsed.img_url === 'string'
            ? [parsed.img_url]
            : Array.isArray(parsed.img_url)
              ? parsed.img_url
              : [],
        imageCaption: parsed.blip_caption,
        imageQuery: parsed.query,
      } satisfies LoCoMoTurn;
    });

    sessions.push({
      documentId: `${sampleId}/session-${sessionNumber}`,
      sessionNumber,
      dateTime,
      turns,
    });
  }

  return sessions.sort((a, b) => a.sessionNumber - b.sessionNumber);
}

function extractQuestions(
  sampleId: string,
  rawQuestions: z.infer<typeof questionSchema>[],
  knownDiaIds: Set<string>
): LoCoMoQuestion[] {
  return rawQuestions.map((question, questionIndex) => {
    if (question.category !== 5 && question.answer === undefined) {
      throw new Error(`LoCoMo question ${sampleId}/qa-${questionIndex + 1} is missing its answer.`);
    }
    if (
      question.category === 5 &&
      question.answer === undefined &&
      question.adversarial_answer === undefined
    ) {
      throw new Error(
        `LoCoMo adversarial question ${sampleId}/qa-${questionIndex + 1} has neither answer field.`
      );
    }
    const rawEvidenceIds = [...question.evidence];
    const evidenceIds: string[] = [];
    const malformedEvidence: string[] = [];
    const repairedEvidence: Array<{ raw: string; normalized: string[] }> = [];

    for (const rawEvidence of rawEvidenceIds) {
      const normalized = normalizeLoCoMoEvidenceField(rawEvidence);
      if (normalized.length === 0) {
        malformedEvidence.push(rawEvidence);
        continue;
      }

      const canonicalRaw = canonicalizeDiaId(rawEvidence);
      if (
        normalized.length !== 1 ||
        canonicalRaw !== normalized[0] ||
        rawEvidence !== normalized[0]
      ) {
        repairedEvidence.push({ raw: rawEvidence, normalized });
      }

      for (const diaId of normalized) {
        if (!evidenceIds.includes(diaId)) evidenceIds.push(diaId);
      }
    }

    return {
      questionId: `${sampleId}/qa-${questionIndex + 1}`,
      questionIndex: questionIndex + 1,
      question: question.question.trim(),
      // Most public category-5 rows contain only `adversarial_answer`: the tempting
      // unsupported answer. Their gold behavior is abstention. Two rows also carry
      // an explicit contradictory `answer`, which we preserve instead.
      answer:
        question.answer !== undefined
          ? String(question.answer).trim()
          : 'Not mentioned in the conversation',
      adversarialAnswer:
        question.adversarial_answer !== undefined
          ? String(question.adversarial_answer).trim()
          : undefined,
      category: question.category as LoCoMoQuestionCategory,
      categoryName: LOCOMO_CATEGORY_NAMES[question.category as LoCoMoQuestionCategory],
      rawEvidenceIds,
      evidenceIds,
      unresolvedEvidenceIds: evidenceIds.filter((diaId) => !knownDiaIds.has(diaId)),
      malformedEvidence,
      repairedEvidence,
    };
  });
}

function buildAudit(samples: LoCoMoConversation[]): LoCoMoAudit {
  const questions = samples.flatMap((sample) => sample.questions);
  const questionsByCategory: Record<string, number> = {};
  for (const question of questions) {
    questionsByCategory[question.categoryName] =
      (questionsByCategory[question.categoryName] || 0) + 1;
  }

  return {
    samples: samples.length,
    sessions: samples.reduce((sum, sample) => sum + sample.sessions.length, 0),
    turns: samples.reduce(
      (sum, sample) =>
        sum + sample.sessions.reduce((sessionSum, session) => sessionSum + session.turns.length, 0),
      0
    ),
    questions: questions.length,
    questionsByCategory,
    questionsWithoutEvidence: questions.filter((question) => question.rawEvidenceIds.length === 0)
      .length,
    questionsWithFullyResolvedEvidence: questions.filter(
      (question) =>
        question.evidenceIds.length > 0 &&
        question.unresolvedEvidenceIds.length === 0 &&
        question.malformedEvidence.length === 0
    ).length,
    questionsWithPartiallyResolvedEvidence: questions.filter(
      (question) =>
        question.evidenceIds.length > 0 &&
        (question.unresolvedEvidenceIds.length > 0 || question.malformedEvidence.length > 0)
    ).length,
    questionsWithMalformedEvidence: questions.filter(
      (question) => question.malformedEvidence.length > 0
    ).length,
    rawEvidenceReferences: questions.reduce(
      (sum, question) => sum + question.rawEvidenceIds.length,
      0
    ),
    normalizedEvidenceReferences: questions.reduce(
      (sum, question) => sum + question.evidenceIds.length,
      0
    ),
    repairedEvidenceFields: questions.reduce(
      (sum, question) => sum + question.repairedEvidence.length,
      0
    ),
    unresolvedEvidenceIds: questions.reduce(
      (sum, question) => sum + question.unresolvedEvidenceIds.length,
      0
    ),
  };
}

async function loadSource(): Promise<LoadedSource> {
  const localPath = process.env.LOCOMO_DATASET_PATH;
  if (localPath) {
    return {
      rawText: await readFile(localPath, 'utf-8'),
      source: `file:${localPath}`,
    };
  }

  const url = process.env.LOCOMO_DATASET_URL || DEFAULT_LOCOMO_URL;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`LoCoMo download failed (${response.status}): ${await response.text()}`);
  }
  return { rawText: await response.text(), source: `url:${url}` };
}

export async function loadLoCoMoCorpus(): Promise<LoCoMoCorpus> {
  const loaded = await loadSource();
  const parsedJson: unknown = JSON.parse(loaded.rawText);
  const rawSamples = datasetSchema.parse(parsedJson);

  const samples = rawSamples.map((rawSample) => {
    const sessions = extractSessions(rawSample.sample_id, rawSample.conversation);
    const knownDiaIds = new Set(
      sessions.flatMap((session) => session.turns.map((turn) => turn.diaId))
    );

    return {
      sampleId: rawSample.sample_id,
      speakerA: readSpeaker(rawSample.conversation, 'speaker_a'),
      speakerB: readSpeaker(rawSample.conversation, 'speaker_b'),
      sessions,
      questions: extractQuestions(rawSample.sample_id, rawSample.qa, knownDiaIds),
    } satisfies LoCoMoConversation;
  });

  return {
    samples,
    source: loaded.source,
    datasetSha256: createHash('sha256').update(loaded.rawText).digest('hex'),
    audit: buildAudit(samples),
  };
}

function formatTurnContent(turn: LoCoMoTurn): string {
  const header = turn.sessionDateTime
    ? `Session ${turn.sessionNumber} @ ${turn.sessionDateTime}`
    : `Session ${turn.sessionNumber}`;
  const imageContext = turn.imageCaption ? `\nImage: ${turn.imageCaption}` : '';
  return `${header}\n${turn.speaker}: ${turn.text}${imageContext}`;
}

function formatSessionContent(session: LoCoMoSession): string {
  const header = session.dateTime
    ? `Session ${session.sessionNumber} @ ${session.dateTime}`
    : `Session ${session.sessionNumber}`;
  const lines = session.turns.map((turn) => {
    const imageContext = turn.imageCaption ? ` [Image: ${turn.imageCaption}]` : '';
    return `${turn.speaker}: ${turn.text}${imageContext}`;
  });
  return `${header}\n${lines.join('\n')}`;
}

/** Build one source document per raw turn or per chronological session. */
export function buildLoCoMoSourceDocuments(
  sample: LoCoMoConversation,
  representation: LoCoMoRepresentation
): LoCoMoSourceDocument[] {
  if (representation === 'turn') {
    return sample.sessions.flatMap((session) =>
      session.turns.map((turn) => ({
        documentId: `${sample.sampleId}/turn-${turn.diaId}`,
        sampleId: sample.sampleId,
        representation,
        sessionNumber: session.sessionNumber,
        sessionDateTime: session.dateTime,
        diaId: turn.diaId,
        diaIds: [turn.diaId],
        content: formatTurnContent(turn),
      }))
    );
  }

  return sample.sessions.map((session) => ({
    documentId: session.documentId,
    sampleId: sample.sampleId,
    representation,
    sessionNumber: session.sessionNumber,
    sessionDateTime: session.dateTime,
    diaIds: session.turns.map((turn) => turn.diaId),
    content: formatSessionContent(session),
  }));
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/**
 * Legacy adapter for the generic per-QA harness. It deliberately carries a
 * `legacy-qa-duplicated` source label because it duplicates a conversation for
 * every question and must not be used for publishable LoCoMo results.
 */
export async function loadLoCoMoDataset(): Promise<{
  cases: BenchmarkCase[];
  source: string;
}> {
  const corpus = await loadLoCoMoCorpus();
  const limit = parsePositiveInt(process.env.LOCOMO_LIMIT, corpus.audit.questions);
  const explicitDistractorLimit = process.env.LOCOMO_MAX_DISTRACTORS
    ? parsePositiveInt(process.env.LOCOMO_MAX_DISTRACTORS, Number.MAX_SAFE_INTEGER)
    : Number.MAX_SAFE_INTEGER;
  const cases: BenchmarkCase[] = [];

  for (const sample of corpus.samples) {
    const turnToSession = new Map(
      sample.sessions.flatMap((session) =>
        session.turns.map((turn) => [turn.diaId, session.sessionNumber] as const)
      )
    );

    for (const question of sample.questions) {
      if (cases.length >= limit) break;
      if (
        question.evidenceIds.length === 0 ||
        question.unresolvedEvidenceIds.length > 0 ||
        question.malformedEvidence.length > 0
      ) {
        continue;
      }

      const evidenceSessions = new Set(
        question.evidenceIds
          .map((diaId) => turnToSession.get(diaId))
          .filter((sessionNumber): sessionNumber is number => sessionNumber !== undefined)
      );
      const targets = sample.sessions
        .filter((session) => evidenceSessions.has(session.sessionNumber))
        .map(formatSessionContent);
      const distractors = sample.sessions
        .filter((session) => !evidenceSessions.has(session.sessionNumber))
        .map(formatSessionContent)
        .slice(0, explicitDistractorLimit);

      cases.push({
        id: question.questionId,
        query: question.question,
        targetContents: targets,
        distractors,
        provenance: `locomo:${sample.sampleId}:${question.categoryName}:legacy-qa-duplicated`,
      });
    }
  }

  if (cases.length === 0) {
    throw new Error('LoCoMo corpus loaded but produced 0 legacy benchmark cases.');
  }

  return {
    cases,
    source: `${corpus.source}#legacy-qa-duplicated`,
  };
}
