/**
 * May a session's lifecycle phase change be exported as a durable memory?
 *
 * update_session_state turns a significant phase transition (`blocked:*`,
 * `waiting:*`, `complete`) into a `remember()` call built from the caller's
 * note and context. For a browser_restricted session that is page context
 * leaving through a side door, so the write has to be gated on the session's
 * execution profile.
 *
 * Pure, dependency-free, and deliberately its own module. It never reads a
 * session row: the authoritative profile resolver produces an
 * ExecutionProfileResolution, and this module owns that type so the guard
 * cannot come to trust a field the resolver does not yet guarantee.
 *
 * Only an explicitly resolved `standard` profile may export. Absence is not
 * unrestricted: a column default alone could turn an omitted restricted value
 * into standard, so absent, unreadable, unrecognised and malformed results
 * all refuse.
 *
 * A refusal is value-free by construction. It carries a reason code, the
 * session id and the phase CLASS. The text after the colon in `waiting:...`
 * is caller free text, so it never enters the refusal, and neither does the
 * resolver's raw result (an unrecognised profile string, or an exception a
 * resolver attached to a read failure).
 *
 * This guard covers the auto-memory write only. The activity payload's
 * before/after snapshots and createTask's note-derived title are separate
 * egress paths.
 */

export const STANDARD_EXECUTION_PROFILE = 'standard';
export const BROWSER_RESTRICTED_EXECUTION_PROFILE = 'browser_restricted';

/** What the profile resolver found for one session. */
export type ExecutionProfileResolution =
  | { status: 'resolved'; profile: string }
  | { status: 'absent' }
  | { status: 'read_failed' };

export type LifecyclePhaseClass = 'blocked' | 'waiting' | 'complete';

/**
 * `unknown` is everything the guard cannot positively recognise: a resolved
 * profile string other than the two known values (compared exactly, so
 * `Standard` and ` standard` land here), and any resolver result whose shape
 * does not match ExecutionProfileResolution.
 */
export type AutoMemoryExportRefusalReason = 'restricted' | 'absent' | 'read_failed' | 'unknown';

export interface AutoMemoryExportRefusal {
  reason: AutoMemoryExportRefusalReason;
  sessionId: string;
  /** Null only when the phase is outside the auto-memory path entirely. */
  phaseClass: LifecyclePhaseClass | null;
}

export type AutoMemoryExportDecision =
  | { allowed: true }
  | { allowed: false; refusal: AutoMemoryExportRefusal };

/**
 * The class of a phase that update_session_state auto-memorises, or null.
 *
 * Mirrors memory-handlers' isSignificantPhaseTransition exactly: a
 * case-sensitive `blocked:` or `waiting:` prefix, or `complete` verbatim.
 * That is narrower than isTerminalPhaseMarker, which also accepts
 * `completed` and `complete:<reason>`; neither of those auto-memorises today,
 * so neither gets a class here.
 */
export function lifecyclePhaseClass(phase: string): LifecyclePhaseClass | null {
  if (typeof phase !== 'string') return null;
  if (phase.startsWith('blocked:')) return 'blocked';
  if (phase.startsWith('waiting:')) return 'waiting';
  if (phase === 'complete') return 'complete';
  return null;
}

/**
 * Decide whether the auto-memory for this phase transition may be written.
 * The decision depends on the profile alone; the phase only supplies the
 * refusal's class.
 */
export function decideAutoMemoryExport(input: {
  sessionId: string;
  phase: string;
  profile: ExecutionProfileResolution;
}): AutoMemoryExportDecision {
  const reason = refusalReason(input.profile);
  if (reason === null) return { allowed: true };
  return {
    allowed: false,
    refusal: {
      reason,
      sessionId: input.sessionId,
      phaseClass: lifecyclePhaseClass(input.phase),
    },
  };
}

/**
 * Null means allowed. The status is read before the profile, so a result
 * marked absent or read_failed refuses even if it also carries a
 * `profile: 'standard'` field. The resolver's result crosses a database
 * boundary, so a malformed value refuses as `unknown` rather than throwing
 * inside the handler.
 */
function refusalReason(
  resolution: ExecutionProfileResolution
): AutoMemoryExportRefusalReason | null {
  const read = resolution as { status?: unknown; profile?: unknown } | null | undefined;
  const status = read?.status;
  if (status === 'absent') return 'absent';
  if (status === 'read_failed') return 'read_failed';
  if (status !== 'resolved') return 'unknown';
  if (read?.profile === STANDARD_EXECUTION_PROFILE) return null;
  if (read?.profile === BROWSER_RESTRICTED_EXECUTION_PROFILE) return 'restricted';
  return 'unknown';
}
