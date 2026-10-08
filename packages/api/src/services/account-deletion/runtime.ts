/**
 * Where the deletion worker runs (ink://specs/account-deletion v6 §2).
 *
 * Only in the main server: it is configured there at startup, beside the
 * heartbeat service whose flags already decide which process owns
 * background work, and it runs on that heartbeat and when a request is
 * made. A server it is not configured in (a worktree or test server) never
 * advances a deletion, though it still refuses a closing account's work:
 * every server closes the gates of deletions in progress at startup.
 *
 * One run at a time: a nudge during a run asks for another after it.
 */

import { logger } from '../../utils/logger';
import { processDeletions, type DeletionDeps } from './worker';

let deps: DeletionDeps | undefined;
let running: Promise<void> | undefined;
let again = false;

export function configureDeletionWorker(next: DeletionDeps | undefined): void {
  deps = next;
}

export function deletionWorkerConfigured(): boolean {
  return deps !== undefined;
}

/** Advance pending deletions now, unless this server does not run them. */
export function nudgeDeletionWorker(): Promise<void> {
  if (!deps) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  const current = deps;
  running = (async () => {
    try {
      do {
        again = false;
        await processDeletions(current);
      } while (again);
    } catch (error) {
      logger.error('[AccountDeletion] The worker failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = undefined;
    }
  })();
  return running;
}
