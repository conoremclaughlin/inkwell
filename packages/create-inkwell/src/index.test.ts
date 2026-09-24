import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  LEGACY_STATE_FILE,
  STATE_FILE,
  isComplete,
  loadState,
  markComplete,
  saveState,
  type ProgressState,
} from './progress.js';

/**
 * These used to be a re-implementation of index.ts's helpers, because index.ts
 * calls main() at module load and importing it would launch the wizard. A
 * mirror cannot fail when the real code changes, so #659 moved the helpers
 * into progress.ts and this file now exercises them directly.
 */

describe('create-inkwell state management', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `create-inkwell-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadState returns empty state for new directory', () => {
    const state = loadState(tmpDir);
    expect(state.completedSteps).toEqual([]);
    expect(state.targetDir).toBe(tmpDir);
  });

  it('saveState writes and loadState reads back', () => {
    const state: ProgressState = {
      completedSteps: ['prereqs', 'clone'],
      targetDir: tmpDir,
      dbMode: 'local',
    };
    saveState(state);

    const loaded = loadState(tmpDir);
    expect(loaded.completedSteps).toEqual(['prereqs', 'clone']);
    expect(loaded.dbMode).toBe('local');
  });

  it('saveState is a no-op when directory does not exist', () => {
    const state: ProgressState = {
      completedSteps: ['prereqs'],
      targetDir: '/nonexistent/path/that/does/not/exist',
    };
    // Should not throw
    saveState(state);
    expect(existsSync(join(state.targetDir, STATE_FILE))).toBe(false);
  });

  it('markComplete adds step and persists', () => {
    const state: ProgressState = { completedSteps: [], targetDir: tmpDir };

    markComplete(state, 'prereqs');
    expect(state.completedSteps).toEqual(['prereqs']);

    markComplete(state, 'clone');
    expect(state.completedSteps).toEqual(['prereqs', 'clone']);

    // Verify persisted
    const loaded = loadState(tmpDir);
    expect(loaded.completedSteps).toEqual(['prereqs', 'clone']);
  });

  it('markComplete is idempotent', () => {
    const state: ProgressState = { completedSteps: [], targetDir: tmpDir };

    markComplete(state, 'prereqs');
    markComplete(state, 'prereqs');
    markComplete(state, 'prereqs');

    expect(state.completedSteps).toEqual(['prereqs']);
  });

  it('isComplete returns true for completed steps', () => {
    const state: ProgressState = {
      completedSteps: ['prereqs', 'clone', 'install'],
      targetDir: tmpDir,
    };

    expect(isComplete(state, 'prereqs')).toBe(true);
    expect(isComplete(state, 'clone')).toBe(true);
    expect(isComplete(state, 'install')).toBe(true);
    expect(isComplete(state, 'database')).toBe(false);
    expect(isComplete(state, 'awaken')).toBe(false);
  });

  it('loadState handles corrupted JSON gracefully', () => {
    writeFileSync(join(tmpDir, STATE_FILE), '{not valid json!!!');
    const state = loadState(tmpDir);
    expect(state.completedSteps).toEqual([]);
  });

  it('full resumability flow', () => {
    // Simulate: first run completes steps 1-4, then crashes
    const state1: ProgressState = { completedSteps: [], targetDir: tmpDir };
    markComplete(state1, 'prereqs');
    markComplete(state1, 'clone');
    markComplete(state1, 'install');
    markComplete(state1, 'database');

    // Simulate: second run loads state and resumes
    const state2 = loadState(tmpDir);
    expect(state2.completedSteps).toEqual(['prereqs', 'clone', 'install', 'database']);

    // Continue from where we left off
    markComplete(state2, 'server');
    markComplete(state2, 'auth');

    // Verify final state
    const state3 = loadState(tmpDir);
    expect(state3.completedSteps).toEqual([
      'prereqs',
      'clone',
      'install',
      'database',
      'server',
      'auth',
    ]);
  });

  // A setup interrupted before #659 left its progress under the old name.
  // Ignoring it silently restarts a nine-step wizard from zero.
  it('resumes from the pre-rename progress file', () => {
    writeFileSync(
      join(tmpDir, LEGACY_STATE_FILE),
      JSON.stringify({ completedSteps: ['clone', 'install'], targetDir: tmpDir })
    );

    const state = loadState(tmpDir);

    expect(state.completedSteps).toEqual(['clone', 'install']);
    expect(isComplete(state, 'install')).toBe(true);
  });

  it('prefers the current progress file when both exist', () => {
    writeFileSync(
      join(tmpDir, LEGACY_STATE_FILE),
      JSON.stringify({ completedSteps: ['stale'], targetDir: tmpDir })
    );
    writeFileSync(
      join(tmpDir, STATE_FILE),
      JSON.stringify({ completedSteps: ['current'], targetDir: tmpDir })
    );

    expect(loadState(tmpDir).completedSteps).toEqual(['current']);
  });

  it('writes only the current progress file', () => {
    writeFileSync(
      join(tmpDir, LEGACY_STATE_FILE),
      JSON.stringify({ completedSteps: [], targetDir: tmpDir })
    );
    const state: ProgressState = loadState(tmpDir);

    markComplete(state, 'clone');

    expect(existsSync(join(tmpDir, STATE_FILE))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(tmpDir, LEGACY_STATE_FILE), 'utf-8')).completedSteps
    ).toEqual([]);
  });

  // index.ts calls main() at module load, so the entry path cannot be
  // imported and exercised. It gated the load on the CURRENT progress file
  // existing, which meant a legacy-only resume never reached loadState at
  // all: the helper below resumed correctly and the wizard still started from
  // zero. The gate is gone, so loadState is the only route to a state — this
  // asserts it stays that way.
  it('has exactly one route to a progress state', () => {
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf-8');

    expect(source).toContain('loadState(targetDir)');
    // The inline default the gate fell back to. Its absence is what makes
    // loadState the single decision point.
    expect(source).not.toMatch(/completedSteps:\s*\[\]/);
    expect(source).not.toMatch(/existsSync\([^)]*STATE_FILE/);
  });
});
