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
