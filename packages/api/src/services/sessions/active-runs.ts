/**
 * In-process registry of backend turns this server is currently running.
 *
 * The API server spawns agent CLIs as its own children, so when it goes down
 * they go with it. Nothing ran to write a terminal state, which left rows
 * sitting at `lifecycle: 'running'` forever with a null `backendSessionId` —
 * indistinguishable from a review still in progress. Three of Lumen's reviews
 * were lost that way on 2026-08-12 and nobody, sender or recipient, was told.
 *
 * A `tsx --watch` restart is the common trigger, so this fires most often
 * during ordinary development: merging to main restarts the server, which
 * kills whatever reviews are in flight. Shipping faster lost more work.
 *
 * ## Why there is a handshake and not just a Set
 *
 * Two writers race for the same row: the turn's own lifecycle writes, and
 * shutdown's interruption write. Tracking membership alone is not enough,
 * because membership says nothing about writes that are still in flight
 * (Lumen, PR #490 rounds 1-2). Two interleavings break a naive registry:
 *
 *   - Shutdown snapshots and writes `idle`, then the turn's still-pending
 *     `running` write lands on top and the zombie is back.
 *   - A turn registers after shutdown took its one-time snapshot, and is
 *     never seen at all.
 *
 * So intake closes first, then in-flight state writes are drained, and only
 * then is the snapshot taken. After `closeIntake()` no new run can register,
 * and after the drain no lifecycle write is outstanding — which makes the
 * interruption write the last one to touch the row.
 *
 * The registry is deliberately in-process and not persisted. Its whole job is
 * to answer "which turns die if this process dies", which is only ever a
 * question about *this* process. A second server on another port owns its own
 * children and must not terminalize them.
 */

import { logger } from '../../utils/logger.js';

export interface ActiveRun {
  sessionId: string;
  userId: string;
  /** The agent whose turn is executing. */
  agentId: string;
  backend: string;
  /** Present for thread-borne work — where the interruption notice goes. */
  threadKey?: string;
  /** Who asked for this run; the agent left waiting when it dies. */
  senderAgentId?: string;
  startedAt: number;
  /**
   * Set when the runner promise settled — the child process has exited and
   * only bookkeeping remains. A registered run WITHOUT this is a turn that
   * dies with the server; a registered run WITH it is a finished turn whose
   * terminal write has not landed (pr:558, 2026-09-01: a finalization write
   * lost to a transient DB error left a run registered for 14 hours, and
   * shutdown then reported a process "still running" that had exited at
   * 00:23). Shutdown reporting must not conflate the two.
   */
  runnerSettledAt?: number;
  /**
   * What the turn's unrecorded terminal state WAS MEANT to be. A settled run
   * is not necessarily a successful one — a runner can return success:false
   * or throw and then have its `failed` write lost the same way (Lumen, PR
   * #563 P1). Shutdown must preserve the intended outcome, not stamp every
   * settled run as a quiet success.
   */
  settledOutcome?: 'succeeded' | 'failed';
}

const active = new Map<string, ActiveRun>();

/** Lifecycle writes that have been issued but not yet settled. */
const inFlightWrites = new Set<Promise<unknown>>();

let intakeOpen = true;

/**
 * Called immediately before a turn's `running` write is issued.
 *
 * Returns false when intake has closed — the process is shutting down and
 * anything started now is guaranteed to be killed before it finishes. Callers
 * must not proceed with the turn.
 */
export function registerActiveRun(run: ActiveRun): boolean {
  if (!intakeOpen) {
    logger.warn('[ActiveRuns] Refusing to register a run during shutdown', {
      sessionId: run.sessionId,
      agentId: run.agentId,
    });
    return false;
  }
  active.set(run.sessionId, run);
  return true;
}

/**
 * Called once a turn's terminal state is DURABLY written — not when the runner
 * returns. A row still saying `running` must stay registered, or shutdown will
 * skip the very session that needs reporting.
 */
export function clearActiveRun(sessionId: string): void {
  active.delete(sessionId);
}

