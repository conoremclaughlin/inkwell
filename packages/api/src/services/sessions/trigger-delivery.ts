/**
 * Trigger delivery check — determines whether the server should skip spawning
 * a new process because a CLI channel plugin is already polling the routed session.
 */

export interface SessionPollRow {
  id: string;
  cli_poll_at: string | null;
  studio_id: string | null;
}

export interface SessionAttachedRow {
  cli_attached: boolean;
  updated_at: string;
}

export interface CliDeliveryCheck {
  skip: boolean;
  source: 'cli_poll_at' | 'cli_attached' | null;
  sessionId: string | null;
}

const CLI_POLL_FRESH_MS = 30_000;
const CLI_STALE_MS = 10 * 60 * 1000;

export function checkPollFreshness(
  pollRow: SessionPollRow | null,
  now: number = Date.now()
): boolean {
  if (!pollRow?.cli_poll_at) return false;
  return now - new Date(pollRow.cli_poll_at).getTime() < CLI_POLL_FRESH_MS;
}

export function checkLegacyAttached(
  attachedRow: SessionAttachedRow | null,
  now: number = Date.now()
): { attached: boolean; stale: boolean } {
  if (!attachedRow?.cli_attached) return { attached: false, stale: false };
  const age = now - new Date(attachedRow.updated_at).getTime();
  const stale = age > CLI_STALE_MS;
  return { attached: true, stale };
}

export function shouldSkipSpawn(
  pollRow: SessionPollRow | null,
  attachedRow: SessionAttachedRow | null,
  now: number = Date.now()
): CliDeliveryCheck {
  const hasFreshPoll = checkPollFreshness(pollRow, now);
  if (hasFreshPoll) {
    return { skip: true, source: 'cli_poll_at', sessionId: pollRow!.id };
  }

  const { attached, stale } = checkLegacyAttached(attachedRow, now);
  if (attached && !stale) {
    return { skip: true, source: 'cli_attached', sessionId: null };
  }

  return { skip: false, source: null, sessionId: null };
}

/**
 * The delivery-decision step of the v18 S3 split (plan → delivery decision →
 * spawn admission). Given a routed session's attachment state and the
 * caller's declared mode, decide HOW the message reaches its session:
 *
 *   inline — a CLI is live on the routed session; the channel plugin
 *            delivers on its next prompt. No process runs, so nothing is
 *            provisioned and neither placement nor the lease holder set
 *            changes.
 *   spawn  — a new process will run; the spawn path's own resolution
 *            (handleMessage → getOrCreateSession WITHOUT planOnly) rechecks
 *            occupancy and atomically provisions + acquires.
 *
 * `forceSpawn` is the explicit mode for callers that always need a fresh
 * process — strategy kickoff/watchdog/resume are self-addressed, and the
 * channel plugin's self-message filter would silently drop an inline
 * delivery. It is threaded from the trigger payload, never rediscovered from
 * attachment state. routeOnly dispatches never reach this decision — the
 * trigger handler returns after assignment, before attachment is consulted.
 */
export type DeliveryDecision =
  | { mode: 'inline'; source: 'cli_poll_at' | 'cli_attached'; sessionId: string | null }
  | { mode: 'spawn'; forced: boolean };

export function decideDelivery(opts: {
  forceSpawn: boolean;
  pollRow: SessionPollRow | null;
  attachedRow: SessionAttachedRow | null;
  now?: number;
}): DeliveryDecision {
  if (opts.forceSpawn) return { mode: 'spawn', forced: true };
  const check = shouldSkipSpawn(opts.pollRow, opts.attachedRow, opts.now ?? Date.now());
  if (check.skip && check.source) {
    return { mode: 'inline', source: check.source, sessionId: check.sessionId };
  }
  return { mode: 'spawn', forced: false };
}
