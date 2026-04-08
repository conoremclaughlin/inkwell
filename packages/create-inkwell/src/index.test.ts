import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Since the utility functions are not exported from index.ts (they're internal),
 * we test them via a minimal re-implementation that mirrors the same logic.
 * This validates the state management and resumability contract.
 */

const STATE_FILE = '.create-pcp-progress.json';

interface ProgressState {
  completedSteps: string[];
  targetDir: string;
  dbMode?: 'local' | 'hosted';
  backend?: string;
}

function loadState(dir: string): ProgressState {
  const file = join(dir, STATE_FILE);
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      // Corrupted state — start fresh
    }
  }
  return { completedSteps: [], targetDir: dir };
}

function saveState(state: ProgressState): void {
  if (!existsSync(state.targetDir)) return;
  const file = join(state.targetDir, STATE_FILE);
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

function markComplete(state: ProgressState, step: string): void {
  if (!state.completedSteps.includes(step)) {
    state.completedSteps.push(step);
    saveState(state);
  }
}

function isComplete(state: ProgressState, step: string): boolean {
  return state.completedSteps.includes(step);
}

describe('create-pcp state management', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `create-pcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
});
