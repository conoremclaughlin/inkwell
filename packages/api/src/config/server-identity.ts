/**
 * The slug this server routes as.
 *
 * Deliberately its own module with NO side effects. server.ts ends in an
 * unconditional startServer(...) at module scope, so anything that imports it
 * starts a server — a test that reached in for this resolver would try to bind
 * the real port and open the real channel connections (Lumen, PR #635).
 *
 * SB_SLUG is the documented variable; AGENT_ID is its pre-rename name, still in
 * the environment of anything started before the rename. The startup banner and
 * the routing configuration MUST read this same function — they drifted once,
 * so the banner printed one SB while the no-channel-route fallback dispatched
 * to another.
 */
export function resolveServerSbSlug(): string {
  return process.env.SB_SLUG || process.env.AGENT_ID || 'myra';
}
