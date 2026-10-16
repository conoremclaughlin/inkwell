/**
 * The scopes an Inkwell `mcp_access` token can carry, and how to read one.
 *
 * Shared so the API server and the CLI judge a scope the same way. A scope
 * claim is a space-separated set, as refresh exchange writes it, and the
 * narrow scope wins wherever it appears: "mcp:tools mcp:space-turn" is a
 * space-turn token, never a broad one.
 */

/** What every runner and OAuth token has carried so far: the full tool surface. */
export const RUNNER_TOOLS_SCOPE = 'mcp:tools';

/**
 * A turn in a shared conversation. Such a token reaches only the space-turn
 * tools, for its own thread, and every other seam refuses it
 * (ink://specs/inkling-multi-person-groups).
 */
export const SPACE_TURN_SCOPE = 'mcp:space-turn';

function scopeSet(scope: unknown): string[] {
  return typeof scope === 'string' ? scope.split(/\s+/).filter(Boolean) : [];
}

/** Whether a token's scope limits it to a space turn, wherever the scope appears in the set. */
export function isSpaceTurnScope(scope: unknown): boolean {
  return scopeSet(scope).includes(SPACE_TURN_SCOPE);
}

/**
 * Whether a token's scope is the plain tool surface: exactly mcp:tools, and
 * nothing beside it. Runner admission accepts only this, so a mixed
 * "mcp:tools mcp:space-turn" token is refused rather than read as broad, and
 * so is mcp:tools beside any scope added later. Every producer writes exactly
 * mcp:tools today: the OAuth grant, the runner signer, refresh records and
 * the column default.
 */
export function isPlainToolsScope(scope: unknown): boolean {
  const scopes = new Set(scopeSet(scope));
  return scopes.size === 1 && scopes.has(RUNNER_TOOLS_SCOPE);
}
