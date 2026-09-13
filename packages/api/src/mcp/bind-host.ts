/**
 * Interfaces that are only reachable from this host.
 *
 * Anything else — including 0.0.0.0, which binds every interface — puts the
 * MCP transport on the network.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Whether a bind address is reachable only from this machine.
 *
 * The MCP transport binds loopback by default (`MCP_BIND_HOST`), deliberately.
 * Local MCP clients are configured in `.mcp.json` without an Authorization
 * header, and `MCP_REQUIRE_OAUTH=false` lets a request with no credentials
 * execute tools — so an off-host bind hands anonymous, user-scoped tool
 * execution to everyone on the network. Containers opt in to `0.0.0.0`
 * explicitly so that exposure is always something someone wrote down.
 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}
