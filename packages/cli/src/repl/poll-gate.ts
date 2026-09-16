/**
 * Poll gate — ownership-safe serialization for interval-driven polls.
 *
 * During a PostgREST degradation event, poll ticks fired faster than prior
 * calls returned and stacked 50+ concurrent requests, amplifying the load
 * into a circuit-breaker cascade (PR #385). The gate prevents stacking:
 *
 * - Interval ticks (non-forced) SKIP while a run is in flight or queued.
 * - Forced runs (interactive /inbox, /events) QUEUE behind the in-flight run
 *   instead of overlapping it. Serialization makes early release impossible:
 *   there is no shared flag a second entrant can clear while the first is
 *   still active — each run releases exactly its own hold.
 *
 * Contract for callers: fn must NOT await backend-turn completion. Hold the
 * gate only across fetch/render; schedule turns after the gate releases so
 * polling (and permission-grant delivery) continues during long turns.
 */

export interface PollGateRunOptions {
  /** Queue behind an in-flight run instead of skipping (interactive refresh). */
  force?: boolean;
}

export interface PollGate {
  /** Number of runs in flight or queued. */
  readonly active: number;
  /**
   * Run fn under the gate. Resolves null when skipped (non-forced call while
   * another run is active). Rejections from fn propagate to the caller; the
   * gate itself always releases.
   */
  run<T>(fn: () => Promise<T>, opts?: PollGateRunOptions): Promise<T | null>;
}

export function createPollGate(): PollGate {
  let active = 0;
  let tail: Promise<void> = Promise.resolve();

  return {
    get active() {
      return active;
    },
    run<T>(fn: () => Promise<T>, opts?: PollGateRunOptions): Promise<T | null> {
      if (active > 0 && !opts?.force) {
        return Promise.resolve(null);
      }
      active += 1;
      const result = tail.then(fn);
      // Release exactly this run's hold, success or failure, and keep the
      // chain unpoisoned for the next queued run.
      tail = result.then(
        () => {
          active -= 1;
        },
        () => {
          active -= 1;
        }
      );
      return result;
    },
  };
}
