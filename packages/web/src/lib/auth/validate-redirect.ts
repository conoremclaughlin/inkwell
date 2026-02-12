/**
 * Validate that an MCP redirect URL points to a trusted origin.
 *
 * The redirect param in the MCP OAuth flow should only ever point to our own
 * MCP server callback. Without validation, a crafted login URL could exfiltrate
 * tokens to an attacker-controlled domain.
 *
 * Trusted origins:
 * - API_URL from env (the MCP server)
 * - localhost/127.0.0.1 on any port (local dev)
 */
export function isAllowedMcpRedirect(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // Allow localhost for local development
  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
    return true;
  }

  // Must be HTTPS in production
  if (parsed.protocol !== 'https:') {
    return false;
  }

  // Check against configured API URL
  const apiUrl = process.env.API_URL;
  if (apiUrl) {
    try {
      const apiOrigin = new URL(apiUrl).origin;
      if (parsed.origin === apiOrigin) {
        return true;
      }
    } catch {
      // Invalid API_URL — fall through to reject
    }
  }

  return false;
}
