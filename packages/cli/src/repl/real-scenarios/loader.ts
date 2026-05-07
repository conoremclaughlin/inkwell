/**
 * YAML loader + lightweight validator for real-scenario eval files.
 *
 * We don't pull in a heavyweight schema validator — the scenario format is
 * small and the validation rules are clear. If this grows, swap in zod.
 */

import { readFileSync, readdirSync } from 'fs';
import { join, resolve, basename } from 'path';
import { parse as parseYaml } from 'yaml';
import type { Scenario, ScenarioShape, Capability, ExpectedKind, Criticality } from './types.js';

const VALID_SHAPES = new Set<ScenarioShape>([
  'person-centric-recall',
  'state-of-affairs',
  'why-we-care',
  'objective-grounding',
  'convention-recall',
  'current-state-correction',
  'anti-hallucination-challenge',
  'post-compaction-continuity',
  'topic-shift',
  're-entry',
  'concurrent-threads',
]);

const VALID_CAPABILITIES = new Set<Capability>([
  'recall',
  'eviction',
  're-hydration',
  'correction',
  'continuity',
]);

const VALID_EXPECTED_KINDS = new Set<ExpectedKind>([
  'memory',
  'email_thread',
  'task',
  'doc_section',
  'artifact',
  'inbox_thread',
]);

const VALID_CRITICALITIES = new Set<Criticality>(['high', 'medium', 'low']);

export class ScenarioValidationError extends Error {
  constructor(
    public readonly scenarioFile: string,
    public readonly issues: string[]
  ) {
    super(`Invalid scenario ${scenarioFile}:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ScenarioValidationError';
  }
}

function validate(raw: unknown, file: string): Scenario {
  const issues: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ScenarioValidationError(file, ['Scenario must be a YAML object at top level']);
  }

  const s = raw as Record<string, unknown>;

  if (typeof s.id !== 'string' || s.id.length === 0) issues.push('id: required non-empty string');
  if (typeof s.shape !== 'string' || !VALID_SHAPES.has(s.shape as ScenarioShape)) {
    issues.push(
      `shape: must be one of ${[...VALID_SHAPES].join(', ')} — got ${JSON.stringify(s.shape)}`
    );
  }
  if (!Array.isArray(s.capability) || s.capability.length === 0) {
    issues.push('capability: required non-empty array');
  } else {
    for (const c of s.capability) {
      if (!VALID_CAPABILITIES.has(c as Capability)) {
        issues.push(`capability: unknown value ${JSON.stringify(c)}`);
      }
    }
  }
  if (typeof s.context !== 'string' || s.context.trim().length === 0) {
    issues.push('context: required non-empty string');
  }
  if (typeof s.impliedQuestion !== 'string' || s.impliedQuestion.trim().length === 0) {
    issues.push('impliedQuestion: required non-empty string');
  }
  if (!Array.isArray(s.expectedSurfaced) || s.expectedSurfaced.length === 0) {
    issues.push('expectedSurfaced: required non-empty array');
  } else {
    s.expectedSurfaced.forEach((item, i) => {
      if (!item || typeof item !== 'object') {
        issues.push(`expectedSurfaced[${i}]: must be an object`);
        return;
      }
      const it = item as Record<string, unknown>;
      if (!VALID_EXPECTED_KINDS.has(it.kind as ExpectedKind)) {
        issues.push(`expectedSurfaced[${i}].kind: unknown ${JSON.stringify(it.kind)}`);
      }
      if (typeof it.ref !== 'string' || it.ref.length === 0) {
        issues.push(`expectedSurfaced[${i}].ref: required non-empty string`);
      }
      if (typeof it.reason !== 'string') {
        issues.push(`expectedSurfaced[${i}].reason: required string`);
      }
    });
  }

  for (const field of ['mustAssert', 'mustNotAssert'] as const) {
    if (s[field] !== undefined) {
      if (!Array.isArray(s[field])) {
        issues.push(`${field}: must be an array if present`);
      } else {
        (s[field] as unknown[]).forEach((c, i) => {
          if (!c || typeof c !== 'object') {
            issues.push(`${field}[${i}]: must be an object`);
            return;
          }
          const claim = c as Record<string, unknown>;
          if (typeof claim.claim !== 'string' || claim.claim.length === 0) {
            issues.push(`${field}[${i}].claim: required non-empty string`);
          }
          if (
            claim.criticality !== undefined &&
            !VALID_CRITICALITIES.has(claim.criticality as Criticality)
          ) {
            issues.push(`${field}[${i}].criticality: invalid ${JSON.stringify(claim.criticality)}`);
          }
        });
      }
    }
  }

  if (!s.rubric || typeof s.rubric !== 'object') {
    issues.push('rubric: required object');
  }

  if (s.shape === 'current-state-correction' || s.shape === 'anti-hallucination-challenge') {
    if (typeof s.stalePremise !== 'string' || s.stalePremise.length === 0) {
      issues.push(`stalePremise: required for shape ${String(s.shape)}`);
    }
  }

  if (s.shape === 'post-compaction-continuity') {
    if (!s.preState || typeof s.preState !== 'object') {
      issues.push(`preState: required for shape post-compaction-continuity`);
    }
  }

  if (issues.length > 0) throw new ScenarioValidationError(file, issues);

  return raw as Scenario;
}

export function loadScenario(filePath: string): Scenario {
  const raw = parseYaml(readFileSync(filePath, 'utf-8'));
  return validate(raw, filePath);
}

export function loadScenariosFromDir(dir: string): Scenario[] {
  const resolved = resolve(dir);
  const files = readdirSync(resolved).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  return files.map((f) => loadScenario(join(resolved, f))).sort((a, b) => a.id.localeCompare(b.id));
}

/** Default fixtures directory relative to this module */
export function defaultFixturesDir(): string {
  const here = resolve(new URL('.', import.meta.url).pathname);
  return join(here, 'fixtures');
}

/** Debug helper — load and print scenario metadata */
export function describeScenario(scenario: Scenario): string {
  const file = basename(scenario.id);
  return [
    `[${scenario.shape}] ${file}`,
    `  capability: ${scenario.capability.join(', ')}`,
    `  expected: ${scenario.expectedSurfaced.length} items`,
    `  mustAssert: ${scenario.mustAssert?.length ?? 0} claims`,
    `  mustNotAssert: ${scenario.mustNotAssert?.length ?? 0} claims`,
  ].join('\n');
}
