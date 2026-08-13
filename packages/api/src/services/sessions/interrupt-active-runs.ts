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

export interface InterruptOutcome {
  sessionId: string;
  /**
   * The bookkeeping write landed. For a normal run that means the row moved
   * off `running`; for an already-terminal one it means only the metadata
   * breadcrumb was recorded.
   */
  marked: boolean;
  /** Someone was told. False when the run had no thread to post into. */
  noticed: boolean;
  /**
   * The row had already reached a terminal state under its own power, so its
   * lifecycle was left alone. See `isAlreadyTerminal`.
   */
  alreadyTerminal: boolean;
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

function noticeContent(run: ActiveRun, alreadyTerminal: boolean): string {
  const thread = run.threadKey ? ` on \`${run.threadKey}\`` : '';
  const head =
    `⚠️ ${run.agentId}'s turn${thread} was cut short — the Inkwell server shut ` +
    `down while the ${run.backend} process was still running.`;

  // Only promise resumption where the state can actually deliver it.
  return alreadyTerminal
    ? `${head}\n\nThe session had already recorded a terminal state, so it is ` +
        `left as-is rather than reopened. Any reply it was mid-way through ` +
        `sending may not have arrived — check before assuming it did.`
    : `${head}\n\nNo reply was produced. The session is resumable and keeps its ` +
        `context — re-trigger the thread to pick it up from where it stopped.`;
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
  timeoutMs = 3_000
): Promise<InterruptOutcome[]> {
  if (runs.length === 0) return [];

  logger.warn('[Shutdown] Interrupting in-flight backend turns', {
    count: runs.length,
    sessions: runs.map((r) => r.sessionId),
  });

  const work = runs.map(async (run): Promise<InterruptOutcome> => {
    const outcome: InterruptOutcome = {
      sessionId: run.sessionId,
      marked: false,
      noticed: false,
      alreadyTerminal: false,
    };

    try {
      // Read-modify-write: metadata is a single JSONB column, so a blind write
      // would drop everything else the session is carrying. The lifecycle and
      // ended_at come back in the same read so the terminal check below costs
      // no extra round-trip.
      const { data: existing } = await client
        .from('sessions')
        .select('metadata, lifecycle, ended_at')
        .eq('id', run.sessionId)
        .maybeSingle();

      outcome.alreadyTerminal = isAlreadyTerminal(existing || {});

      const { error } = await client
        .from('sessions')
        .update({
          // A row that terminalized itself keeps its own account of what
          // happened; only the metadata breadcrumb is added.
          ...(outcome.alreadyTerminal ? {} : { lifecycle: 'idle', status: 'resumable' }),
          metadata: {
            ...((existing?.metadata as Record<string, unknown>) || {}),
            interruptedAt: new Date().toISOString(),
            interruptedReason: INTERRUPT_REASON,
          },
        })
        .eq('id', run.sessionId);

      if (error) {
        logger.error('[Shutdown] Failed to terminalize interrupted session', {
          sessionId: run.sessionId,
          error: error.message,
        });
      } else {
        outcome.marked = true;
      }
    } catch (err) {
      logger.error('[Shutdown] Error terminalizing interrupted session', {
        sessionId: run.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // No thread means no addressable audience — a bare trigger has no sender
    // to post back to. The log above is the record in that case.
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
        content: noticeContent(run, outcome.alreadyTerminal),
        metadata: {
          kind: 'session_interrupted',
          reason: INTERRUPT_REASON,
          sessionId: run.sessionId,
          backend: run.backend,
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
