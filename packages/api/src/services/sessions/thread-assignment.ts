import { logger } from '../../utils/logger';

/**
 * Thread participant session assignment — the ONE sanctioned writer of
 * `inbox_thread_participants.session_id`.
 *
 * Spec: ink://specs/inkmail-read-state §3a (approved v9, 2026-08-08).
 *
 * Semantics:
 * - **Explicit anchor** (caller passed recipientSessionId/sessionAlias):
 *   authorized overwrite — the anchor IS the deliberate-retarget signal.
 * - **Otherwise, first assignment is a CAS**: write only where
 *   `session_id IS NULL`. If the claim loses, reread the winner and route
 *   delivery there; if the stamped session is dead, rebind (guarded update
 *   against the dead id).
 * - Every write logs `bound_via` so "why did this thread land there" stays
 *   a query, not an investigation.
 */

// Thread tables aren't in generated Supabase types yet; accept the loose
// client shape the tool layer already uses.
/* eslint-disable @typescript-eslint/no-explicit-any */

export type BoundVia =
  | 'explicit-anchor'
  | 'explicit-retarget'
  | 'continuity'
  | 'claim'
  | 'rebind-dead-session';

export interface AssignParams {
  threadId: string;
  agentId: string;
  /** The session the router resolved for this delivery. */
  candidateSessionId: string;
  /** Caller passed recipientSessionId/sessionAlias — authorized overwrite. */
  explicitAnchor: boolean;
  /** Call-site label for logs. */
  source: string;
}

export interface AssignResult {
  /** The session the thread is bound to after assignment — deliver HERE. */
  sessionId: string;
  /** True when the candidate lost the claim and delivery must reroute. */
  rerouted: boolean;
  boundVia: BoundVia | 'already-bound';
  /**
   * False when no durable participant stamp exists after this call (write
   * failed and recovery found the row still NULL, or no participant row).
   * A wake dispatch may still deliver — the wake itself surfaces the
   * message — but a routeOnly dispatch MUST treat this as failure: under
   * stamped-only polling an unstamped thread is invisible to every session,
   * and with no wake coming there is no retry (Lumen, PR #460 round 2).
   */
  stampPersisted: boolean;
}

interface SessionRow {
  id: string;
  ended_at: string | null;
  lifecycle: string | null;
}

async function isSessionDead(supabase: any, sessionId: string): Promise<boolean> {
  const { data, error } = (await supabase
    .from('sessions')
    .select('id, ended_at, lifecycle')
    .eq('id', sessionId)
    .maybeSingle()) as { data: SessionRow | null; error: { message: string } | null };
  // FAIL-SAFE: a lookup ERROR is not evidence of death — treating it as dead
  // would let a transient DB failure authorize a rebind (Lumen, PR #460 §3).
  if (error) {
    logger.warn('[Assign] Session liveness lookup failed — treating as alive', {
      sessionId,
      error: error.message,
    });
    return false;
  }
  // A cleanly-missing row IS dead. Current terminal gate is ended_at/failed;
  // when the session-lifecycle-model migration lands (archived_at), this
  // helper is the single place to update.
  if (!data) return true;
  return !!data.ended_at || data.lifecycle === 'failed';
}

/**
 * FAIL-SAFE recovery for a failed stamp write: never report the candidate as
 * bound. Reread the durable stamp — if one exists, delivery must follow IT
 * (reroute); only when the row is genuinely unstamped does delivery proceed
 * to the candidate (the stamp stays NULL, so the next dispatch retries).
 */
async function recoverFromWriteFailure(
  supabase: any,
  params: AssignParams,
  failedVia: BoundVia
): Promise<AssignResult> {
  const { threadId, agentId, candidateSessionId } = params;
  const { data: after } = await supabase
    .from('inbox_thread_participants')
    .select('session_id')
    .eq('thread_id', threadId)
    .eq('agent_id', agentId)
    .maybeSingle();
  const stamp: string | null = after?.session_id ?? null;
  if (stamp && stamp !== candidateSessionId) {
    return { sessionId: stamp, rerouted: true, boundVia: 'continuity', stampPersisted: true };
  }
  // stamp === candidate: someone else durably wrote our candidate. Otherwise
  // the row is still NULL — our write failed and nothing durable exists.
  return {
    sessionId: stamp || candidateSessionId,
    rerouted: false,
    boundVia: failedVia,
    stampPersisted: stamp === candidateSessionId,
  };
}

