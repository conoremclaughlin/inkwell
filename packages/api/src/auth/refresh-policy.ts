/**
 * How long a refresh grant lives, and how that is measured.
 *
 * Its own module on purpose. These constants are needed by the OAuth provider
 * and the admin routes as well as by pcp-tokens, and many suites mock
 * '../auth/pcp-tokens' wholesale — so exporting them from there would make
 * every new constant a broken mock in seven unrelated test files.
 *
 * A grant has TWO deadlines, both enforced on every exchange:
 *
 *   IDLE      — the stored `expires_at`, pushed to now + REFRESH_IDLE_DAYS each
 *               time the grant is used. Stop calling and it dies in a week.
 *   ABSOLUTE  — `created_at` + REFRESH_ABSOLUTE_DAYS, which sliding can never
 *               push past, so re-authentication comes eventually regardless.
 */

/** Sliding window: a grant unused for this long is dead. */
export const REFRESH_IDLE_DAYS = 7;

/** Hard ceiling measured from issue; sliding cannot exceed it. */
export const REFRESH_ABSOLUTE_DAYS = 90;

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Refuse a lifetime pairing that would make the idle window unreachable.
 * Called by each caller with its own access-token lifetime, so the two cannot
 * drift apart in different files without something saying so.
 */
export function assertRefreshWindowIsReachable(
  accessTokenLifetimeSeconds: number,
  context: string
): void {
  const accessDays = accessTokenLifetimeSeconds / (24 * 60 * 60);
  if (accessDays * 2 >= REFRESH_IDLE_DAYS) {
    throw new Error(
      `${context}: access-token lifetime (${accessDays.toFixed(2)}d) is not comfortably ` +
        `inside the ${REFRESH_IDLE_DAYS}d refresh idle window. A client refreshes only when ` +
        `its access token expires, so this pairing would expire grants before they are used. ` +
        `Shorten the access-token lifetime or lengthen REFRESH_IDLE_DAYS.`
    );
  }
}

/**
 * The new `expires_at` for a grant being used at `now`: one idle window ahead,
 * clamped to the absolute deadline.
 *
 * `createdAt` anchors the absolute deadline. A legacy row without one cannot
 * have its ceiling computed, so its ORIGINAL expiry becomes the ceiling — such
 * a grant can shorten but never extend, which is the conservative direction.
 */
export function slidingExpiry(params: {
  now: Date;
  createdAt: string | null | undefined;
  currentExpiresAt: string;
  idleDays?: number;
  absoluteDays?: number;
}): { expiresAt: Date; atAbsoluteCeiling: boolean } {
  const idleDays = params.idleDays ?? REFRESH_IDLE_DAYS;
  const absoluteDays = params.absoluteDays ?? REFRESH_ABSOLUTE_DAYS;

  const ceiling = params.createdAt
    ? new Date(new Date(params.createdAt).getTime() + absoluteDays * DAY_MS)
    : new Date(params.currentExpiresAt);

  const slid = new Date(params.now.getTime() + idleDays * DAY_MS);
  const atCeiling = slid.getTime() > ceiling.getTime();
  return { expiresAt: atCeiling ? ceiling : slid, atAbsoluteCeiling: atCeiling };
}
