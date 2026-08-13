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
 * The registry is deliberately in-process and not persisted. Its whole job is
 * to answer "which turns die if this process dies", which is only ever a
 * question about *this* process. A second server on another port owns its own
 * children and must not terminalize them.
 */

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
}

const active = new Map<string, ActiveRun>();

/** Called immediately before a backend turn starts. */
export function registerActiveRun(run: ActiveRun): void {
  active.set(run.sessionId, run);
}

/**
 * Called when a turn finishes, by any route — success, runner throw, timeout.
 * Must run in a `finally`: a turn that ends without deregistering would be
 * reported as interrupted at the next shutdown, which is the same class of
 * lie in the opposite direction.
 */
export function clearActiveRun(sessionId: string): void {
  active.delete(sessionId);
}

export function listActiveRuns(): ActiveRun[] {
  return [...active.values()];
}

export function activeRunCount(): number {
  return active.size;
}

/** Test seam. Not used in production paths. */
export function resetActiveRuns(): void {
  active.clear();
}
