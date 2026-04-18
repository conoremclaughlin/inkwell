/**
 * Scoring for real-scenario memory eval runs.
 *
 * v1 uses substring/phrase matching for must-assert / must-not-assert checks.
 * This is deterministic and cheap. v2 can swap in an LLM judge behind the
 * same interface without changing scenario files.
 */

import type { Scenario, ScenarioResult, ExpectedItem, AssertClaim } from './types.js';

export interface SurfacedMemory {
  id: string;
  content: string;
  summary: string | null;
}

/** Normalize content for matching: lowercase + collapse whitespace */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Does the combined surfaced content support this expected item? */
function matchExpectedItem(item: ExpectedItem, surfaced: SurfacedMemory[]): string | undefined {
  // 1. Direct ID match (memories, tasks, artifacts with UUIDs)
  const byId = surfaced.find((m) => m.id === item.ref);
  if (byId) return byId.id;

  // 2. Content phrase match (doc_section items, fallback for others)
  if (item.containsPhrases && item.containsPhrases.length > 0) {
    const blob = normalize(surfaced.map((m) => `${m.content} ${m.summary ?? ''}`).join(' '));
    const hasAll = item.containsPhrases.every((p) => blob.includes(normalize(p)));
    if (hasAll) {
      // Return the ID of the memory with the longest matching content — a
      // reasonable stand-in when we can't tell which specific memory satisfied
      // the phrase set.
      return surfaced.slice().sort((a, b) => b.content.length - a.content.length)[0]?.id;
    }
  }

  return undefined;
}

/** v1 claim check: at least one phrase variant appears in surfaced content */
function claimDerivable(claim: AssertClaim, surfaced: SurfacedMemory[]): boolean {
  const blob = normalize(surfaced.map((m) => `${m.content} ${m.summary ?? ''}`).join(' '));
  const phrases =
    claim.containsPhrases && claim.containsPhrases.length > 0
      ? claim.containsPhrases
      : [claim.claim];
  return phrases.some((p) => blob.includes(normalize(p)));
}

export function scoreScenario(
  scenario: Scenario,
  topicSignal: string,
  surfaced: SurfacedMemory[]
): ScenarioResult {
  // Match surfaced → expected items
  const surfacedWithMatches = surfaced.map((m) => {
    const match = scenario.expectedSurfaced.find(
      (exp) => matchExpectedItem(exp, [m]) !== undefined
    );
    return {
      id: m.id,
      contentPreview: (m.summary ?? m.content).slice(0, 120),
      matchedExpectedRef: match?.ref,
    };
  });

  const matchedRefs = new Set(
    surfacedWithMatches.map((s) => s.matchedExpectedRef).filter((r): r is string => Boolean(r))
  );
  const expectedRefs = new Set(scenario.expectedSurfaced.map((e) => e.ref));

  const truePositives = matchedRefs.size;
  const surfacedCount = surfaced.length;
  const expectedCount = expectedRefs.size;

  const precision = surfacedCount === 0 ? 0 : truePositives / surfacedCount;
  const recall = expectedCount === 0 ? 0 : truePositives / expectedCount;

  // Must-assert claims
  let mustAssertVerdicts: ScenarioResult['mustAssertVerdicts'];
  let mustAssertPassRate: number | undefined;
  if (scenario.mustAssert && scenario.mustAssert.length > 0) {
    mustAssertVerdicts = scenario.mustAssert.map((c) => ({
      claim: c.claim,
      criticality: c.criticality ?? 'medium',
      passed: claimDerivable(c, surfaced),
    }));
    const passed = mustAssertVerdicts.filter((v) => v.passed).length;
    mustAssertPassRate = passed / mustAssertVerdicts.length;
  }

  // Must-not-assert leaks — in v1, a leak is: a forbidden claim's phrases
  // appear in the surfaced content, which suggests the SB would have
  // parroted it. This is imperfect but it's a deterministic starting point.
  let mustNotAssertVerdicts: ScenarioResult['mustNotAssertVerdicts'];
  let mustNotAssertLeakRate: number | undefined;
  if (scenario.mustNotAssert && scenario.mustNotAssert.length > 0) {
    mustNotAssertVerdicts = scenario.mustNotAssert.map((c) => ({
      claim: c.claim,
      leaked: claimDerivable(c, surfaced),
    }));
    const leaks = mustNotAssertVerdicts.filter((v) => v.leaked).length;
    mustNotAssertLeakRate = leaks / mustNotAssertVerdicts.length;
  }

  // Pass/fail against rubric
  const failureReasons: string[] = [];
  const rubric = scenario.rubric;

  if (rubric.precisionFloor !== undefined && precision < rubric.precisionFloor) {
    failureReasons.push(`precision ${precision.toFixed(2)} < floor ${rubric.precisionFloor}`);
  }
  if (rubric.recallFloor !== undefined && recall < rubric.recallFloor) {
    failureReasons.push(`recall ${recall.toFixed(2)} < floor ${rubric.recallFloor}`);
  }
  if (
    rubric.mustAssertPassRate !== undefined &&
    mustAssertPassRate !== undefined &&
    mustAssertPassRate < rubric.mustAssertPassRate
  ) {
    // Additionally, any failed HIGH-criticality claim is a hard fail
    const highFailed = (mustAssertVerdicts ?? []).filter(
      (v) => v.criticality === 'high' && !v.passed
    );
    failureReasons.push(
      `must-assert pass rate ${mustAssertPassRate.toFixed(2)} < ${rubric.mustAssertPassRate}` +
        (highFailed.length > 0 ? ` (${highFailed.length} high-criticality claim(s) missed)` : '')
    );
  }
  if (
    rubric.mustNotAssertLeakRate !== undefined &&
    mustNotAssertLeakRate !== undefined &&
    mustNotAssertLeakRate > rubric.mustNotAssertLeakRate
  ) {
    failureReasons.push(
      `must-not-assert leak rate ${mustNotAssertLeakRate.toFixed(2)} > ceiling ${rubric.mustNotAssertLeakRate}`
    );
  }

  return {
    scenarioId: scenario.id,
    shape: scenario.shape,
    topicSignal,
    surfacedCount,
    surfaced: surfacedWithMatches,
    metrics: {
      precision,
      recall,
      mustAssertPassRate,
      mustNotAssertLeakRate,
    },
    mustAssertVerdicts,
    mustNotAssertVerdicts,
    passed: failureReasons.length === 0,
    failureReasons,
  };
}
