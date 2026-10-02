import type { BackendTokenUsage } from './token-usage.js';
import type { ProviderContextMeasurement } from './context-tools.js';

/**
 * What a provider measurement is a measurement OF. A usage report describes
 * one request to one native session under one envelope. Once any of those
 * changes — the session is rolled, the model swapped, the envelope rebuilt —
 * the number describes a window that no longer exists, and budgeting against
 * it compacts the wrong ledger (Lumen, PR #583 finding 4).
 */
export interface ProviderSampleScope {
  backend: string;
  model?: string;
  backendSessionId?: string;
  envelopeShape?: string;
}

export interface ProviderSample {
  usage: BackendTokenUsage;
  scope: ProviderSampleScope;
  /** When the request happened (ISO). */
  at: string;
}

export function sameProviderScope(a: ProviderSampleScope, b: ProviderSampleScope): boolean {
  return (
    a.backend === b.backend &&
    a.model === b.model &&
    a.backendSessionId === b.backendSessionId &&
    a.envelopeShape === b.envelopeShape
  );
}

/**
 * Holds the provider's latest usage report together with the scope it was
 * taken under, and hands it back only while that scope is still the live
 * one. `record` is called where a spawn's result lands — before the loop
 * runs that turn's tools — so a `list_context` in the same turn already sees
 * it (Lumen, PR #583 finding 1).
 */
export class ProviderSampleTracker {
  private sample: ProviderSample | undefined;

  record(
    usage: BackendTokenUsage | undefined,
    scope: ProviderSampleScope,
    at: string = new Date().toISOString()
  ): void {
    // A spawn that reported nothing leaves the previous report in place: it
    // still describes the session if the scope has not moved on.
    if (!usage) return;
    this.sample = { usage, scope: { ...scope }, at };
  }

  clear(): void {
    this.sample = undefined;
  }

  latest(): ProviderSample | undefined {
    return this.sample;
  }

  /** The last measurement, only while it still describes the live window. */
  measurement(scope: ProviderSampleScope): ProviderContextMeasurement | undefined {
    const s = this.sample;
    if (!s || !sameProviderScope(s.scope, scope)) return undefined;
    const contextTokens = s.usage.contextTokens;
    if (contextTokens === undefined || contextTokens <= 0) return undefined;
    // The FINAL request's parts, never the run's aggregate top-level fields:
    // a breakdown that does not sum to the total is a contradiction (Lumen,
    // PR #583 round 3). Without per-request parts, only the total is shown.
    const parts = s.usage.contextParts;
    return {
      contextTokens,
      ...(parts?.inputTokens !== undefined ? { inputTokens: parts.inputTokens } : {}),
      ...(parts?.cacheReadTokens !== undefined ? { cacheReadTokens: parts.cacheReadTokens } : {}),
      ...(parts?.cacheWriteTokens !== undefined
        ? { cacheWriteTokens: parts.cacheWriteTokens }
        : {}),
      ...(s.scope.model ? { model: s.scope.model } : {}),
      measuredAt: s.at,
    };
  }
}
