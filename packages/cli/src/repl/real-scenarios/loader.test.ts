import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadScenario,
  loadScenariosFromDir,
  defaultFixturesDir,
  ScenarioValidationError,
} from './loader.js';

function writeTmpScenario(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'scenarios-'));
  const file = join(dir, `${name}.yaml`);
  writeFileSync(file, content);
  return file;
}

describe('loader: valid scenario', () => {
  it('loads the bundled fixtures without error', () => {
    const scenarios = loadScenariosFromDir(defaultFixturesDir());
    expect(scenarios.length).toBeGreaterThanOrEqual(3);
    const ids = scenarios.map((s) => s.id).sort();
    expect(ids).toContain('merge-strategy-rule');
    expect(ids).toContain('push-to-main-rule');
    expect(ids).toContain('restart-dev-server');
  });

  it('preserves shape-specific fields like stalePremise', () => {
    const scenarios = loadScenariosFromDir(defaultFixturesDir());
    const correction = scenarios.find((s) => s.id === 'restart-dev-server');
    expect(correction).toBeDefined();
    expect(correction!.shape).toBe('current-state-correction');
    expect(correction!.stalePremise).toContain('restart the server');
    expect(correction!.expectedCorrection).toContain('Decline to restart');
  });
});

describe('loader: validation', () => {
  it('rejects missing id', () => {
    const file = writeTmpScenario(
      'bad-no-id',
      `
shape: convention-recall
capability: [recall]
context: x
impliedQuestion: y
expectedSurfaced:
  - kind: memory
    ref: abc
    reason: test
rubric: {}
`
    );
    expect(() => loadScenario(file)).toThrow(ScenarioValidationError);
  });

  it('rejects unknown shape', () => {
    const file = writeTmpScenario(
      'bad-shape',
      `
id: x
shape: nonsense-shape
capability: [recall]
context: x
impliedQuestion: y
expectedSurfaced:
  - kind: memory
    ref: abc
    reason: test
rubric: {}
`
    );
    expect(() => loadScenario(file)).toThrow(/shape/);
  });

  it('requires stalePremise for correction shapes', () => {
    const file = writeTmpScenario(
      'bad-correction',
      `
id: x
shape: current-state-correction
capability: [correction]
context: x
impliedQuestion: y
expectedSurfaced:
  - kind: doc_section
    ref: x
    reason: x
rubric: {}
`
    );
    expect(() => loadScenario(file)).toThrow(/stalePremise/);
  });

  it('rejects empty expectedSurfaced', () => {
    const file = writeTmpScenario(
      'bad-empty-expected',
      `
id: x
shape: convention-recall
capability: [recall]
context: x
impliedQuestion: y
expectedSurfaced: []
rubric: {}
`
    );
    expect(() => loadScenario(file)).toThrow(/expectedSurfaced/);
  });

  it('validates mustAssert criticality enum', () => {
    const file = writeTmpScenario(
      'bad-criticality',
      `
id: x
shape: convention-recall
capability: [recall]
context: x
impliedQuestion: y
expectedSurfaced:
  - kind: memory
    ref: abc
    reason: test
mustAssert:
  - claim: something
    criticality: catastrophic
rubric: {}
`
    );
    expect(() => loadScenario(file)).toThrow(/criticality/);
  });
});

describe('loader: loadScenariosFromDir', () => {
  it('returns empty array when directory has no yaml files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'empty-'));
    mkdirSync(join(dir, 'subdir'), { recursive: true });
    expect(loadScenariosFromDir(dir)).toEqual([]);
  });
});
