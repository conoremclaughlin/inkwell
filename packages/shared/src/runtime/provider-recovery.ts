export interface RecoveredBackendSession {
  id: string;
  /**
   * Tool routing the session's envelope was seeded under. Absent on legacy
   * markers written before routing was persisted — treated as a mismatch by
   * the recovery site (reseed full envelope) since the seeded instruction set
   * is unknowable.
   */
  routing?: 'backend' | 'local';
}

/**
 * Recover the live provider-native session from a reattached transcript so a
 * fresh process (the next server heartbeat, or a reattach) resumes the SAME
 * native session instead of fragmenting into a new jsonl. Returns the last
 * `backend_session` marker's id plus the tool routing its envelope was seeded
 * under — a session seeded under the OTHER routing must not be resumed with a
 * delta (a backend-seeded session recovered into local routing would never
 * receive ink-block syntax; the reverse would retain a stale "fenced blocks
 * only" instruction). A `compaction` marker clears the candidate: after ink
 * compacts we deliberately roll to a fresh provider session, so a
 * pre-compaction id must never be resumed (it would drag the pre-compaction
 * window back in).
 */
export function findLastBackendSessionInEvents(
  events: readonly Record<string, unknown>[]
): RecoveredBackendSession | undefined {
  let found: RecoveredBackendSession | undefined;
  for (const event of events) {
    if (event.type === 'backend_session' && typeof event.id === 'string') {
      found = {
        id: event.id,
        ...(event.routing === 'backend' || event.routing === 'local'
          ? { routing: event.routing }
          : {}),
      };
    } else if (
      event.type === 'compaction' ||
      event.type === 'context_evict' ||
      event.type === 'context_trim' ||
      event.type === 'context_budget_changed' ||
      event.type === 'backend_session_invalidated'
    ) {
      // A context-boundary mutation rolled the provider session — including a
      // PACKING-WIDTH change from model detection: a session seeded at the
      // old budget holds only that slice of history and must not be resumed
      // at the new one (Lumen, PR #477 round 3). So did an explicit
      // invalidation (a native session left holding uncorrected fabricated
      // tool results, #569). Abandon any prior id — a backend_session marker
      // after this point re-establishes it.
      found = undefined;
    }
  }
  return found;
}

/**
 * Recover the provider-reported model persisted by a prior process
 * (`model_detected` transcript entries, written on the stream's init event).
 * Backend-scoped: a model detected under a different backend (session
 * switched via /backend) must not drive this backend's window. Last entry
 * wins. Applied on reattach BEFORE any budget enforcement so a 1M-window
 * session is never destructively compacted at the conservative default
 * budget (Lumen, PR #477 review — finding 2).
 */
export function findLastDetectedModelInEvents(
  events: readonly Record<string, unknown>[],
  backend: string
): string | undefined {
  let found: string | undefined;
  for (const event of events) {
    if (
      event.type === 'model_detected' &&
      event.backend === backend &&
      typeof event.model === 'string' &&
      event.model
    ) {
      found = event.model;
    } else if (event.type === 'model_detection_reset' && event.backend === backend) {
      // The model selection changed after this point (/model set or clear) —
      // prior detection no longer describes what serves the session. A new
      // model_detected entry after the reset re-establishes authority.
      found = undefined;
    }
  }
  return found;
}

/**
 * Detect claude's "resume failed because the session no longer exists locally"
 * signal from stderr. Mirrors the same check in the server runners
 * (ink-runner.ts / claude-runner.ts) so the CLI recovers the same way.
 */
export function isResumeFailedNoSession(stderr: string): boolean {
  const lower = (stderr || '').toLowerCase();
  return lower.includes('session not found') || lower.includes('no such session');
}
