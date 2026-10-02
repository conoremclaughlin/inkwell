import { parentOwnsTurn } from '../turn-owner.js';

/** Migrated project hooks outlive the terminal that installed them. Only the
 * bridge's explicitly attached Codex context may use these handlers; server
 * runs and parent-owned provider steps keep their existing lifecycle owner.
 * This is a routing guard, not an authentication boundary. */
export function isCodexMailHookScope(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.INK_CODEX_INKMAIL !== '1' || parentOwnsTurn(env)) return false;
  try {
    const context = JSON.parse(Buffer.from(env.INK_CONTEXT || '', 'base64url').toString());
    return Boolean(
      context &&
      context.cliAttached === true &&
      context.runtime === 'codex' &&
      context.sessionId &&
      context.sessionId === env.INK_SESSION_ID &&
      context.studioId &&
      context.studioId === env.INK_STUDIO_ID &&
      context.sbSlug &&
      context.sbSlug === env.SB_SLUG
    );
  } catch {
    return false;
  }
}
