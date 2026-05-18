/**
 * Scenario runner — orchestrates a single real-scenario eval run.
 *
 * Pure function over (scenario, recallFn): the caller wires the recall
 * function (HTTP to PCP, in-memory stub for tests, etc.) and the runner
 * handles signal extraction, recall invocation, and scoring.
 *
 * v1 handles simple recall / correction / convention shapes. Eviction,
 * re-hydration, and compaction shapes are stubbed with TODO markers.
 */

import { extractTopicSignal } from '../builtin-hooks.js';
import { scoreScenario, type SurfacedMemory } from './scorer.js';
import type { Scenario, ScenarioResult } from './types.js';

export type RecallFn = (query: string, limit: number) => Promise<SurfacedMemory[]>;

export type QueryMode = 'keyword' | 'llm';

/**
 * Builds a recall query from scenario context using an LLM.
 * Caller provides this to avoid coupling the runner to a specific LLM SDK.
 */
export type LlmQueryFn = (scenario: Scenario) => Promise<string>;

export interface RunOptions {
  /** Max memories to fetch per recall call. Default 20. */
  recallLimit?: number;
  /** Query construction strategy. Default 'keyword'. */
  queryMode?: QueryMode;
  /** Required when queryMode is 'llm'. */
  llmQueryFn?: LlmQueryFn;
}

/**
 * Build the text the topic-signal extractor sees. Mirrors what passive
 * recall does at turn_end: "userInput" = the context + stale premise,
 * "assistantResponse" = the implied question (as if the SB just verbalized
 * what's really being asked).
 */
function buildSignalInput(scenario: Scenario): { userInput: string; assistantResponse: string } {
  const userInput = [scenario.stalePremise, scenario.context].filter(Boolean).join('\n\n');
  return {
    userInput,
    assistantResponse: scenario.impliedQuestion,
  };
}

async function buildQuery(scenario: Scenario, opts: RunOptions): Promise<string> {
  if (opts.queryMode === 'llm') {
    if (!opts.llmQueryFn) throw new Error('queryMode "llm" requires llmQueryFn');
    return opts.llmQueryFn(scenario);
  }
  const { userInput, assistantResponse } = buildSignalInput(scenario);
  return extractTopicSignal(userInput, assistantResponse);
}

export async function runScenario(
  scenario: Scenario,
  recallFn: RecallFn,
  opts: RunOptions = {}
): Promise<ScenarioResult> {
  const unsupported: Scenario['shape'][] = [
    'topic-shift',
    're-entry',
    'concurrent-threads',
    'post-compaction-continuity',
  ];
  if (unsupported.includes(scenario.shape)) {
    return {
      scenarioId: scenario.id,
      shape: scenario.shape,
      topicSignal: '',
      surfacedCount: 0,
      surfaced: [],
      metrics: { precision: 0, recall: 0 },
      passed: false,
      failureReasons: [
        `shape ${scenario.shape} not yet implemented by runner (v1 covers orientation, convention, and correction shapes)`,
      ],
    };
  }

  let topicSignal: string;
  try {
    topicSignal = await buildQuery(scenario, opts);
  } catch (err) {
    return {
      scenarioId: scenario.id,
      shape: scenario.shape,
      topicSignal: '',
      surfacedCount: 0,
      surfaced: [],
      metrics: { precision: 0, recall: 0 },
      passed: false,
      failureReasons: [
        `query construction error: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  let surfaced: SurfacedMemory[] = [];
  try {
    surfaced = await recallFn(topicSignal, opts.recallLimit ?? 20);
  } catch (err) {
    return {
      scenarioId: scenario.id,
      shape: scenario.shape,
      topicSignal,
      surfacedCount: 0,
      surfaced: [],
      metrics: { precision: 0, recall: 0 },
      passed: false,
      failureReasons: [`recall error: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  return scoreScenario(scenario, topicSignal, surfaced);
}

export async function runAllScenarios(
  scenarios: Scenario[],
  recallFn: RecallFn,
  opts: RunOptions = {}
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    results.push(await runScenario(s, recallFn, opts));
  }
  return results;
}
