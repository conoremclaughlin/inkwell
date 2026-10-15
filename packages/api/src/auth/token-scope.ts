/**
 * The scopes an `mcp_access` token can carry, and how to read one.
 *
 * Kept apart from ink-tokens.ts so a route can ask what a verified token is
 * allowed to do without importing the signer (several route tests mock that
 * module whole).
 */

/** What every runner and OAuth token has carried so far: the full tool surface. */
export const RUNNER_TOOLS_SCOPE = 'mcp:tools';

/**
 * A turn in a shared conversation. Such a token reaches only the space-turn
 * tools, for its own thread, and every other route refuses it
 * (ink://specs/inkling-multi-person-groups). Nothing mints one yet.
 */
export const SPACE_TURN_SCOPE = 'mcp:space-turn';

/**
 * Whether a token's scope limits it to a space turn.
 *
 * A scope claim is a space-separated set, as exchangeRefreshToken writes it.
 * The narrow scope wins wherever it appears: "mcp:tools mcp:space-turn" is a
 * space-turn token, never a broad one.
 */
export function isSpaceTurnScope(scope: unknown): boolean {
  return typeof scope === 'string' && scope.split(/\s+/).includes(SPACE_TURN_SCOPE);
}
