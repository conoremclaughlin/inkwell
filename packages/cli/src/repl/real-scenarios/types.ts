/**
 * Real-Scenario Memory Eval — scenario schema types.
 *
 * Each scenario file captures: what context the SB is in, what they're implicitly
 * asking, what should be surfaced, and what claims must be derivable from the
 * surfaced set (even when the full source isn't in context).
 *
 * See `ink://specs/memory-real-scenario-eval` for the spec.
 */

export type ScenarioShape =
  | 'person-centric-recall'
  | 'state-of-affairs'
  | 'why-we-care'
  | 'objective-grounding'
  | 'convention-recall'
  | 'current-state-correction'
  | 'anti-hallucination-challenge'
  | 'post-compaction-continuity'
  | 'topic-shift'
  | 're-entry'
  | 'concurrent-threads';

export type Capability = 'recall' | 'eviction' | 're-hydration' | 'correction' | 'continuity';

export type ExpectedKind =
  | 'memory'
  | 'email_thread'
  | 'task'
  | 'doc_section'
  | 'artifact'
  | 'inbox_thread';

export type Criticality = 'high' | 'medium' | 'low';

export interface ExpectedItem {
  kind: ExpectedKind;
  /** Identifier: UUID for memory/task/artifact, Gmail thread ID for email, repo-relative path#anchor for doc_section */
  ref: string;
  reason: string;
  /**
   * Optional: phrases that must appear in the surfaced item's content for it
   * to count as this expected item. Useful for doc_section items where we
   * don't have a stable UUID to match on.
   */
  containsPhrases?: string[];
}

export interface AssertClaim {
  claim: string;
  criticality?: Criticality;
  /**
   * Phrases whose presence in the surfaced content proves the claim is
   * derivable. v1 uses substring matching; later versions can swap in an
   * LLM judge without changing the schema.
   */
  containsPhrases?: string[];
}

export interface ScenarioRubric {
  sufficiencyBar?: string;
  precisionFloor?: number;
  recallFloor?: number;
  mustAssertPassRate?: number;
  mustNotAssertLeakRate?: number;
  staleBeliefCorrectionRequired?: boolean;
}

/**
 * Pre-compaction / eviction state for continuity and lifecycle scenarios.
 * The runner uses this to simulate the state the SB was in before the
 * compression or topic shift.
 */
export interface PreState {
  /** Summary of what was in the active context before the simulated event */
  description: string;
  /** Artifact URI or similar identifier the SB was focused on */
  focusRef?: string;
  /** Free-form notes */
  notes?: string;
}

export interface Scenario {
  id: string;
  shape: ScenarioShape;
  capability: Capability[];

  /** The "current turn" the SB sees when the test runs */
  context: string;
  /** What the SB (or user) is implicitly asking */
  impliedQuestion: string;

  /** For correction scenarios: the stale premise to inject */
  stalePremise?: string;
  /** For correction scenarios: what the corrected response must assert */
  expectedCorrection?: string;

  /** For continuity scenarios: state before the simulated compaction */
  preState?: PreState;

  /** Items that SHOULD be surfaced */
  expectedSurfaced: ExpectedItem[];
  /** Claims that must be derivable from surfaced items */
  mustAssert?: AssertClaim[];
  /** Plausible-but-wrong claims the SB must NOT assert */
  mustNotAssert?: AssertClaim[];

  rubric: ScenarioRubric;
}

/** Result of scoring a scenario run */
export interface ScenarioResult {
  scenarioId: string;
  shape: ScenarioShape;
  topicSignal: string;
  surfacedCount: number;
  /** Items surfaced by recall, with matched expected-item refs (if any) */
  surfaced: Array<{
    id: string;
    contentPreview: string;
    matchedExpectedRef?: string;
  }>;
  metrics: {
    precision: number;
    recall: number;
    mustAssertPassRate?: number;
    mustNotAssertLeakRate?: number;
  };
  /** Per-claim derivability verdict */
  mustAssertVerdicts?: Array<{ claim: string; criticality: Criticality; passed: boolean }>;
  mustNotAssertVerdicts?: Array<{ claim: string; leaked: boolean }>;
  /** Overall pass/fail against the rubric */
  passed: boolean;
  failureReasons: string[];
}
