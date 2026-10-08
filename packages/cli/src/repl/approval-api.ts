/**
 * 2FA Approval API Client
 *
 * Shared client for creating and polling approval requests via the Inkwell
 * server's HTTP API. The server handles all notification routing (Telegram,
 * WhatsApp) and response interception — the CLI only needs to create the
 * request and poll for status.
 *
 * Used by:
 * - Away-mode approval handler in chat.ts (REPL-level 2FA)
 * - on-tool-approval hook in hooks.ts (PreToolUse 2FA)
 */

import { getValidAccessToken } from '../auth/tokens.js';
import { resolveSlug, readIdentityJson } from '../backends/identity.js';

function getServerUrl(): string {
  return process.env.INK_SERVER_URL || 'http://localhost:3001';
}

function getContextHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  let contextToken = process.env.INK_CONTEXT?.trim();
  if (!contextToken) {
    const sbSlug = resolveSlug();
    if (sbSlug) {
      const identity = readIdentityJson(process.cwd());
      contextToken = Buffer.from(
        JSON.stringify({
          sbSlug,
          studioId: identity?.studioId || 'main',
          cliAttached: true,
        })
      ).toString('base64url');
    }
  }
  if (contextToken) headers['x-ink-context'] = contextToken;
  return headers;
}

export { type ApprovalRequestResult } from '@inklabs/shared/node-host';
import { requestHostedToolApproval } from '@inklabs/shared/node-host';
export async function requestToolApproval(
  options: Parameters<typeof requestHostedToolApproval>[1]
) {
  if (options.signal?.aborted) return { requestId: '', status: 'aborted' as const };
  const serverUrl = getServerUrl();
  const token = await getValidAccessToken(serverUrl);
  return requestHostedToolApproval(
    {
      serverUrl,
      headers: {
        ...getContextHeaders(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    },
    options
  );
}
