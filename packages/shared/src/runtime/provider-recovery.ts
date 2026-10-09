export interface RecoveredBackendSession {
  id: string;
  /** Which durable selection the writer actually installed before this seed. */
  controlId?: string;
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
  const recovery = createProviderRecovery('');
  for (const event of events) recovery.push(event);
  return recovery.session;
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
  const recovery = createProviderRecovery(backend);
  for (const event of events) recovery.push(event);
  return recovery.model;
}

/** Constant-sized provider state, shared by array and streamed history replay. */
export function createProviderRecovery(backend: string) {
  let session: RecoveredBackendSession | undefined;
  let model: string | undefined;
  return {
    get session() {
      return session;
    },
    get model() {
      return model;
    },
    push(event: Record<string, unknown>) {
      if (event.type === 'backend_session' && typeof event.id === 'string') {
        session =
          event.recoverable === false
            ? undefined
            : {
                id: event.id,
                ...(typeof event.controlId === 'string' ? { controlId: event.controlId } : {}),
                ...(event.routing === 'backend' || event.routing === 'local'
                  ? { routing: event.routing }
                  : {}),
              };
      } else if (
        typeof event.type === 'string' &&
        [
          'compaction',
          'context_evict',
          'context_trim',
          'context_budget_changed',
          'backend_session_invalidated',
          'session_control',
        ].includes(event.type)
      ) {
        session = undefined;
      }
      if (
        event.type === 'model_detected' &&
        event.backend === backend &&
        typeof event.model === 'string' &&
        event.model
      ) {
        model = event.model;
      } else if (event.type === 'session_control' && event.backend !== backend) {
        model = undefined;
      } else if (
        (event.type === 'model_detection_reset' ||
          (event.type === 'session_control' &&
            event.selection !== null &&
            typeof event.selection === 'object' &&
            'model' in event.selection)) &&
        event.backend === backend
      ) {
        model = undefined;
      }
    },
  };
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
