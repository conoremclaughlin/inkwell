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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The owner test's gate: INKLING_OWNER_TEST_USER_ID names the one account
 * that may awaken, name and talk to inklings on this server, as a trusted
 * personal SB with the same reach as the account's other SBs (Lumen
 * 97b1d66a). Unset, or not a UUID, means off: no awakening, no naming, and
 * no inkling turn. It names a user, not just "on", because this server has
 * no owner of its own: every account owns its personal workspace.
 */
export function inklingOwnerTestUserId(source: EnvSource = process.env): string | null {
  const raw = source.INKLING_OWNER_TEST_USER_ID?.trim().toLowerCase();
  return raw && UUID.test(raw) ? raw : null;
}

/** The first test's ceiling on one inkling turn: five minutes. */
export const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How long one inkling turn may run before it is stopped, with everything
 * it started: INKLING_TURN_TIMEOUT_MS, else five minutes.
 */
export function inklingTurnTimeoutMs(source: EnvSource = process.env): number {
  return positiveInt(source.INKLING_TURN_TIMEOUT_MS, DEFAULT_TURN_TIMEOUT_MS);
}

/** The first test's turns per inkling, unless INKLING_TURN_CAP says otherwise. */
export const DEFAULT_TURN_CAP = 20;

/**
 * How many turns one inkling may take in the owner test: INKLING_TURN_CAP,
 * else 20. Counted on the identity before each turn is spawned.
 */
export function inklingTurnCap(source: EnvSource = process.env): number {
  return positiveInt(source.INKLING_TURN_CAP, DEFAULT_TURN_CAP);
}

/**
 * How many inklings one person may awaken: INKLING_AWAKEN_CAP, else 2.
 * The cap is counted inside redeem_kindle_token under a per-person lock, so
 * this is the value it is handed, not where it is enforced.
 */
export function inklingAwakenCap(source: EnvSource = process.env): number {
  return positiveInt(source.INKLING_AWAKEN_CAP, DEFAULT_AWAKEN_CAP);
}
