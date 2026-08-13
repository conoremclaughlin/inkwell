/**
 * Terminalize the backend turns that a server shutdown is about to kill.
 *
 * Two things have to be true afterwards, and neither was before:
 *
 *   1. The session must stop claiming to be running. A row left at
 *      `lifecycle: 'running'` reads as "review in progress" to `ink mission`,
 *      to `list_sessions`, and to the agent that requested the work.
 *   2. Somebody has to be told. Silent loss is the worst property here — the
 *      sender waits on a reply that no longer has a process behind it.
 *
 * What it deliberately does NOT do is set `ended_at`. The threadKey lookup
 * filters on `ended_at IS NULL`, so stamping it would make the session
 * unfindable and the next trigger would start cold. An interrupted turn should
 * come back to its own context — which is exactly what happened by accident
 * when Lumen's pr:485 session was re-triggered and resumed with its history
 * intact. `status: 'resumable'` makes that the designed behaviour.
 */

import { logger } from '../../utils/logger.js';
import { sendTriggerFailureNotice } from '../trigger-failure-notice.js';
import type { ActiveRun } from './active-runs.js';

// Same loose client shape the trigger-failure path already accepts; session
// metadata is JSONB and not usefully typed at this call depth.
/* eslint-disable @typescript-eslint/no-explicit-any */

export const INTERRUPT_REASON = 'server-shutdown';

/**
 * What we were able to establish about the session, which decides what the
 * notice is allowed to promise.
 *
 * - `interrupted` — the row was running and we moved it to idle/resumable.
 * - `finalized-elsewhere` — it left `running` under its own power before we
 *   got there. That covers a child's own `completed`/`failed`, and equally a
 *   normal finalizer writing `idle`. Named for what we observed rather than
 *   `already-terminal`, which claimed more than a zero-row match proves
 *   (Lumen, PR #490 round 3).
 * - `unknown` — we could not read it, could not write it, the row is gone, or
 *   it still reads as running after our conditional write matched nothing.
 *   Deliberately NOT folded into the above: asserting a session finished when
 *   we could not tell is its own false statement.
 */
export type InterruptState = 'interrupted' | 'finalized-elsewhere' | 'unknown';

export interface InterruptOutcome {
  sessionId: string;
  state: InterruptState;
  /**
   * The bookkeeping write landed. For a normal run that means the row moved
   * off `running`; for an already-terminal one it means only the metadata
   * breadcrumb was recorded.
   */
  marked: boolean;
  /** Someone was told. False when the run had no thread to post into. */
  noticed: boolean;
  /** Convenience alias for `state === 'finalized-elsewhere'`. */
  alreadyTerminal: boolean;
}

/**
 * Write the interruption breadcrumb without touching lifecycle, checking that
 * it actually hit a row.
 *
 * `.select('id')` is not decoration: an update matching zero rows returns no
 * error, so an unchecked write on a missing session would be reported as
 * successful bookkeeping that never happened.
 */
async function writeBreadcrumb(
  client: any,
  sessionId: string,
  metadata: Record<string, unknown>
): Promise<boolean> {
  const { data, error } = await client
    .from('sessions')
    .update({ metadata })
    .eq('id', sessionId)
    .select('id');

  if (error) {
    logger.error('[Shutdown] Failed to record interruption breadcrumb', {
      sessionId,
      error: error.message,
    });
    return false;
  }
  return Boolean(data && data.length > 0);
}

/**
 * Did this session already terminalize itself before the process died?
 *
 * An in-flight child can call `update_session_state(status: 'completed')` and
 * then be killed before it exits. That stamps `ended_at`, so writing
 * idle/resumable over the top would produce a session that claims to be
 * resumable while `findByThreadKey` — which filters `ended_at IS NULL` —
 * refuses to return it. The notice would promise a resumption that cannot
 * happen (Lumen, PR #490 — P2).
 *
 * Rather than clearing `ended_at` and resurrecting a session the agent
 * declared finished, leave terminal rows exactly as they are. They are not
 * the silent case: they already say what happened.
 */