/**
 * Called the moment the runner promise settles (resolve or reject): the child
 * process is gone; what remains is bookkeeping. Deliberately NOT a clear —
 * the run must stay registered until its terminal state durably persists —
 * but it changes what a shutdown may truthfully claim about the run.
 */
export function markRunnerSettled(sessionId: string, outcome: 'succeeded' | 'failed'): void {
  const run = active.get(sessionId);
  if (run) {
    run.runnerSettledAt = Date.now();
    run.settledOutcome = outcome;
  }
}

export interface DrainResult {
  runs: ActiveRun[];
  /**
   * False when the drain gave up before every outstanding write settled. A
   * racing write may still land after the interruption, so nothing downstream
   * may claim certainty about the state it left behind.
   */
  drained: boolean;
}

/**
 * May a session lifecycle write proceed?
 *
 * False once shutdown has begun. An already-admitted runner can return AFTER
 * the drain snapshot and try to finalize; because `SessionRepository.update`
 * rewrites the whole metadata blob from a snapshot taken at the start of the
 * call, that late write would both override the interruption's lifecycle and
 * erase its breadcrumb (Lumen, PR #490 round 3). Closing intake stops new
 * turns; this stops late writes from turns already in flight.
 *
 * The cost is the backendSessionId link from a turn that finished in that
 * window. That is worth less than the interruption record it would destroy:
 * the session still resumes with its Inkwell-side context.
 */
export function admitStateWrite(sessionId: string): boolean {
  if (!intakeOpen) {
    logger.warn('[ActiveRuns] Refusing a late lifecycle write during shutdown', { sessionId });
    return false;
  }
  return true;
}

/**
 * Wrap a session lifecycle write so the drain can wait for it.
 *
 * Returns the same promise, so callers keep their normal await/catch shape.
 * Rejections are absorbed here only for tracking purposes; the caller still
 * sees them.
 */
export function trackStateWrite<T>(promise: Promise<T>): Promise<T> {
  inFlightWrites.add(promise);
  const forget = () => inFlightWrites.delete(promise);
  promise.then(forget, forget);
  return promise;
}

export function listActiveRuns(): ActiveRun[] {
  return [...active.values()];
}

/**
 * Is this server currently executing a turn for the session? Used by the
 * lease sweep to distinguish "long agentic turn, no heartbeat yet" from
 * "holder is gone" — only the latter forfeits a studio.
 */
export function hasActiveRun(sessionId: string): boolean {
  return active.has(sessionId);
}

export function activeRunCount(): number {
  return active.size;
}

export function isIntakeOpen(): boolean {
  return intakeOpen;
}

/**
 * Shutdown step one: stop accepting new runs, wait for outstanding lifecycle
 * writes to settle, then report what is still in flight.
 *
 * The snapshot is taken AFTER the drain on purpose. Taken before, it would
 * miss a run that registered while writes were settling, and it would race
 * the very writes it is trying to order against.
 *
 * @param timeoutMs Bound on the drain. Shutdown force-exits at 10s, so a slow
 *   or hung write must not consume that budget — on timeout we proceed with
 *   whatever is registered, which is strictly better than reporting nothing.
 */
export async function closeIntakeAndDrain(timeoutMs = 2_000): Promise<DrainResult> {
  intakeOpen = false;
  let drained = true;

  const outstanding = [...inFlightWrites];
  if (outstanding.length > 0) {
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref();
    });

    const settled = await Promise.race([
      Promise.allSettled(outstanding).then(() => 'drained' as const),
      expiry,
    ]);
    if (timer) clearTimeout(timer);

    if (settled === 'timeout') {
      drained = false;
      logger.error('[ActiveRuns] Drain timed out; interrupting against a racing write', {
        outstanding: outstanding.length,
        timeoutMs,
      });
    }
  }

  return { runs: listActiveRuns(), drained };
}

/** Test seam. Not used in production paths. */
export function resetActiveRuns(): void {
  active.clear();
  inFlightWrites.clear();
  intakeOpen = true;
}
