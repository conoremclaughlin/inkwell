/**
 * Shell time limits, in seconds (ink://specs/ink-shell-execution-limits, Conor
 * 2026-10-11). Pi's bash has no default timeout, so a command sent without one
 * ran until it exited: on 2026-10-11 one grep over 146 MB of session logs held
 * a messaging turn for 18.5 minutes while the person's next twelve messages
 * queued behind it. When the timeout fires, pi SIGKILLs the command's process
 * group (it spawns the shell detached) and the result says it timed out.
 *
 * That covers what stays in the group. A descendant that starts its own session
 * or process group is out of reach, and so is a background job left running by
 * a command that has already exited.
 */
export const BASH_TIMEOUT_BOUNDS = { defaultSeconds: 600, maxSeconds: 1800 } as const;

export interface BashTimeoutBounds {
  defaultSeconds: number;
  maxSeconds: number;
}

/**
 * The timeout a shell call actually runs with. Anything that isn't a positive
 * finite number of seconds gets the default, including 0, which pi reads as
 * "no timeout". A numeric string counts as its number. Larger requests are
 * clamped to the ceiling.
 */
export function boundedBashTimeout(
  requested: unknown,
  bounds: BashTimeoutBounds = BASH_TIMEOUT_BOUNDS
): number {
  const seconds =
    typeof requested === 'string' && requested.trim() !== '' ? Number(requested) : requested;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return bounds.defaultSeconds;
  }
  return Math.min(seconds, bounds.maxSeconds);
}
