import { describe, it, expect } from 'vitest';
import { scoreScenario, type SurfacedMemory } from './scorer.js';
import type { Scenario } from './types.js';

function makeScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: 'test',
    shape: 'convention-recall',
    capability: ['recall'],
    context: 'ctx',
    impliedQuestion: 'q',
    expectedSurfaced: [
      {
        kind: 'memory',
        ref: 'uuid-1',
        reason: 'the main memory',
      },
    ],
    rubric: {},
    ...overrides,
  };
}

describe('scorer: basic precision/recall', () => {
  it('1.0 precision and recall when the surfaced memory matches by id', () => {
    const scenario = makeScenario();
    const surfaced: SurfacedMemory[] = [{ id: 'uuid-1', content: 'hello', summary: null }];
    const r = scoreScenario(scenario, 'signal', surfaced);
    expect(r.metrics.precision).toBe(1);
    expect(r.metrics.recall).toBe(1);
    expect(r.passed).toBe(true);
  });

  it('0 precision when no matches but items surfaced', () => {
    const scenario = makeScenario({
      rubric: { precisionFloor: 0.5 },
    });
    const surfaced: SurfacedMemory[] = [
      { id: 'other-1', content: 'hello', summary: null },
      { id: 'other-2', content: 'world', summary: null },
    ];
    const r = scoreScenario(scenario, 'signal', surfaced);
    expect(r.metrics.precision).toBe(0);
    expect(r.metrics.recall).toBe(0);
    expect(r.passed).toBe(false);
    expect(r.failureReasons[0]).toMatch(/precision/);
  });

  it('0 precision & recall for empty surfaced set', () => {
    const scenario = makeScenario();
    const r = scoreScenario(scenario, 'signal', []);
    expect(r.metrics.precision).toBe(0);
    expect(r.metrics.recall).toBe(0);
    expect(r.surfacedCount).toBe(0);
  });
});

describe('scorer: doc_section via containsPhrases', () => {
  it('matches when all phrases appear in surfaced content', () => {
    const scenario = makeScenario({
      expectedSurfaced: [
        {
          kind: 'doc_section',
          ref: 'CONTRIBUTING.md#x',
          reason: 'rule',
          containsPhrases: ['never squash', 'merge commit'],
        },
      ],
    });
    const surfaced: SurfacedMemory[] = [
      {
        id: 'm1',
        content: 'We use a merge commit strategy and NEVER squash individual commits.',
        summary: null,
      },
    ];
    const r = scoreScenario(scenario, '', surfaced);
    expect(r.metrics.recall).toBe(1);
    expect(r.metrics.precision).toBe(1);
  });

  it('does not match when only some phrases appear', () => {
    const scenario = makeScenario({
      expectedSurfaced: [
        {
          kind: 'doc_section',
          ref: 'x',
          reason: 'rule',
          containsPhrases: ['never squash', 'merge commit'],
        },
      ],
    });
    const surfaced: SurfacedMemory[] = [
      { id: 'm1', content: 'We prefer merge commits.', summary: null },
    ];
    const r = scoreScenario(scenario, '', surfaced);
    expect(r.metrics.recall).toBe(0);
  });
});

describe('scorer: must-assert and must-not-assert', () => {
  it('passes when all claims are derivable', () => {
    const scenario = makeScenario({
      expectedSurfaced: [{ kind: 'memory', ref: 'uuid-1', reason: 'x' }],
      mustAssert: [
        { claim: 'uses merge commits', criticality: 'high', containsPhrases: ['merge commits'] },
      ],
      rubric: { mustAssertPassRate: 1.0 },
    });
    const surfaced: SurfacedMemory[] = [
      { id: 'uuid-1', content: 'We use merge commits everywhere.', summary: null },
    ];
    const r = scoreScenario(scenario, '', surfaced);
    expect(r.metrics.mustAssertPassRate).toBe(1);
    expect(r.passed).toBe(true);
  });

  it('fails when high-criticality claim is missed', () => {
    const scenario = makeScenario({
      mustAssert: [
        { claim: 'uses merge commits', criticality: 'high', containsPhrases: ['merge commits'] },
      ],
      rubric: { mustAssertPassRate: 1.0 },
    });
    const surfaced: SurfacedMemory[] = [
      { id: 'uuid-1', content: 'We squash everything.', summary: null },
    ];
    const r = scoreScenario(scenario, '', surfaced);
    expect(r.metrics.mustAssertPassRate).toBe(0);
    expect(r.passed).toBe(false);
    expect(r.failureReasons.some((f) => /high-criticality/.test(f))).toBe(true);
  });

  it('high-criticality miss is a hard fail even when aggregate pass rate is above threshold', () => {
    const scenario = makeScenario({
      expectedSurfaced: [{ kind: 'memory', ref: 'uuid-1', reason: 'x' }],
      mustAssert: [
        { claim: 'uses merge commits', criticality: 'high', containsPhrases: ['merge commits'] },
        { claim: 'docs say so', criticality: 'low', containsPhrases: ['docs'] },
      ],
      rubric: { mustAssertPassRate: 0.5 },
    });
    const surfaced: SurfacedMemory[] = [
      { id: 'uuid-1', content: 'The docs mention our process.', summary: null },
    ];
    const r = scoreScenario(scenario, '', surfaced);
    // Aggregate pass rate is 0.5 (1/2) which meets the threshold...
    expect(r.metrics.mustAssertPassRate).toBe(0.5);
    // ...but the high-crit miss should still cause a hard fail
    expect(r.passed).toBe(false);
    expect(r.failureReasons.some((f) => /high-criticality/.test(f))).toBe(true);
  });

  it('claimDerivable requires ALL containsPhrases (AND, not OR)', () => {
    const scenario = makeScenario({
      expectedSurfaced: [{ kind: 'memory', ref: 'uuid-1', reason: 'x' }],
      mustAssert: [
        {
          claim: 'full PR process',
          criticality: 'high',
          containsPhrases: ['never push directly', 'feature branch', 'always use a pr'],
        },
      ],
      rubric: { mustAssertPassRate: 1.0 },
    });
    const surfaced: SurfacedMemory[] = [
      { id: 'uuid-1', content: 'We use a feature branch for all work.', summary: null },
    ];
    const r = scoreScenario(scenario, '', surfaced);
    // Only 1 of 3 phrases present — should NOT pass
    expect(r.metrics.mustAssertPassRate).toBe(0);
    expect(r.passed).toBe(false);
  });

  it('flags must-not-assert leaks', () => {
    const scenario = makeScenario({
      mustNotAssert: [{ claim: 'squash is fine', containsPhrases: ['squash is fine'] }],
      rubric: { mustNotAssertLeakRate: 0 },
    });
    const surfaced: SurfacedMemory[] = [
      { id: 'uuid-1', content: 'We said squash is fine in this project.', summary: null },
    ];
    const r = scoreScenario(scenario, '', surfaced);
    expect(r.metrics.mustNotAssertLeakRate).toBe(1);
    expect(r.passed).toBe(false);
  });
});
