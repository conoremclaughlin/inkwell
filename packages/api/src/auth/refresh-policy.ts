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
 * How long the secret a rotation just replaced stays redeemable.
 *
 * **PROVISIONAL — not an approved policy value.** #632 R7 is open and the
 * number is Conor's; 60 seconds is the candidate put to him, and everything
 * that reads this constant takes it as a parameter so the choice is one edit.
 *
 * The tradeoff is not softened by the mechanism. Inside this window, anyone
 * holding the previous secret — its legitimate owner retrying, or a thief who
 * captured it — gets the committed successor. A longer window rescues more
 * honest clients and lengthens exactly the same opening. Zero disables the
 * overlap entirely and restores the refuse-everything behaviour.
 */
export const REFRESH_RETRY_OVERLAP_SECONDS = 60;

/**
 * Whether a grant rotated at `rotatedAt` is still inside its overlap window.
 *
 * A missing `rotatedAt` is NOT inside it. A row can carry a previous secret
 * with no timestamp only if something wrote one without the other, and an
 * unknown rotation time cannot be shown to be recent — so it is treated as old.
 */
export function isWithinRetryOverlap(params: {
  rotatedAt: string | null | undefined;
  now: Date;
  overlapSeconds?: number;
}): boolean {
  const overlapSeconds = params.overlapSeconds ?? REFRESH_RETRY_OVERLAP_SECONDS;
  if (overlapSeconds <= 0) return false;
  if (!params.rotatedAt) return false;

  const rotatedAtMs = new Date(params.rotatedAt).getTime();
  if (Number.isNaN(rotatedAtMs)) return false;

  const elapsedMs = params.now.getTime() - rotatedAtMs;
  // A rotation stamped in the future is clock skew, not a fresh rotation.
  // Treat it as inside the window rather than refusing a client for a server
  // clock it has no part in; the window's far edge is what bounds exposure.
  return elapsedMs <= overlapSeconds * 1000;
}

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
