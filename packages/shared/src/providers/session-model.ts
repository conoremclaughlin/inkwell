/** Model/window updates from runChat; the host owns the live state and log. */
import {
  resolveModelContextWindow as resolveBackendTokenWindow,
  contextBudgetForWindow as defaultContextBudget,
} from '../runtime/context-limits.js';
import { promptTransportFor } from './registry.js';

export interface SessionModelState {
  backend: string;
  model?: string;
  detectedModel?: string;
  backendTokenWindow: number;
  maxContextTokens: number;
  log: { append(event: Record<string, unknown>): number };
}

export function applyModelSelection(
  runtime: SessionModelState,
  next: string | undefined,
  contextBudgetAuto: boolean
): void {
  runtime.model = next;
  runtime.detectedModel = undefined;
  runtime.log.append({
    type: 'model_detection_reset',
    backend: runtime.backend,
  });
  runtime.backendTokenWindow = resolveBackendTokenWindow(runtime.backend, runtime.model);
  if (contextBudgetAuto) {
    applyBudgetForWindow(runtime, runtime.backendTokenWindow);
  }
}

/**
 * Apply a provider-REPORTED model (the stream's init event): remember it,
 * persist it for cross-process recovery, and re-resolve the window/budget.
 * When the packing budget changes, a `context_budget_changed` boundary is
 * appended so a native session seeded at the OLD packing width is never
 * resumed-by-recovery in a later process — a one-turn process can seed at
 * 170K, detect Fable 5, and exit before the in-process shape drift gets a
 * next turn to reseed; without the boundary, the next process would restore
 * the 850K budget, recover the narrow-seeded session id, and delta into it
 * forever, stranding the omitted history (Lumen, PR #477 round 3).
 * findLastBackendSession treats the boundary like compaction/evict/trim
 * markers: recovery is refused and the next turn seeds fresh at the new
 * width (a post-detection reseed writes a new backend_session marker, which
 * re-establishes recovery).
 */
export function applyDetectedModel(
  runtime: SessionModelState,
  model: string,
  contextBudgetAuto: boolean
): { windowChanged: boolean } {
  runtime.detectedModel = model;
  runtime.log.append({
    type: 'model_detected',
    backend: runtime.backend,
    model,
  });
  const window = resolveBackendTokenWindow(runtime.backend, runtime.model ?? model);
  if (window === runtime.backendTokenWindow) return { windowChanged: false };
  runtime.backendTokenWindow = window;
  if (contextBudgetAuto) {
    applyBudgetForWindow(runtime, window);
  }
  return { windowChanged: true };
}

/**
 * Recompute the AUTO working budget for a window and, when it actually
 * changes, append the `context_budget_changed` boundary that severs
 * cross-process recovery of native sessions seeded at the old packing width.
 */
function applyBudgetForWindow(runtime: SessionModelState, window: number): void {
  const previous = runtime.maxContextTokens;
  runtime.maxContextTokens = defaultContextBudget(window, promptTransportFor(runtime.backend));
  if (runtime.maxContextTokens !== previous) {
    runtime.log.append({
      type: 'context_budget_changed',
      from: previous,
      to: runtime.maxContextTokens,
    });
  }
}
