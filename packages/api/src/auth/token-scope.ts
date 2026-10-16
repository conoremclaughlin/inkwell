/**
 * The scopes an `mcp_access` token can carry, and how to read one.
 *
 * Kept apart from ink-tokens.ts so a route can ask what a verified token is
 * allowed to do without importing the signer (several route tests mock that
 * module whole). The definitions live in @inklabs/shared, so the CLI's runner
 * admission judges a scope exactly as the server does.
 */

export {
  RUNNER_TOOLS_SCOPE,
  SPACE_TURN_SCOPE,
  isSpaceTurnScope,
  isPlainToolsScope,
} from '@inklabs/shared';
