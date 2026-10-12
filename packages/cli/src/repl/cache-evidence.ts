/**
 * What a run left in its session's prompt cache, as ink chat reports it to the
 * server for idle compaction.
 *
 * Every invocation's evidence is scoped to the native provider session and
 * the model it ran under. A lifetime is a fact about one cache entry, and a
 * new native session or a different model is a different entry, so the scope
 * travels with the evidence instead of being attached afterwards.
 */
import type { CacheWriteEvidence } from './token-usage.js';

export interface CacheScope {
  providerSessionId?: string;
  model?: string;
}

export type RunCacheEvidence =
  | ({ kind: 'ttl'; seconds: number } & CacheScope)
  | ({ kind: 'read-only' } & CacheScope)
  | { kind: 'unknown' };

function sameScope(a: CacheScope, b: CacheScope): boolean {
  return (
    a.providerSessionId !== undefined &&
    a.providerSessionId === b.providerSessionId &&
    a.model === b.model
  );
}

/**
 * The run's evidence after one more invocation.
 *
 * - A lifetime replaces what was there, in this invocation's scope.
 * - A read-only invocation keeps a lifetime learned in the same scope, since
 *   it read under it; otherwise it is read-only in its own scope, and the
 *   server decides whether anything it learned earlier still applies.
 * - An unknown write, or an invocation that reports nothing, is unknown, and
 *   no earlier lifetime survives it. Unknown stays until a fresh lifetime is
 *   written: a read-only invocation after it read under whatever the unknown
 *   write left, and calling that read-only would let the server inherit a
 *   lifetime from before it (Lumen, #845 r3).
 */
export function nextRunCacheEvidence(
  previous: RunCacheEvidence | undefined,
  write: CacheWriteEvidence | undefined,
  scope: CacheScope
): RunCacheEvidence {
  const ownScope: CacheScope = {
    ...(scope.providerSessionId ? { providerSessionId: scope.providerSessionId } : {}),
    ...(scope.model ? { model: scope.model } : {}),
  };
  if (!write || write.kind === 'unknown') return { kind: 'unknown' };
  if (write.kind === 'ttl') return { kind: 'ttl', seconds: write.seconds, ...ownScope };
  if (previous?.kind === 'unknown') return previous;
  if (previous?.kind === 'ttl' && sameScope(previous, ownScope)) return previous;
  return { kind: 'read-only', ...ownScope };
}
