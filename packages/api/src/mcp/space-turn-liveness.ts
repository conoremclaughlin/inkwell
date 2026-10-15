/**
 * Whether a space-turn token's turn is still running
 * (ink://specs/inkling-multi-person-groups, Phase 2 gate 7).
 *
 * A session outlives its turns: a successful turn settles the row as `idle`
 * and a failed one as `failed`, both keeping `turn_epoch` and a null
 * `ended_at`, so the session can be reused. Session state alone therefore
 * says nothing about the turn, and a token checked only against it worked
 * after its turn had settled (Lumen, PR #867 review). The turn is live only
 * while both of these hold:
 *
 * - the durable row is `running` at the token's epoch, for the marked,
 *   unended session the token names. Every write path rotates `turn_epoch`
 *   when it enters `running`, and `compacting` is not a turn in progress
 *   for this purpose: no tool runs mid-compaction under this token;
 * - this process admitted exactly that generation, with intake open, and
 *   its runner has not settled (isGenerationRunning, active-runs.ts). A row
 *   left `running` by a process that died owns no turn anywhere, and a
 *   draining process starts no work. Admission alone is not enough: it
 *   outlives the runner so finalization can still claim the row, and while
 *   that terminal write is pending or failing the row stays `running` at the
 *   same epoch (Lumen, PR #867 round 2).
 *
 * So a space-turn token works only against the server process that admitted
 * its turn. Space turns are server-run and call back to that server; a
 * request that reaches any other process is refused.
 */

import { isGenerationRunning } from '../services/sessions/active-runs';

/** The session fields the check reads, as the memory repository maps them. */
export interface SpaceTurnSessionState {
  endedAt?: Date | null;
  lifecycle?: string | null;
  turnScope?: string | null;
  turnEpoch?: string | null;
}

export function spaceTurnIsLive(
  session: SpaceTurnSessionState | null | undefined,
  token: { sessionId?: string; turnEpoch?: string }
): boolean {
  if (!session || !token.sessionId || !token.turnEpoch) return false;
  return (
    !session.endedAt &&
    session.turnScope === 'space-turn' &&
    session.lifecycle === 'running' &&
    session.turnEpoch === token.turnEpoch &&
    isGenerationRunning(token.sessionId, token.turnEpoch)
  );
}