export function isAlreadyTerminal(row: {
  lifecycle?: string | null;
  ended_at?: string | null;
}): boolean {
  return row.lifecycle === 'completed' || row.lifecycle === 'failed' || Boolean(row.ended_at);
}

function noticeContent(run: ActiveRun, outcome: InterruptOutcome): string {
  const thread = run.threadKey ? ` on \`${run.threadKey}\`` : '';
  const head =
    `⚠️ ${run.agentId}'s turn${thread} was cut short — the Inkwell server shut ` +
    `down while the ${run.backend} process was still running.`;

  // Each branch promises only what the state it left behind can deliver.
  if (outcome.state === 'unknown') {
    return (
      `${head}\n\nThe session's state could not be updated during shutdown, so ` +
      `it may still read as running even though nothing is. Treat its status as ` +
      `unreliable and re-trigger the thread rather than waiting on it.`
    );
  }

  if (outcome.state === 'finalized-elsewhere') {
    return (
      `${head}\n\nThe session had already left the running state on its own, so ` +
      `it is left as-is rather than reopened. Any reply it was mid-way through ` +
      `sending may not have arrived — check before assuming it did.`
    );
  }

  return (
    `${head}\n\nNo reply was produced. The session is resumable and keeps its ` +
    `context — re-trigger the thread to pick it up from where it stopped.`
  );
}

/**
 * Move one session off `running`, or establish that we must not.
 *
 * Extracted so that every path — including the ones that decline to write —
 * still returns to the caller and gets a notice. An early return from inside
 * the try block silently skipped notification for already-terminal sessions,
 * which is the failure this whole PR is about.
 */
