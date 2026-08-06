import { describe, expect, it } from 'vitest';
import type { LoCoMoConversation, LoCoMoQuestion } from './benchmark-data/locomo-loader';
import {
  buildLoCoMoTargetDocumentIds,
  calculateLoCoMoMetrics,
  getLoCoMoScorableReason,
  type LoCoMoQuestionRun,
} from './benchmark-locomo.logic';

const question: LoCoMoQuestion = {
  questionId: 'conv-1/qa-1',
  questionIndex: 1,
  question: 'What changed?',
  answer: 'A and B',
  category: 3,
  categoryName: 'multi-hop',
  rawEvidenceIds: ['D1:1', 'D2:2'],
  evidenceIds: ['D1:1', 'D2:2'],
  unresolvedEvidenceIds: [],
  malformedEvidence: [],
  repairedEvidence: [],
};

const sample: LoCoMoConversation = {
  sampleId: 'conv-1',
  sessions: [
    {
      documentId: 'conv-1/session-1',
      sessionNumber: 1,
      turns: [
        {
          diaId: 'D1:1',
          rawDiaId: 'D1:1',
          speaker: 'A',
          text: 'One',
          sessionNumber: 1,
          imageUrls: [],
        },
      ],
    },
    {
      documentId: 'conv-1/session-2',
      sessionNumber: 2,
      turns: [
        {
          diaId: 'D2:2',
          rawDiaId: 'D2:2',
          speaker: 'B',
          text: 'Two',
          sessionNumber: 2,
          imageUrls: [],
        },
      ],
    },
  ],
  questions: [question],
};

describe('LoCoMo benchmark logic', () => {
  it('maps evidence turns to the selected source-document representation', () => {
    expect(buildLoCoMoTargetDocumentIds(sample, question, 'turn')).toEqual([
      'conv-1/turn-D1:1',
      'conv-1/turn-D2:2',
    ]);
    expect(buildLoCoMoTargetDocumentIds(sample, question, 'session')).toEqual([
      'conv-1/session-1',
      'conv-1/session-2',
    ]);
  });

  it('marks missing and malformed evidence as unscorable instead of silently dropping it', () => {
    expect(getLoCoMoScorableReason(question)).toBeNull();
    expect(getLoCoMoScorableReason({ ...question, evidenceIds: [] })).toBe(
      'no-evidence-annotation'
    );
    expect(getLoCoMoScorableReason({ ...question, unresolvedEvidenceIds: ['D9:9'] })).toBe(
      'unresolved-evidence-id'
    );
  });

  it('reports any-hit, all-hit, coverage, and MRR separately', () => {
    const runs: LoCoMoQuestionRun[] = [
      {
        questionId: 'q1',
        sampleId: 'conv-1',
        question: 'q1',
        answer: 'a1',
        category: 3,
        categoryName: 'multi-hop',
        evidenceIds: ['D1:1', 'D2:2'],
        unresolvedEvidenceIds: [],
        malformedEvidence: [],
        targetDocumentIds: ['doc-a', 'doc-b'],
        scorable: true,
        rank: 2,
        retrieved: [
          { memoryId: 'm0', documentId: 'noise', finalScore: 0.9 },
          { memoryId: 'm1', documentId: 'doc-a', finalScore: 0.8 },
          { memoryId: 'm2', documentId: 'doc-b', finalScore: 0.7 },
        ],
        recallMs: 100,
      },
      {
        questionId: 'q2',
        sampleId: 'conv-1',
        question: 'q2',
        answer: 'a2',
        category: 3,
        categoryName: 'multi-hop',
        evidenceIds: [],
        unresolvedEvidenceIds: [],
        malformedEvidence: [],
        targetDocumentIds: [],
        scorable: false,
        unscorableReason: 'no-evidence-annotation',
        rank: null,
        retrieved: [],
        recallMs: 200,
      },
    ];

    const metrics = calculateLoCoMoMetrics(runs, [1, 2, 3]);

    expect(metrics).toMatchObject({
      questions: 2,
      scorableQuestions: 1,
      unscorableQuestions: 1,
      mrr: 0.5,
      averageRecallMs: 150,
    });
    expect(metrics.byK['1']).toEqual({ hitAny: 0, hitAll: 0, evidenceCoverage: 0 });
    expect(metrics.byK['2']).toEqual({ hitAny: 1, hitAll: 0, evidenceCoverage: 0.5 });
    expect(metrics.byK['3']).toEqual({ hitAny: 1, hitAll: 1, evidenceCoverage: 1 });
  });
});
