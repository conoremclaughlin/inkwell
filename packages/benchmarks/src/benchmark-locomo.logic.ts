import type {
  LoCoMoConversation,
  LoCoMoQuestion,
  LoCoMoRepresentation,
} from './benchmark-data/locomo-loader';

export interface LoCoMoRetrievedDocument {
  memoryId: string;
  documentId: string | null;
  semanticScore?: number;
  finalScore: number;
}

export interface LoCoMoQuestionRun {
  questionId: string;
  sampleId: string;
  question: string;
  answer: string;
  category: number;
  categoryName: string;
  evidenceIds: string[];
  unresolvedEvidenceIds: string[];
  malformedEvidence: string[];
  targetDocumentIds: string[];
  scorable: boolean;
  unscorableReason?: string;
  rank: number | null;
  retrieved: LoCoMoRetrievedDocument[];
  recallMs: number;
}

export interface LoCoMoMetricSummary {
  questions: number;
  scorableQuestions: number;
  unscorableQuestions: number;
  mrr: number;
  averageRecallMs: number;
  byK: Record<
    string,
    {
      hitAny: number;
      hitAll: number;
      evidenceCoverage: number;
    }
  >;
  byCategory: Record<
    string,
    {
      questions: number;
      scorableQuestions: number;
      mrr: number;
      byK: Record<
        string,
        {
          hitAny: number;
          hitAll: number;
          evidenceCoverage: number;
        }
      >;
    }
  >;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function getLoCoMoScorableReason(question: LoCoMoQuestion): string | null {
  if (question.evidenceIds.length === 0) return 'no-evidence-annotation';
  if (question.unresolvedEvidenceIds.length > 0) return 'unresolved-evidence-id';
  if (question.malformedEvidence.length > 0) return 'malformed-evidence-field';
  return null;
}

export function buildLoCoMoTargetDocumentIds(
  sample: LoCoMoConversation,
  question: LoCoMoQuestion,
  representation: LoCoMoRepresentation
): string[] {
  if (representation === 'turn') {
    return question.evidenceIds.map((diaId) => `${sample.sampleId}/turn-${diaId}`);
  }

  const sessionByDiaId = new Map(
    sample.sessions.flatMap((session) =>
      session.turns.map((turn) => [turn.diaId, session.documentId] as const)
    )
  );
  return [
    ...new Set(
      question.evidenceIds
        .map((diaId) => sessionByDiaId.get(diaId))
        .filter((documentId): documentId is string => documentId !== undefined)
    ),
  ];
}

function summarizeRuns(runs: LoCoMoQuestionRun[], topKs: number[]) {
  const scorable = runs.filter((run) => run.scorable);
  const byK: LoCoMoMetricSummary['byK'] = {};

  for (const topK of topKs) {
    const perRun = scorable.map((run) => {
      const retrievedIds = new Set(
        run.retrieved
          .slice(0, topK)
          .map((document) => document.documentId)
          .filter((documentId): documentId is string => documentId !== null)
      );
      const targets = new Set(run.targetDocumentIds);
      const hitCount = [...targets].filter((target) => retrievedIds.has(target)).length;
      return {
        hitAny: hitCount > 0 ? 1 : 0,
        hitAll: hitCount === targets.size ? 1 : 0,
        evidenceCoverage: targets.size > 0 ? hitCount / targets.size : 0,
      };
    });

    byK[String(topK)] = {
      hitAny: round(mean(perRun.map((entry) => entry.hitAny))),
      hitAll: round(mean(perRun.map((entry) => entry.hitAll))),
      evidenceCoverage: round(mean(perRun.map((entry) => entry.evidenceCoverage))),
    };
  }

  return {
    questions: runs.length,
    scorableQuestions: scorable.length,
    unscorableQuestions: runs.length - scorable.length,
    mrr: round(mean(scorable.map((run) => (run.rank ? 1 / run.rank : 0)))),
    averageRecallMs: round(mean(runs.map((run) => run.recallMs))),
    byK,
  };
}

export function calculateLoCoMoMetrics(
  runs: LoCoMoQuestionRun[],
  topKs: number[]
): LoCoMoMetricSummary {
  const overall = summarizeRuns(runs, topKs);
  const categoryNames = [...new Set(runs.map((run) => run.categoryName))];
  const byCategory: LoCoMoMetricSummary['byCategory'] = {};

  for (const categoryName of categoryNames) {
    const category = summarizeRuns(
      runs.filter((run) => run.categoryName === categoryName),
      topKs
    );
    byCategory[categoryName] = {
      questions: category.questions,
      scorableQuestions: category.scorableQuestions,
      mrr: category.mrr,
      byK: category.byK,
    };
  }

  return { ...overall, byCategory };
}
