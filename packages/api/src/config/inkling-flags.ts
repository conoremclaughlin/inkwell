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

/**
 * How long one inkling turn may run before it is stopped, with everything
 * it started: INKLING_TURN_TIMEOUT_MS when it is a positive whole number,
 * else no ceiling. A turn still producing output is not killed on
 * wall-clock (Conor, 2026-10-04, the turn-timeouts thread); the runner's
 * silence timeout and the owner's Stop end a stuck one. This was five
 * minutes for the first test. There is no cap on how many turns an inkling
 * takes either (Conor, Oct 4 2026, 5:00 PM); usage limits will be monthly
 * token allowances (ink://specs/inkling-model-access).
 */
export function inklingTurnTimeoutMs(source: EnvSource = process.env): number | undefined {
  const value = positiveInt(source.INKLING_TURN_TIMEOUT_MS, 0);
  return value > 0 ? value : undefined;
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The tools that may use an inkling owner's connected accounts (Google
 * today: Gmail, Calendar, Docs, Drive, Sheets) during an inkling's turn.
 *
 * INK_INKLING_ACCOUNT_TOOLS lists them by tool name, comma-separated, e.g.
 * `list_email_labels,list_calendar_events`. Unset or blank is none, which
 * is the default: an inkling's turn gets no connected-account token at all
 * until someone names the tools it may use. There is no wildcard, and an
 * entry that isn't a tool name is left out, so a typo can only shrink the
 * list, never widen it. `malformed` says where each one was, never its
 * value.
 */
export function inklingAccountToolAllowlist(source: EnvSource = process.env): {
  tools: ReadonlySet<string>;
  malformed: string[];
} {
  const tools = new Set<string>();
  const malformed: string[] = [];
  (source.INK_INKLING_ACCOUNT_TOOLS ?? '').split(',').forEach((raw, i) => {
    const name = raw.trim();
    if (name === '') return;
    if (TOOL_NAME.test(name)) tools.add(name);
    else malformed.push(`INK_INKLING_ACCOUNT_TOOLS entry ${i + 1}`);
  });
  return { tools, malformed };
}

/**
 * How many inklings one person may awaken: INKLING_AWAKEN_CAP, else 2.
 * The cap is counted inside redeem_kindle_token under a per-person lock, so
 * this is the value it is handed, not where it is enforced.
 */
export function inklingAwakenCap(source: EnvSource = process.env): number {
  return positiveInt(source.INKLING_AWAKEN_CAP, DEFAULT_AWAKEN_CAP);
}
