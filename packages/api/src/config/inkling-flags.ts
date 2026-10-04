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

/** The owner test's accounts: exact user UUIDs, in lowercase. */
export type OwnerTestAllowlist = ReadonlySet<string>;

/**
 * The owner test's gate: the accounts that may awaken, name and talk to
 * their own inklings on this server, each inkling a trusted personal SB
 * with the same reach as that account's other SBs (Lumen 97b1d66a).
 *
 * INKLING_OWNER_TEST_USER_IDS lists them, comma-separated.
 * INKLING_OWNER_TEST_USER_ID, the single account the test began with, is
 * still honoured and joins the list. Every entry must be a whole UUID:
 * there is no wildcard, and an entry that isn't one is left out, so a typo
 * can only shrink the test, never widen it. `malformed` names where each
 * one was (never its value, which would name an account) for the startup
 * log. Nothing listed means off: no awakening, no naming, and no inkling
 * turn. It names users, not just "on", because this server has no owner of
 * its own: every account owns its personal workspace.
 */
export function inklingOwnerTestAllowlist(source: EnvSource = process.env): {
  userIds: OwnerTestAllowlist;
  malformed: string[];
} {
  const userIds = new Set<string>();
  const malformed: string[] = [];
  const take = (raw: string, where: string) => {
    const id = raw.trim().toLowerCase();
    if (id === '') return;
    if (UUID.test(id)) userIds.add(id);
    else malformed.push(where);
  };
  (source.INKLING_OWNER_TEST_USER_IDS ?? '')
    .split(',')
    .forEach((raw, i) => take(raw, `INKLING_OWNER_TEST_USER_IDS entry ${i + 1}`));
  take(source.INKLING_OWNER_TEST_USER_ID ?? '', 'INKLING_OWNER_TEST_USER_ID');
  return { userIds, malformed };
}

/** The owner test's accounts (inklingOwnerTestAllowlist), empty when it is off. */
export function inklingOwnerTestUserIds(source: EnvSource = process.env): OwnerTestAllowlist {
  return inklingOwnerTestAllowlist(source).userIds;
}

/**
 * Whether `userId` is one of the owner test's accounts. Every owner check
 * asks this rather than comparing ids itself. Being in the test lets an
 * account reach its own inklings only: callers still require the inkling's
 * owner and the acting account to be the same one.
 */
export function isInklingOwnerTestUser(
  userId: string,
  allowlist: OwnerTestAllowlist = inklingOwnerTestUserIds()
): boolean {
  return allowlist.has(userId.toLowerCase());
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
