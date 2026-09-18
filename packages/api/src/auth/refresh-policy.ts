/**
 * How long a refresh grant lives, and how that is measured.
 *
 * Its own module on purpose. These constants are needed by the OAuth provider
 * and the admin routes as well as by pcp-tokens, and many suites mock
 * '../auth/pcp-tokens' wholesale — so exporting them from there would make
 * every new constant a broken mock in seven unrelated test files.
 *
 * A grant has a FIXED deadline, set when it is issued and never moved. Two
 * values express it and the EARLIER always wins:
 *
 *   STORED    — the `expires_at` column, written once at issue.
 *   ABSOLUTE  — `created_at` + REFRESH_ABSOLUTE_DAYS, recomputed on every
 *               exchange so a row whose stored expiry was set too generously
 *               (or migrated in from an older scheme) still dies on time.
 *
 * Rotation does not extend either one. Re-authentication comes on the grant's
 * original schedule no matter how actively it is used.
 */

/** Hard ceiling measured from issue. Nothing may push a grant past it. */
export const REFRESH_ABSOLUTE_DAYS = 90;

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The deadline actually in force for a grant: the earlier of its stored
 * `expires_at` and `created_at` + REFRESH_ABSOLUTE_DAYS.
 *
 * Earlier-wins in both directions, which is what keeps this from becoming an
 * extension mechanism. A grant issued with a SHORTER stored expiry — a legacy
 * row, or one deliberately issued short — keeps that shorter deadline; the
 * ceiling is a cap, never a floor. A grant whose stored expiry reaches beyond
 * the ceiling is cut back to the ceiling.
 *
 * `createdAt` anchors the ceiling. A legacy row without one cannot have a
 * ceiling computed at all, so its stored expiry stands alone — such a grant can
 * only ever be shorter than the policy, which is the conservative direction.
 */
export function effectiveGrantDeadline(params: {
  createdAt: string | null | undefined;
  currentExpiresAt: string;
  absoluteDays?: number;
}): { expiresAt: Date; atAbsoluteCeiling: boolean } {
  const absoluteDays = params.absoluteDays ?? REFRESH_ABSOLUTE_DAYS;
  const stored = new Date(params.currentExpiresAt);

  if (!params.createdAt) {
    return { expiresAt: stored, atAbsoluteCeiling: false };
  }

  const ceiling = new Date(new Date(params.createdAt).getTime() + absoluteDays * DAY_MS);
  const ceilingWins = ceiling.getTime() < stored.getTime();

  return {
    expiresAt: ceilingWins ? ceiling : stored,
    atAbsoluteCeiling: ceilingWins,
  };
}
