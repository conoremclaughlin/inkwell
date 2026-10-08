/** Session-owned provider continuity and measured-context state from runChat. */
import { ProviderSampleTracker, type ProviderSampleScope } from './provider-sample.js';
import { envelopeShapeKey, type SessionPromptState } from './session-prompt.js';
import type { BackendTokenUsage } from './token-usage.js';
import type { ProviderContextMeasurement } from './context-tools.js';

export const CONTEXT_MUTATING_TOOL_NAMES = Object.freeze([
  'write',
  'edit',
  'multi_edit',
  'apply_patch',
  'bash',
]);

export interface SessionContextStatePorts {
  runtime(): SessionPromptState & { detectedModel?: string };
  append(event: Record<string, unknown>): number;
  rolled(note: string): void;
}

export class SessionContextState {
  readonly provider: { id?: string; shape?: string } = {};
  readonly sample = new ProviderSampleTracker();
  generation = 0;
  mutationsInFlight = 0;

  constructor(private readonly ports: SessionContextStatePorts) {}

  scope(): ProviderSampleScope {
    const runtime = this.ports.runtime();
    return {
      backend: runtime.backend,
      model: runtime.detectedModel || runtime.model,
      backendSessionId: this.provider.id,
      // Live envelope, not the seeded baseline. Stateless spawns have no baseline.
      envelopeShape: envelopeShapeKey(runtime),
    };
  }

  sampleUsage(usage: BackendTokenUsage | undefined): void {
    if (!usage) return;
    const scope = this.scope();
    const at = new Date().toISOString();
    this.sample.record(usage, scope, at);
    const parts = usage.contextParts;
    this.ports.append(
      usage.contextTokens !== undefined && usage.contextTokens > 0
        ? {
            type: 'provider_sample',
            at,
            ...scope,
            contextTokens: usage.contextTokens,
            ...(parts?.inputTokens !== undefined ? { inputTokens: parts.inputTokens } : {}),
            ...(parts?.cacheReadTokens !== undefined
              ? { cacheReadTokens: parts.cacheReadTokens }
              : {}),
            ...(parts?.cacheWriteTokens !== undefined
              ? { cacheWriteTokens: parts.cacheWriteTokens }
              : {}),
          }
        : // A report with no measurement is a replay tombstone, not permission
          // to resurrect the prior sample in the next process.
          { type: 'provider_sample', at, ...scope, unknown: true }
    );
  }

  measurement(): ProviderContextMeasurement | undefined {
    return this.sample.measurement(this.scope());
  }

  /** Context eviction/compaction already wrote its own invalidation marker. */
  clearProvider(): void {
    this.provider.id = undefined;
    this.provider.shape = undefined;
    this.sample.clear();
  }

  roll(reason: string, note: string): void {
    if (this.provider.id !== undefined) {
      this.ports.append({ type: 'backend_session_invalidated', id: this.provider.id, reason });
    }
    this.clearProvider();
    this.ports.rolled(note);
  }

  /** Shared by parent and clones. Call the returned settlement in finally. */
  beginMutation(calls: ReadonlyArray<{ tool: string }>): () => void {
    if (
      !calls.some((call) =>
        CONTEXT_MUTATING_TOOL_NAMES.includes(call.tool.replace(/^mcp__inkwell__/, ''))
      )
    ) {
      return () => {};
    }
    this.generation++;
    this.mutationsInFlight++;
    let settled = false;
    return () => {
      // Idempotence protects the occupancy fence from double cleanup on Stop.
      if (settled) return;
      settled = true;
      this.mutationsInFlight--;
      this.generation++;
    };
  }
}
