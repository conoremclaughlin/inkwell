import { describe, it, expect } from 'vitest';
import { runScenario, runAllScenarios, type RecallFn } from './runner.js';
import type { Scenario } from './types.js';

const mergeScenario: Scenario = {
  id: 'merge-strategy-rule',
  shape: 'convention-recall',
  capability: ['recall'],
  context: "I'm ready to merge PR #350. Should I squash, rebase, or merge?",
  impliedQuestion: 'What is our merge strategy?',
  expectedSurfaced: [
    {
      kind: 'doc_section',
      ref: 'CONTRIBUTING.md#git',
      reason: 'the rule',
      containsPhrases: ['merge commit', 'never squash'],
    },
  ],
  mustAssert: [
    {
      claim: 'We use merge commits, not squash',
      criticality: 'high',
      containsPhrases: ['merge commit'],
    },
  ],
  rubric: {
    precisionFloor: 0.5,
    recallFloor: 1.0,
    mustAssertPassRate: 1.0,
  },
};

describe('runner: simple convention-recall', () => {
  it('passes when the stubbed recall returns matching content', async () => {
    const recall: RecallFn = async () => [
      {
        id: 'mem-1',
        content: 'NEVER squash merge. Use a merge commit to preserve individual commits.',
        summary: 'Merge strategy rule',
      },
    ];
    const r = await runScenario(mergeScenario, recall);
    expect(r.passed).toBe(true);
    expect(r.metrics.recall).toBe(1);
    expect(r.metrics.mustAssertPassRate).toBe(1);
    expect(r.topicSignal.length).toBeGreaterThan(0);
  });

  it('fails when recall returns nothing relevant', async () => {
    const recall: RecallFn = async () => [
      { id: 'unrelated', content: 'Completely different topic.', summary: null },
    ];
    const r = await runScenario(mergeScenario, recall);
    expect(r.passed).toBe(false);
    expect(r.metrics.recall).toBe(0);
  });

  it('captures errors from recall without throwing', async () => {
    const recall: RecallFn = async () => {
      throw new Error('PCP unavailable');
    };
    const r = await runScenario(mergeScenario, recall);
    expect(r.passed).toBe(false);
    expect(r.failureReasons[0]).toMatch(/PCP unavailable/);
  });
});

describe('runner: unsupported shapes', () => {
  it('reports unsupported for eviction shape with clear reason', async () => {
    const scenario: Scenario = {
      ...mergeScenario,
      id: 'pivot-test',
      shape: 'topic-shift',
    };
    const r = await runScenario(scenario, async () => []);
    expect(r.passed).toBe(false);
    expect(r.failureReasons[0]).toMatch(/not yet implemented/);
  });
});

describe('runner: queryMode', () => {
  it('uses llmQueryFn when queryMode is "llm"', async () => {
    let capturedQuery = '';
    const recall: RecallFn = async (query) => {
      capturedQuery = query;
      return [
        {
          id: 'mem-1',
          content: 'NEVER squash merge. Use a merge commit to preserve individual commits.',
          summary: 'Merge strategy rule',
        },
      ];
    };
    const llmQueryFn = async () => 'What is the team merge strategy for pull requests?';
    const r = await runScenario(mergeScenario, recall, { queryMode: 'llm', llmQueryFn });
    expect(capturedQuery).toBe('What is the team merge strategy for pull requests?');
    expect(r.topicSignal).toBe('What is the team merge strategy for pull requests?');
    expect(r.passed).toBe(true);
  });

  it('falls back to keyword extraction by default', async () => {
    let capturedQuery = '';
    const recall: RecallFn = async (query) => {
      capturedQuery = query;
      return [];
    };
    await runScenario(mergeScenario, recall);
    expect(capturedQuery).not.toContain('What is');
    expect(capturedQuery.length).toBeGreaterThan(0);
  });

  it('reports error when llm mode used without llmQueryFn', async () => {
    const recall: RecallFn = async () => [];
    const r = await runScenario(mergeScenario, recall, { queryMode: 'llm' });
    expect(r.passed).toBe(false);
    expect(r.failureReasons[0]).toMatch(/requires llmQueryFn/);
  });
});

describe('runner: runAllScenarios', () => {
  it('returns one result per scenario', async () => {
    const recall: RecallFn = async () => [];
    const results = await runAllScenarios(
      [mergeScenario, { ...mergeScenario, id: 'second' }],
      recall
    );
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.scenarioId)).toEqual(['merge-strategy-rule', 'second']);
  });
});
