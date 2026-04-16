/**
 * Approval Interceptor
 *
 * Pre-gateway intercept for 2FA permission approval responses.
 * Runs in the platform listener (telegram, whatsapp) BEFORE messages
 * reach agent routing. Verifies platform identity and writes grants
 * directly to the database — no agent is in the approval chain.
 *
 * See ink://specs/2fa-permission-grants for the full design.
 */

import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// Approval response patterns — parsed from human replies
const APPROVAL_PATTERNS: Array<{ pattern: RegExp; action: string }> = [
  { pattern: /^approve\s+always$/i, action: 'allow' },
  { pattern: /^approve\s+(for\s+)?session$/i, action: 'grant-session' },
  { pattern: /^approve$/i, action: 'grant' },
  { pattern: /^yes$/i, action: 'grant' },
  { pattern: /^y$/i, action: 'grant' },
  { pattern: /^deny$/i, action: 'deny' },
  { pattern: /^no$/i, action: 'deny' },
  { pattern: /^n$/i, action: 'deny' },
];

interface ApprovalInterceptResult {
  intercepted: boolean;
  action?: string;
  requestId?: string;
}

/**
 * Check if an incoming platform message is an approval response.
 * If it matches a pending approval request from this user, resolve it
 * and return { intercepted: true }. Otherwise return { intercepted: false }
 * and the message continues to normal routing.
 *
 * @param userId - PCP user ID (resolved from platform identity)
 * @param platformId - Platform-specific identity string (e.g., "telegram:12345")
 * @param text - Message text to check
 * @param replyToMessageId - Telegram reply-to message ID (for threading)
 */
export async function checkApprovalResponse(
  userId: string,
  platformId: string,
  text: string,
  replyToMessageId?: string
): Promise<ApprovalInterceptResult> {
  const trimmed = text.trim();

  // Quick check: does this look like an approval response?
  const match = APPROVAL_PATTERNS.find((p) => p.pattern.test(trimmed));
  if (!match) {
    return { intercepted: false };
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Find the most recent pending approval request for this user
  const { data: pendingRequests, error } = await supabase
    .from('approval_requests')
    .select('id, tool, args, expires_at, metadata')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(5);

  if (error || !pendingRequests?.length) {
    // No pending requests — not an approval response, continue to normal routing
    return { intercepted: false };
  }

  // Match strategy:
  // 1. If reply-to threading available, match by metadata.telegramMessageId
  // 2. Otherwise, use the most recent pending request
  let targetRequest = pendingRequests[0]; // default: most recent

  if (replyToMessageId) {
    const replyMatch = pendingRequests.find(
      (r) =>
        r.metadata &&
        typeof r.metadata === 'object' &&
        'telegramMessageId' in r.metadata &&
        String(r.metadata.telegramMessageId) === replyToMessageId
    );
    if (replyMatch) {
      targetRequest = replyMatch;
    }
  }

  // Resolve the request
  const action = match.action;
  const status = action === 'deny' ? 'denied' : 'granted';
  const grantedBy = `platform:${platformId}`;

  // Build granted_tools from the request's tool pattern
  const grantedTools =
    action !== 'deny'
      ? [targetRequest.tool + (targetRequest.args ? `(${targetRequest.args})` : '')]
      : null;

  const { error: updateError } = await supabase
    .from('approval_requests')
    .update({
      status,
      action,
      granted_tools: grantedTools,
      granted_by: grantedBy,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', targetRequest.id)
    .eq('status', 'pending'); // Optimistic lock — only update if still pending

  if (updateError) {
    logger.error('Failed to resolve approval request', {
      requestId: targetRequest.id,
      error: updateError,
    });
    return { intercepted: false };
  }

  logger.info('Approval request resolved via platform', {
    requestId: targetRequest.id,
    action,
    status,
    grantedBy,
    tool: targetRequest.tool,
  });

  return {
    intercepted: true,
    action,
    requestId: targetRequest.id,
  };
}

/**
 * Send an approval request message to a user's Telegram chat.
 * Called by the approval request API when a new request is created.
 *
 * Returns the Telegram message ID so it can be stored in request metadata
 * for reply-to threading.
 */
export async function sendApprovalRequestToTelegram(
  sendFn: (chatId: string, content: string, options?: { parseMode?: string }) => Promise<void>,
  chatId: string,
  request: {
    id: string;
    tool: string;
    args?: string | null;
    reason?: string | null;
    requestingAgentId: string;
    studioId?: string | null;
    sessionId?: string | null;
    expiresAt: string;
  }
): Promise<void> {
  const toolDisplay = request.args ? `${request.tool}(${request.args})` : request.tool;
  const expiresIn = Math.round((new Date(request.expiresAt).getTime() - Date.now()) / 60000);

  const message =
    `🔐 *Permission request* from ${request.requestingAgentId}:\n\n` +
    `\`${toolDisplay}\`\n\n` +
    (request.reason ? `Reason: ${request.reason}\n` : '') +
    (request.studioId ? `Studio: ${request.studioId}\n` : '') +
    `Expires in: ${expiresIn} min\n\n` +
    `Reply: *approve* / *deny* / *approve session*`;

  await sendFn(chatId, message, { parseMode: 'Markdown' });
}
