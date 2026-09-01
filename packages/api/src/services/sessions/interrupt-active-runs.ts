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
 * Reason recorded when the turn had FINISHED before shutdown and only its
 * terminal write was lost (pr:558: a finalization write lost to a transient
 * DB error left the row `running` for 14 hours). The turn itself was not
 * interrupted, so it gets its own reason string; the breadcrumb keys stay the
 * same so the strip_interruption_on_running trigger clears both alike.
 */
export const BOOKKEEPING_REASON = 'server-shutdown-after-turn';

/**
 * What we were able to establish about the session, which decides what the
 * notice is allowed to promise.
 *
 * - `interrupted` — the row was running, the child process was still alive,
 *   and we moved the row to lifecycle `interrupted` (resumable).
 * - `finished-unrecorded` — the runner had already settled (child exited);
 *   only the terminal write was missing, so the row moves to plain `idle`.
 *   The turn's reply, if any, is already wherever it was sent — the notice
 *   must not advise resuming work that already happened (pr:558).
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
export type InterruptState =
  | 'interrupted'
  | 'finished-unrecorded'
  | 'finalized-elsewhere'
  | 'unknown';

/** Human-scale duration for the notice: "42m", "14h 33m". */
export function formatTurnAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown time';
  if (ms < 60_000) return 'under a minute';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}

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
 * Write the interruption breadcrumb without touching lifecycle.
 *
 * Re-reads metadata immediately before writing rather than reusing the blob
 * from the caller's earlier read. `metadata` is a single JSONB column, so a
 * write replaces it wholesale — and by the time we get here, a concurrent
 * finalizer may have added keys of its own. Replaying a pre-race snapshot
 * would erase them (Lumen, PR #490 round 4).
 *
 * This is still read-modify-write, not a true atomic merge: PostgREST has no
 * way to express `metadata = metadata || '{...}'::jsonb` without an RPC. The
 * residual window is the round-trip below rather than the whole interruption
 * sequence, and nothing else writes metadata during shutdown now that late
 * lifecycle writes are refused.
 *
 * `.select('id')` is not decoration: an update matching zero rows returns no
 * error, so an unchecked write on a missing session would be reported as
 * successful bookkeeping that never happened.
 */
async function writeBreadcrumb(client: any, sessionId: string, reason: string): Promise<boolean> {
  const { data: fresh, error: readError } = await client
    .from('sessions')
    .select('metadata')
    .eq('id', sessionId)
    .maybeSingle();

  if (readError || !fresh) {
    logger.error('[Shutdown] Could not re-read metadata for breadcrumb', {
      sessionId,
      error: readError?.message ?? 'row not found',
    });
    return false;
  }

  const { data, error } = await client
    .from('sessions')
    .update({
      metadata: {
        ...((fresh.metadata as Record<string, unknown>) || {}),
        interruptedAt: new Date().toISOString(),
        interruptedReason: reason,
      },
    })
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

function noticeContent(
  run: ActiveRun,
  outcome: InterruptOutcome,
  now: number = Date.now()
): string {
  const thread = run.threadKey ? ` on \`${run.threadKey}\`` : '';
  const age = formatTurnAge(now - run.startedAt);

  // A settled runner means the child EXITED before shutdown — the head must
  // not claim a process was running, whatever else we failed to establish
  // (pr:558: a 14-hour-old finished turn was reported as "still running").
  const head = run.runnerSettledAt
    ? `⚠️ ${run.agentId}'s turn${thread} had already finished when the Inkwell ` +
      `server shut down — the ${run.backend} process had exited, but its ` +
      `completion was never recorded.`
    : `⚠️ ${run.agentId}'s turn${thread} was cut short — the Inkwell server shut ` +
      `down while the ${run.backend} process was still running (turn started ` +
      `${age} ago).`;

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

  if (outcome.state === 'finished-unrecorded') {
    if (run.settledOutcome === 'failed') {
      return (
        `${head}\n\nThe turn had FAILED before the shutdown, and its failure ` +
        `was never recorded. The session is now marked failed — a re-trigger ` +
        `on this thread starts fresh rather than resuming it.`
      );
    }
    return (
      `${head}\n\nAny reply it produced should already be on this thread — ` +
      `check above before re-triggering; there may be nothing left to do. The ` +
      `session is idle and usable as-is.`
    );
  }

  return (
    `${head}\n\nNo reply was produced. The session is marked interrupted and ` +
    `keeps its context — re-trigger the thread to pick it up from where it ` +
    `stopped.`
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
  sessionId: string,
  settled: boolean,
  settledOutcome?: 'succeeded' | 'failed'
): Promise<{ state: InterruptState; marked: boolean }> {
  // A settled runner's turn was not interrupted — only its paperwork was
  // lost — so the row gets the terminal state the turn MEANT to write:
  // `idle` for a success, `failed` for a failure (Lumen, PR #563 P1 —
  // stamping every settled run as a quiet success erased failures). An
  // unsettled runner's turn dies with the process: `interrupted`, resumable.
  const reason = settled ? BOOKKEEPING_REASON : INTERRUPT_REASON;
  const settledLifecycle = settledOutcome === 'failed' ? 'failed' : 'idle';
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
      interruptedReason: reason,
    };

    if (!existing) {
      logger.error('[Shutdown] Session row not found; nothing to terminalize', { sessionId });
      return { state: 'unknown', marked: false };
    }

    if (isAlreadyTerminal(existing)) {
      return {
        state: 'finalized-elsewhere',
        marked: await writeBreadcrumb(client, sessionId, reason),
      };
    }

    // Conditional write. The predicates are evaluated atomically with the
    // update by Postgres, which is what closes the read-then-write race: if
    // the child stamped completion between the read above and this statement,
    // it matches zero rows instead of overwriting a terminal state with a
    // resumable one.
    const { data: changed, error } = await client
      .from('sessions')
      .update(
        settled
          ? { lifecycle: settledLifecycle, metadata }
          : { lifecycle: 'interrupted', status: 'resumable', metadata }
      )
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
        marked: await writeBreadcrumb(client, sessionId, reason),
      };
    }

    return { state: settled ? 'finished-unrecorded' : 'interrupted', marked: true };
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
export interface InterruptActivityEntry {
  userId: string;
  agentId: string;
  type: string;
  subtype: string;
  content: string;
  sessionId: string;
  payload: Record<string, unknown>;
}

export async function interruptActiveRuns(
  client: any,
  runs: ActiveRun[],
  timeoutMs = 3_000,
  drained = true,
  opts: { logActivity?: (entry: InterruptActivityEntry) => Promise<unknown> } = {}
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

    const settled = Boolean(run.runnerSettledAt);
    const { state, marked } = await transitionSession(
      client,
      run.sessionId,
      settled,
      run.settledOutcome
    );
    outcome.marked = marked;

    // A drain that timed out means a lifecycle write may still be in flight
    // and could land on top of what we just wrote. We cannot claim the
    // session is cleanly resumable when something might contradict it a
    // moment later, so the honest report is 'unknown' (Lumen, PR #490 round
    // 3). A session that had already left `running` is unaffected: we did not
    // write its lifecycle either way.
    outcome.state =
      !drained && (state === 'interrupted' || state === 'finished-unrecorded') ? 'unknown' : state;
    outcome.alreadyTerminal = outcome.state === 'finalized-elsewhere';

    // The durable per-turn history lives in the activity stream (agent_spawn
    // at start, agent_complete/error at end); an interruption is the one turn
    // ending nothing logs, so record it here. Keyed on the runner NOT having
    // settled — a settled run's completion was already logged when the runner
    // returned — and independent of the row-write outcome above: the child
    // dying with the server is a fact regardless of what we managed to write.
    if (!settled && opts.logActivity) {
      try {
        await opts.logActivity({
          userId: run.userId,
          agentId: run.agentId,
          type: 'error',
          subtype: 'turn_interrupted',
          content: `Backend turn interrupted by server shutdown (${run.backend}${
            run.threadKey ? `, ${run.threadKey}` : ''
          })`,
          sessionId: run.sessionId,
          payload: {
            backend: run.backend,
            threadKey: run.threadKey ?? null,
            turnStartedAt: new Date(run.startedAt).toISOString(),
            reason: INTERRUPT_REASON,
            state: outcome.state,
          },
        });
      } catch (err) {
        logger.warn('[Shutdown] Failed to log turn_interrupted activity', {
          sessionId: run.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

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
          reason: settled ? BOOKKEEPING_REASON : INTERRUPT_REASON,
          sessionId: run.sessionId,
          backend: run.backend,
          state: outcome.state,
          alreadyTerminal: outcome.alreadyTerminal,
          turnStartedAt: new Date(run.startedAt).toISOString(),
          runnerSettledAt: run.runnerSettledAt ? new Date(run.runnerSettledAt).toISOString() : null,
          settledOutcome: run.settledOutcome ?? null,
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