async function transitionSession(
  client: any,
  sessionId: string
): Promise<{ state: InterruptState; marked: boolean }> {
  let metadata: Record<string, unknown>;

  try {
    // Read-modify-write, because metadata is a single JSONB column and a blind
    // write drops everything else the session carries. lifecycle and ended_at
    // ride along so the terminal check costs no extra round-trip.
    const { data: existing, error: readError } = await client
      .from('sessions')
      .select('metadata, lifecycle, ended_at')
      .eq('id', sessionId)
      .maybeSingle();

    if (readError) {
      // Fail CLOSED. Treating an unreadable row as non-terminal would let us
      // write idle/resumable over a session that had already completed — the
      // exact corruption this function exists to avoid (Lumen, PR #490 round
      // 2). Declining to write is the recoverable direction, and 'unknown'
      // keeps us from claiming in the notice that we know which it was.
      logger.error('[Shutdown] Could not read session; leaving state untouched', {
        sessionId,
        error: readError.message,
      });
      return { state: 'unknown', marked: false };
    }

    metadata = {
      ...((existing?.metadata as Record<string, unknown>) || {}),
      interruptedAt: new Date().toISOString(),
      interruptedReason: INTERRUPT_REASON,
    };

    if (!existing) {
      logger.error('[Shutdown] Session row not found; nothing to terminalize', { sessionId });
      return { state: 'unknown', marked: false };
    }

    if (isAlreadyTerminal(existing)) {
      return {
        state: 'finalized-elsewhere',
        marked: await writeBreadcrumb(client, sessionId, metadata),
      };
    }

    // Conditional write. The predicates are evaluated atomically with the
    // update by Postgres, which is what closes the read-then-write race: if
    // the child stamped completion between the read above and this statement,
    // it matches zero rows instead of overwriting a terminal state with a
    // resumable one.
    const { data: changed, error } = await client
      .from('sessions')
      .update({ lifecycle: 'idle', status: 'resumable', metadata })
      .eq('id', sessionId)
      .eq('lifecycle', 'running')
      .is('ended_at', null)
      .select('id');

    if (error) {
      logger.error('[Shutdown] Failed to terminalize interrupted session', {
        sessionId,
        error: error.message,
      });
      return { state: 'unknown', marked: false };
    }

    if (!changed || changed.length === 0) {
      // Zero matches does NOT prove the session finished. It could equally be
      // a normal finalizer having written `idle`, or the row being gone. Go
      // and look rather than labelling every miss the same way (Lumen, PR
      // #490 round 3).
      const { data: after, error: recheckError } = await client
        .from('sessions')
        .select('lifecycle, ended_at')
        .eq('id', sessionId)
        .maybeSingle();

      if (recheckError || !after) {
        logger.error('[Shutdown] Could not classify a zero-row interrupt', {
          sessionId,
          error: recheckError?.message ?? 'row not found',
        });
        return { state: 'unknown', marked: false };
      }

      if (after.lifecycle === 'running' && !after.ended_at) {
        // The predicates should have matched. Something is contradicting us,
        // and guessing which way would be inventing a fact.
        logger.error('[Shutdown] Session still reads running after a zero-row interrupt', {
          sessionId,
        });
        return { state: 'unknown', marked: false };
      }

      logger.info('[Shutdown] Session left running under its own power mid-interrupt', {
        sessionId,
        lifecycle: after.lifecycle,
      });
      return {
        state: 'finalized-elsewhere',
        marked: await writeBreadcrumb(client, sessionId, metadata),
      };
    }

    return { state: 'interrupted', marked: true };
  } catch (err) {
    logger.error('[Shutdown] Error terminalizing interrupted session', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { state: 'unknown', marked: false };
  }
}

/**
 * @param runs Snapshot taken before teardown begins.
 * @param timeoutMs Overall bound. Shutdown force-exits at 10s, so this must
 *   finish well inside that or the work it is trying to record is lost to the
 *   very thing it exists to report.
 */
export async function interruptActiveRuns(
  client: any,
  runs: ActiveRun[],
  timeoutMs = 3_000,
  drained = true
): Promise<InterruptOutcome[]> {
  if (runs.length === 0) return [];

  logger.warn('[Shutdown] Interrupting in-flight backend turns', {
    count: runs.length,
    sessions: runs.map((r) => r.sessionId),
  });

  const work = runs.map(async (run): Promise<InterruptOutcome> => {
    const outcome: InterruptOutcome = {
      sessionId: run.sessionId,
      state: 'unknown',
      marked: false,
      noticed: false,
      alreadyTerminal: false,
    };

    const { state, marked } = await transitionSession(client, run.sessionId);
    outcome.marked = marked;

    // A drain that timed out means a lifecycle write may still be in flight
    // and could land on top of what we just wrote. We cannot claim the
    // session is cleanly resumable when something might contradict it a
    // moment later, so the honest report is 'unknown' (Lumen, PR #490 round
    // 3). A session that had already left `running` is unaffected: we did not
    // write its lifecycle either way.
    outcome.state = !drained && state === 'interrupted' ? 'unknown' : state;
    outcome.alreadyTerminal = outcome.state === 'finalized-elsewhere';

    // No thread means no addressable audience — a bare trigger has no sender
    // to post back to. The logs in transitionSession are the record there.
    if (!run.threadKey) return outcome;

    try {
      const result = await sendTriggerFailureNotice(client, {
        userId: run.userId,
        // The notice is FOR whoever asked; absent a sender it still belongs in
        // the thread, where every participant sees it.
        fromAgentId: run.senderAgentId || run.agentId,
        toAgentId: run.agentId,
        threadKey: run.threadKey,
        subject: `Turn interrupted — ${run.agentId} (${run.backend})`,
        content: noticeContent(run, outcome),
        metadata: {
          kind: 'session_interrupted',
          reason: INTERRUPT_REASON,
          sessionId: run.sessionId,
          backend: run.backend,
          state: outcome.state,
          alreadyTerminal: outcome.alreadyTerminal,
        },
      });
      outcome.noticed = result.ok;
    } catch (err) {
      logger.error('[Shutdown] Failed to post interruption notice', {
        sessionId: run.sessionId,
        threadKey: run.threadKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return outcome;
  });

  // Partial reporting beats none: on timeout the sessions that did get marked
  // stay marked, and shutdown proceeds rather than hitting the force-kill.
  const timeout = new Promise<InterruptOutcome[]>((resolve) =>
    setTimeout(() => {
      logger.error('[Shutdown] Interruption bookkeeping timed out', { timeoutMs });
      resolve([]);
    }, timeoutMs).unref()
  );

  return Promise.race([Promise.all(work), timeout]);
}
