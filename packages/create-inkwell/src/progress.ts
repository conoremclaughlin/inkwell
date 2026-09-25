/**
 * Resume state for the setup wizard.
 *
 * Split out of index.ts so it can be tested directly. index.ts calls `main()`
 * at module load, so importing it to reach these helpers would launch the
 * wizard — which is why index.test.ts used to re-implement them, and why a
 * regression in the real ones could not have been caught there.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STATE_FILE = '.create-inkwell-progress.json';

/**
 * Written by the wizard before #659.
 *
 * A setup interrupted under the old name has its progress in this file. Read
 * when the current one is absent so it resumes instead of starting over; only
 * the current name is ever written.
 */
export const LEGACY_STATE_FILE = '.create-pcp-progress.json';

export interface ProgressState {
  completedSteps: string[];
  targetDir: string;
  dbMode?: 'local' | 'hosted';
  backend?: string;
}

export function loadState(dir: string): ProgressState {
  for (const name of [STATE_FILE, LEGACY_STATE_FILE]) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    try {
      return JSON.parse(readFileSync(file, 'utf-8')) as ProgressState;
    } catch {
      // Corrupted state — try the next candidate, then start fresh.
    }
  }
  return { completedSteps: [], targetDir: dir };
}

export function saveState(state: ProgressState): void {
  if (!existsSync(state.targetDir)) return; // Dir not created yet (pre-clone)
  writeFileSync(join(state.targetDir, STATE_FILE), JSON.stringify(state, null, 2) + '\n');
}

export function isComplete(state: ProgressState, step: string): boolean {
  return state.completedSteps.includes(step);
}

export function markComplete(state: ProgressState, step: string): void {
  if (!state.completedSteps.includes(step)) {
    state.completedSteps.push(step);
    saveState(state);
  }
}
