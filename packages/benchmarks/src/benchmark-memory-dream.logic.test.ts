import { describe, expect, it } from 'vitest';
import {
  applyLocalDreamUpdate,
  buildOnlineDreamPrompt,
  buildOrderedDreamSessions,
  createInitialDreamState,
  parseLongMemSessionId,
  renderDreamStateForAnswerCheck,
  textContainsAnswer,
  type DreamMemoryRow,
} from './benchmark-memory-dream.logic';
import type { LongMemEvalDreamCase } from './benchmark-data/longmemeval-loader';

describe('benchmark-memory-dream logic', () => {
  it('parses LongMemEval session ids from seeded memory content', () => {
    expect(parseLongMemSessionId('session abc-123\nuser: hello')).toBe('abc-123');
    expect(parseLongMemSessionId('not a session\nuser: hello')).toBeNull();
  });

  it('orders seeded memories by the dataset haystack order, not database order', () => {
    const dreamCase: LongMemEvalDreamCase = {
      id: 'case-1',
      query: 'What changed?',
      answerSessionIds: ['newer'],
      sessions: [
        {
          sessionId: 'older',
          content: 'session older\nuser: old',
          hasAnswer: false,
          isAnswerSession: false,
          turnCount: 1,
        },
        {
          sessionId: 'newer',
          content: 'session newer\nuser: new',
          hasAnswer: true,
          isAnswerSession: true,
          turnCount: 1,
        },
      ],
    };
    const rows: DreamMemoryRow[] = [
      {
        id: 'mem-new',
        content: 'session newer\nuser: new',
        summary: null,
        metadata: null,
        created_at: '2026-01-02T00:00:00Z',
      },
      {
        id: 'mem-old',
        content: 'session older\nuser: old',
        summary: null,
        metadata: null,
        created_at: '2026-01-01T00:00:00Z',
      },
    ];

    const ordered = buildOrderedDreamSessions(dreamCase, rows);

    expect(ordered.missingSessionIds).toEqual([]);
    expect(ordered.sessions.map((session) => session.memoryId)).toEqual(['mem-old', 'mem-new']);
  });

  it('integrates per-memory LLM views into a compact evidence-linked local dream state', () => {
    const state = createInitialDreamState('case-coin', 'online');
    const [session] = buildOrderedDreamSessions(
      {
        id: 'case-coin',
        query: 'How many pre-1920 coins do I have?',
        answer: '38',
        answerSessionIds: ['s1'],
        sessions: [
          {
            sessionId: 's1',
            content: 'session s1\nuser: I now have 38 pre-1920 coins.',
            hasAnswer: true,
            isAnswerSession: true,
            turnCount: 1,
          },
        ],
      },
      [
        {
          id: 'mem-s1',
          content: 'session s1\nuser: I now have 38 pre-1920 coins.',
          summary: 'benchmark target',
          created_at: '2026-01-01T00:00:00Z',
          metadata: {
            llm_extractions: {
              durable_fact: {
                durableFacts: [
                  {
                    fact: 'The user now has 38 pre-1920 coins.',
                    category: 'status',
                    subject: 'user',
                    object: 'pre-1920 coin count',
                    evidence: 'I now have 38 pre-1920 coins.',
                  },
                ],
              },
              summary: {
                summary: 'The user updated their pre-1920 coin count to 38.',
                keyPoints: ['38 pre-1920 coins'],
                actionRelevance: 'Useful for answering collection count questions.',
              },
            },
          },
        },
      ]
    ).sessions;

    const updated = applyLocalDreamUpdate(state, session);
    const rendered = renderDreamStateForAnswerCheck(updated);

    expect(updated.sessionCount).toBe(1);
    expect(updated.durableFacts).toHaveLength(1);
    expect(updated.durableFacts[0].evidenceMemoryIds).toEqual(['mem-s1']);
    expect(textContainsAnswer(rendered, '38')).toBe(true);
  });

  it('builds an online dream prompt that uses prior state plus one new episode', () => {
    const state = createInitialDreamState('case-1', 'online');
    const [session] = buildOrderedDreamSessions(
      {
        id: 'case-1',
        query: 'What process should I follow?',
        answerSessionIds: ['s1'],
        sessions: [
          {
            sessionId: 's1',
            content: 'session s1\nuser: Always request sibling review before merge.',
            hasAnswer: true,
            isAnswerSession: true,
            turnCount: 1,
          },
        ],
      },
      [
        {
          id: 'mem-s1',
          content: 'session s1\nuser: Always request sibling review before merge.',
          summary: null,
          metadata: null,
          created_at: '2026-01-01T00:00:00Z',
        },
      ]
    ).sessions;

    const prompt = buildOnlineDreamPrompt({
      caseId: 'case-1',
      question: 'What process should I follow?',
      previousState: state,
      nextSession: session,
    });

    expect(prompt.systemPrompt).toContain('one new chronological episode');
    expect(prompt.userPrompt).toContain('Previous compact dream state JSON');
    expect(prompt.userPrompt).toContain('session s1');
  });
});
