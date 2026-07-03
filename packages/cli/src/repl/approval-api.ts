/**
 * 2FA Approval API Client
 *
 * Shared client for creating and polling approval requests via the PCP
 * server's HTTP API. The server handles all notification routing (Telegram,
 * WhatsApp) and response interception — the CLI only needs to create the
 * request and poll for status.
 *
 * Used by:
 * - Away-mode approval handler in chat.ts (REPL-level 2FA)
 * - on-tool-approval hook in hooks.ts (PreToolUse 2FA)
 */

import { getValidAccessToken } from '../auth/tokens.js';
import { resolveAgentId, readIdentityJson } from '../backends/identity.js';

const DEFAULT_TIMEOUT_SECONDS = 300;
const POLL_INTERVAL_MS = 3000;

function getServerUrl(): string {
  return process.env.INK_SERVER_URL || 'http://localhost:3001';
}

function getContextHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  let contextToken = process.env.INK_CONTEXT?.trim();
  if (!contextToken) {
    const agentId = resolveAgentId();
    if (agentId) {
      const identity = readIdentityJson(process.cwd());
      contextToken = Buffer.from(
        JSON.stringify({
          agentId,
          studioId: identity?.studioId || 'main',
          cliAttached: true,
        })
      ).toString('base64url');
    }
  }
  if (contextToken) headers['x-ink-context'] = contextToken;
  return headers;
}

export interface ApprovalRequestResult {
  requestId: string;
  status: 'granted' | 'denied' | 'expired' | 'timeout' | 'error';
  action?: string;
  grantedTools?: string[];
  error?: string;
}

/**
 * Create an approval request on the PCP server and poll until resolved.
 *
 * The server handles notification routing:
 * - Looks up user's connected platforms (Telegram, WhatsApp) from trusted_users
 * - Sends formatted approval notification with reply-to threading
 * - The approval interceptor catches user responses before agent routing
 *
 * Fails closed: any error during creation or polling results in denial.
 */
export async function requestToolApproval(options: {
  tool: string;
  args?: string;
  reason: string;
  sessionId?: string;
  studioId?: string;
  timeoutSeconds?: number;
  onCreated?: (requestId: string) => void;
  onPoll?: (elapsed: number) => void;
}): Promise<ApprovalRequestResult> {
  const serverUrl = getServerUrl();
  const token = await getValidAccessToken(serverUrl);
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...getContextHeaders(),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  // 1. Create the approval request — server sends platform notifications
  let requestId: string;
  try {
    const resp = await fetch(`${serverUrl}/api/admin/approval-requests`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tool: options.tool,
        args: options.args,
        reason: options.reason,
        sessionId: options.sessionId,
        studioId: options.studioId,
        timeoutSeconds,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      return {
        requestId: '',
        status: 'error',
        error: `Server returned ${resp.status}`,
      };
    }

    const body = (await resp.json()) as { requestId: string };
    requestId = body.requestId;
    options.onCreated?.(requestId);
  } catch (err) {
    return {
      requestId: '',
      status: 'error',
      error: `Could not reach approval server: ${String(err)}`,
    };
  }

  // 2. Poll for resolution
  const maxPollTime = timeoutSeconds * 1000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxPollTime) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    options.onPoll?.(Date.now() - startTime);

    try {
      const statusResp = await fetch(
        `${serverUrl}/api/admin/approval-requests/${requestId}/status`,
        { headers, signal: AbortSignal.timeout(5000) }
      );

      if (!statusResp.ok) continue;

      const status = (await statusResp.json()) as {
        status: string;
        action?: string;
        grantedTools?: string[];
      };

      if (status.status === 'pending') continue;

      if (status.status === 'granted') {
        return {
          requestId,
          status: 'granted',
          action: status.action,
          grantedTools: status.grantedTools,
        };
      }

      return {
        requestId,
        status: status.status as 'denied' | 'expired',
      };
    } catch {
      // Transient error, keep polling
    }
  }

  return { requestId, status: 'timeout' };
}