export async function assignThreadParticipant(
  supabase: any,
  params: AssignParams
): Promise<AssignResult> {
  const { threadId, agentId, candidateSessionId, explicitAnchor, source } = params;

  const { data: existing } = await supabase
    .from('inbox_thread_participants')
    .select('session_id')
    .eq('thread_id', threadId)
    .eq('agent_id', agentId)
    .maybeSingle();

  const currentStamp: string | null = existing?.session_id ?? null;

  // Explicit anchor: authorized overwrite (deliberate retarget when a live
  // stamp exists, plain anchor otherwise).
  if (explicitAnchor) {
    if (currentStamp === candidateSessionId) {
      return {
        sessionId: candidateSessionId,
        rerouted: false,
        boundVia: 'already-bound',
        stampPersisted: true,
      };
    }
    const boundVia: BoundVia = currentStamp ? 'explicit-retarget' : 'explicit-anchor';
    // Check affected rows, not just the error: participant inserts are
    // unchecked upstream, so a missing row yields an error-free zero-row
    // UPDATE — which must never report a durable stamp (Lumen, round 3).
    const { data: anchored, error } = await supabase
      .from('inbox_thread_participants')
      .update({ session_id: candidateSessionId })
      .eq('thread_id', threadId)
      .eq('agent_id', agentId)
      .select('session_id');
    if (error) {
      logger.error('[Assign] Anchor stamp failed', {
        threadId,
        agentId,
        candidateSessionId,
        source,
        error: error.message,
      });
      return recoverFromWriteFailure(supabase, params, boundVia);
    }
    if (!anchored || anchored.length === 0) {
      logger.error('[Assign] Anchor stamp affected no rows — participant row missing', {
        threadId,
        agentId,
        candidateSessionId,
        source,
      });
      return recoverFromWriteFailure(supabase, params, boundVia);
    }
    logger.info('[Assign] Thread participant bound', {
      threadId,
      agentId,
      sessionId: candidateSessionId,
      previousSessionId: currentStamp,
      boundVia,
      source,
    });
    return { sessionId: candidateSessionId, rerouted: false, boundVia, stampPersisted: true };
  }

  // Continuity: live stamp wins; candidate is discarded.
  if (currentStamp) {
    if (currentStamp === candidateSessionId) {
      return {
        sessionId: currentStamp,
        rerouted: false,
        boundVia: 'already-bound',
        stampPersisted: true,
      };
    }
    const dead = await isSessionDead(supabase, currentStamp);
    if (!dead) {
      logger.info('[Assign] Existing live stamp wins — rerouting delivery', {
        threadId,
        agentId,
        stampedSessionId: currentStamp,
        candidateSessionId,
        boundVia: 'continuity',
        source,
      });
      return {
        sessionId: currentStamp,
        rerouted: true,
        boundVia: 'continuity',
        stampPersisted: true,
      };
    }
    // Dead stamp: rebind, guarded against the dead id so a concurrent rebind
    // can't double-write.
    const { data: rebound, error: rebindErr } = await supabase
      .from('inbox_thread_participants')
      .update({ session_id: candidateSessionId })
      .eq('thread_id', threadId)
      .eq('agent_id', agentId)
      .eq('session_id', currentStamp)
      .select('session_id');
    if (rebindErr) {
      logger.error('[Assign] Dead-session rebind failed', {
        threadId,
        agentId,
        deadSessionId: currentStamp,
        candidateSessionId,
        source,
        error: rebindErr.message,
      });
      return recoverFromWriteFailure(supabase, params, 'rebind-dead-session');
    }
    if (!rebound || rebound.length === 0) {
      // Lost the rebind race — reread the winner.
      const { data: after } = await supabase
        .from('inbox_thread_participants')
        .select('session_id')
        .eq('thread_id', threadId)
        .eq('agent_id', agentId)
        .maybeSingle();
      const winner: string | null = after?.session_id ?? null;
      if (winner && winner !== candidateSessionId) {
        logger.info('[Assign] Lost rebind race — rerouting to winner', {
          threadId,
          agentId,
          winnerSessionId: winner,
          candidateSessionId,
          source,
        });
        return { sessionId: winner, rerouted: true, boundVia: 'continuity', stampPersisted: true };
      }
      // winner === candidate: durably stamped by a concurrent writer. A NULL
      // reread means no durable stamp survived — do not claim persistence.
      return {
        sessionId: candidateSessionId,
        rerouted: false,
        boundVia: 'rebind-dead-session',
        stampPersisted: winner === candidateSessionId,
      };
    }
    logger.info('[Assign] Thread participant bound', {
      threadId,
      agentId,
      sessionId: candidateSessionId,
      previousSessionId: currentStamp,
      boundVia: 'rebind-dead-session',
      source,
    });
    return {
      sessionId: candidateSessionId,
      rerouted: false,
      boundVia: 'rebind-dead-session',
      stampPersisted: true,
    };
  }

  // First assignment: CAS — claim only while unstamped.
  const { data: claimed, error: claimErr } = await supabase
    .from('inbox_thread_participants')
    .update({ session_id: candidateSessionId })
    .eq('thread_id', threadId)
    .eq('agent_id', agentId)
    .is('session_id', null)
    .select('session_id');
  if (claimErr) {
    logger.error('[Assign] Claim failed', {
      threadId,
      agentId,
      candidateSessionId,
      source,
      error: claimErr.message,
    });
    return recoverFromWriteFailure(supabase, params, 'claim');
  }
  if (claimed && claimed.length > 0) {
    logger.info('[Assign] Thread participant bound', {
      threadId,
      agentId,
      sessionId: candidateSessionId,
      previousSessionId: null,
      boundVia: 'claim',
      source,
    });
    return {
      sessionId: candidateSessionId,
      rerouted: false,
      boundVia: 'claim',
      stampPersisted: true,
    };
  }

  // Lost the claim — a concurrent dispatch won. Reread and route to the winner.
  const { data: after } = await supabase
    .from('inbox_thread_participants')
    .select('session_id')
    .eq('thread_id', threadId)
    .eq('agent_id', agentId)
    .maybeSingle();
  const winner: string | null = after?.session_id ?? null;
  if (winner) {
    logger.info('[Assign] Lost claim race — rerouting to winner', {
      threadId,
      agentId,
      winnerSessionId: winner,
      candidateSessionId,
      source,
    });
    return { sessionId: winner, rerouted: true, boundVia: 'continuity', stampPersisted: true };
  }
  // No row at all (participant not registered yet) — deliver to candidate;
  // the send path registers participants before dispatch, so this is a
  // defensive fallback, not an expected state.
  logger.warn('[Assign] No participant row to stamp', {
    threadId,
    agentId,
    candidateSessionId,
    source,
  });
  return {
    sessionId: candidateSessionId,
    rerouted: false,
    boundVia: 'claim',
    stampPersisted: false,
  };
}
