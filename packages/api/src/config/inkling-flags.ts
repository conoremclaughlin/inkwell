/**
 * Inkling switches, read from the environment when asked rather than once
 * at startup, as heartbeat-flags.ts does, so a test can pass its own source.
 */

type EnvSource = Record<string, string | undefined>;

/** The prototype's awakenings per person (Lumen, PR #722 review). */
export const DEFAULT_AWAKEN_CAP = 2;

/** A positive whole number, or the fallback. */
function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * How many inklings one person may awaken: INKLING_AWAKEN_CAP, else 2.
 * The cap is counted inside redeem_kindle_token under a per-person lock, so
 * this is the value it is handed, not where it is enforced.
 */
export function inklingAwakenCap(source: EnvSource = process.env): number {
  return positiveInt(source.INKLING_AWAKEN_CAP, DEFAULT_AWAKEN_CAP);
}
