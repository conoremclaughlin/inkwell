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
}

interface SessionRow {
  id: string;
  ended_at: string | null;
  lifecycle: string | null;
}

async function isSessionDead(supabase: any, sessionId: string): Promise<boolean> {
  const { data } = (await supabase
    .from('sessions')
    .select('id, ended_at, lifecycle')
    .eq('id', sessionId)
    .maybeSingle()) as { data: SessionRow | null };
  // Missing row = dead. Current terminal gate is ended_at/failed; when the
  // session-lifecycle-model migration lands (archived_at), this helper is the
  // single place to update.
  if (!data) return true;
  return !!data.ended_at || data.lifecycle === 'failed';
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
      return { sessionId: candidateSessionId, rerouted: false, boundVia: 'already-bound' };
    }
    const boundVia: BoundVia = currentStamp ? 'explicit-retarget' : 'explicit-anchor';
    const { error } = await supabase
      .from('inbox_thread_participants')
      .update({ session_id: candidateSessionId })
      .eq('thread_id', threadId)
      .eq('agent_id', agentId);
    if (error) {
      logger.error('[Assign] Anchor stamp failed', {
        threadId,
        agentId,
        candidateSessionId,
        source,
        error: error.message,
      });
      // Fall through with the candidate — delivery proceeds, stamp is retried
      // on the next send/trigger for this thread.
      return { sessionId: candidateSessionId, rerouted: false, boundVia };
    }
    logger.info('[Assign] Thread participant bound', {
      threadId,
      agentId,
      sessionId: candidateSessionId,
      previousSessionId: currentStamp,
      boundVia,
      source,
    });
    return { sessionId: candidateSessionId, rerouted: false, boundVia };
  }

  // Continuity: live stamp wins; candidate is discarded.
  if (currentStamp) {
    if (currentStamp === candidateSessionId) {
      return { sessionId: currentStamp, rerouted: false, boundVia: 'already-bound' };
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
      return { sessionId: currentStamp, rerouted: true, boundVia: 'continuity' };
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
      return { sessionId: candidateSessionId, rerouted: false, boundVia: 'rebind-dead-session' };
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
        return { sessionId: winner, rerouted: true, boundVia: 'continuity' };
      }
      return { sessionId: candidateSessionId, rerouted: false, boundVia: 'rebind-dead-session' };
    }
    logger.info('[Assign] Thread participant bound', {
      threadId,
      agentId,
      sessionId: candidateSessionId,
      previousSessionId: currentStamp,
      boundVia: 'rebind-dead-session',
      source,
    });
    return { sessionId: candidateSessionId, rerouted: false, boundVia: 'rebind-dead-session' };
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
    return { sessionId: candidateSessionId, rerouted: false, boundVia: 'claim' };
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
    return { sessionId: candidateSessionId, rerouted: false, boundVia: 'claim' };
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
    return { sessionId: winner, rerouted: true, boundVia: 'continuity' };
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
  return { sessionId: candidateSessionId, rerouted: false, boundVia: 'claim' };
}
