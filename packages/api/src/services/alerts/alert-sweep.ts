/**
 * Scheduling for the alert staleness sweep.
 *
 * This lives apart from AlertDispatchService because the thing most worth
 * testing here is not what the sweep does — that is sweepStaleSources() — but
 * whether it runs at all, and on what terms. The first version of this feature
 * shipped a correct sweep that nothing ever called (PR #539, Lumen): the
 * liveness half of the schema was inert, and no test could have noticed,
 * because a scheduler buried in server startup has no seam to assert against.
 *
 * So the seam is here.
 */

import { logger } from '../../utils/logger';

/** How often to sweep when the operator has expressed no preference. */
export const DEFAULT_SWEEP_SECONDS = 300;

/**
 * Resolve the configured interval into milliseconds, or null for "disabled".
 *
 * Absent → the default. Explicitly zero or negative → disabled, which is a
 * legitimate configuration (isolated test servers must not sweep; the main
 * server owns it, and two sweeps against the shared database means duplicate
 * incidents). Anything unparseable is treated as absent rather than as
 * disabled — a typo should not silently switch monitoring off.
 */
export function resolveSweepIntervalMs(configured: number | string | undefined): number | null {
  if (configured === undefined || configured === null || configured === '') {
    return DEFAULT_SWEEP_SECONDS * 1000;
  }

  const seconds = Number(configured);
  if (!Number.isFinite(seconds)) {
    logger.warn(
      `Ignoring unparseable ALERT_STALENESS_SWEEP_SECONDS=${String(configured)}; ` +
        `using default ${DEFAULT_SWEEP_SECONDS}s`
    );
    return DEFAULT_SWEEP_SECONDS * 1000;
  }

  return seconds <= 0 ? null : seconds * 1000;
}

export interface SweepRunner {
  sweepStaleSources(userId?: string): Promise<{ checked: number; raised: number }>;
}

/**
 * Start the sweep ticker. Returns the timer so the caller can clear it on
 * shutdown, or null when sweeping is disabled.
 *
 * Ticks never overlap. Each pass raises incidents and stamps stale_alerted_at,
 * so two concurrent passes can both observe a source as un-alerted and raise
 * it twice — the duplicate-notification failure the whole dedupe design exists
 * to prevent, reintroduced by the monitor itself.
 */
export function startStalenessSweep(
  alerts: SweepRunner,
  configuredSeconds: number | string | undefined
): NodeJS.Timeout | null {
  const intervalMs = resolveSweepIntervalMs(configuredSeconds);

  if (intervalMs === null) {
    logger.info('Alert staleness sweep disabled (ALERT_STALENESS_SWEEP_SECONDS <= 0)');
    return null;
  }

  let inFlight = false;

  const timer = setInterval(() => {
    if (inFlight) {
      logger.warn('Alert staleness sweep still running; skipping this tick');
      return;
    }
    inFlight = true;
    alerts
      .sweepStaleSources()
      .then(({ checked, raised }) => {
        if (raised > 0) {
          logger.info(`Alert staleness sweep raised ${raised} of ${checked} sources`);
        }
      })
      .catch((err) => logger.error('Alert staleness sweep tick failed:', err))
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);

  logger.info(`Alert staleness sweep enabled (every ${Math.round(intervalMs / 1000)}s)`);
  return timer;
}
