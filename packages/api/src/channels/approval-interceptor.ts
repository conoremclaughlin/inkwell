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

// ─── Approval Response Patterns ──────────────────────────────────
// Ordered most-specific first. Parsed from human replies on Telegram/WhatsApp.

const APPROVAL_PATTERNS: Array<{ pattern: RegExp; action: string; scope?: string }> = [
  // Scoped persistent grants
  { pattern: /^approve\s+studio$/i, action: 'grant-studio', scope: 'studio' },
  { pattern: /^approve\s+agent$/i, action: 'grant-agent', scope: 'agent' },
  { pattern: /^approve\s+always$/i, action: 'allow', scope: 'agent' },
  // Session scope
  { pattern: /^approve\s+(for\s+)?session$/i, action: 'grant-session' },
  // Batch with numbers: "approve 1,3" or "approve 1, 3"
  { pattern: /^approve\s+([\d,\s]+)$/i, action: 'grant' },
  // Batch: "approve all" / "deny all"
  { pattern: /^approve\s+all$/i, action: 'grant' },
  { pattern: /^deny\s+all$/i, action: 'deny' },
  // Batch deny with numbers: "deny 2"
  { pattern: /^deny\s+([\d,\s]+)$/i, action: 'deny' },
  // Single approval/denial
  { pattern: /^approve$/i, action: 'grant' },
  { pattern: /^yes$/i, action: 'grant' },
  { pattern: /^y$/i, action: 'grant' },
  { pattern: /^deny$/i, action: 'deny' },
  { pattern: /^no$/i, action: 'deny' },
  { pattern: /^n$/i, action: 'deny' },
];

// ─── Types ───────────────────────────────────────────────────────

interface PendingRequest {
  id: string;
  tool: string;
  args: string | null;
  expires_at: string;
  metadata: Record<string, unknown> | null;
  requesting_agent_id: string;
  studio_id: string | null;
  session_id: string | null;
}

export interface ApprovalInterceptResult {
  intercepted: boolean;
  action?: string;
  requestId?: string;
  resolvedRequests?: Array<{ id: string; tool: string; action: string; agentId?: string }>;
}

// ─── Notification Debounce Buffer ────────────────────────────────
// Batches rapid-fire approval notifications into one consolidated message.

interface BufferedRequest {
  id: string;
  userId: string;
  tool: string;
  args?: string | null;
  reason?: string | null;
  requestingAgentId: string;
  studioId?: string | null;
  sessionId?: string | null;
  expiresAt: string;
}

const notificationBuffer = new Map<
  string,
  {
    requests: BufferedRequest[];
    timer: ReturnType<typeof setTimeout>;
  }
>();

const DEBOUNCE_MS = 2000;

/**
 * Parse numbered selections from text like "approve 1,3" → [1, 3]
 */
function parseNumberedSelections(text: string): number[] | null {
  const match = text.match(/^(?:approve|deny)\s+([\d,\s]+)$/i);
  if (!match) return null;
  const nums = match[1]
    .split(/[,\s]+/)
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));
  return nums.length > 0 ? nums : null;
}

/**
 * Check if an incoming platform message is an approval response.
 * If it matches pending approval request(s) from this user, resolve them
 * and return { intercepted: true }. Otherwise return { intercepted: false }
 * and the message continues to normal routing.
 *
 * Supports batch resolution:
 * - "approve all" / "deny all" — resolves all pending requests
 * - "approve 1,3" — resolves specific numbered requests (from batch message)
 * - "approve session" — grants all pending for the session
 * - "approve agent" — grants all pending + marks for persistent agent-level grant
 * - "approve studio" — grants all pending + marks for persistent studio-level grant
 * - "approve" / "yes" — resolves the most recent (or reply-to-threaded) request
 */
export async function checkApprovalResponse(
  userId: string,
  platformId: string,
  text: string,
  replyToMessageId?: string
): Promise<ApprovalInterceptResult> {
  const trimmed = text.trim();

  const match = APPROVAL_PATTERNS.find((p) => p.pattern.test(trimmed));
  if (!match) {
    return { intercepted: false };
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Fetch all pending requests for this user (up to 20)
  const { data: pendingRequests, error } = await supabase
    .from('approval_requests')
    .select('id, tool, args, expires_at, metadata, requesting_agent_id, studio_id, session_id')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(20);

  if (error || !pendingRequests?.length) {
    return { intercepted: false };
  }

  const action = match.action;
  const grantedBy = `platform:${platformId}`;
  const numberedSelections = parseNumberedSelections(trimmed);
  const isAllOrScoped = /^(approve|deny)\s+(all|session|agent|studio|always)$/i.test(trimmed);

  // Determine which requests to resolve
  let targetRequests: PendingRequest[];

  if (numberedSelections) {
    // Numbered selection: "approve 1,3" — match against batch order
    // Numbers correspond to the order in the batch notification message.
    // Batch messages list requests in ascending created_at order (matching our query).
    // If reply-to is a batch message, filter to only requests in that batch.
    const batchRequests = replyToMessageId
      ? pendingRequests.filter(
          (r) =>
            r.metadata &&
            typeof r.metadata === 'object' &&
            'batchMessageId' in r.metadata &&
            String(r.metadata.batchMessageId) === replyToMessageId
        )
      : pendingRequests;
    // Fall back to all pending if reply-to didn't match a batch
    const orderedRequests = batchRequests.length > 0 ? batchRequests : pendingRequests;
    targetRequests = numberedSelections
      .map((n) => orderedRequests[n - 1]) // 1-indexed
      .filter(Boolean);
  } else if (isAllOrScoped) {
    // Scoped commands filter by the relevant dimension.
    // "approve all" truly resolves everything pending.
    // "approve session/agent/studio" anchors to the replied-to request's scope.
    const anchorRequest = replyToMessageId
      ? pendingRequests.find(
          (r) =>
            r.metadata &&
            typeof r.metadata === 'object' &&
            (('telegramMessageId' in r.metadata &&
              String(r.metadata.telegramMessageId) === replyToMessageId) ||
              ('batchMessageId' in r.metadata &&
                String(r.metadata.batchMessageId) === replyToMessageId))
        )
      : undefined;

    if (/^approve\s+all$/i.test(trimmed) || /^deny\s+all$/i.test(trimmed)) {
      targetRequests = pendingRequests;
    } else if (match.scope === 'agent') {
      // "approve agent" / "approve always" — filter to same requesting agent.
      // Requires reply-to anchor so the scope is unambiguous.
      if (!anchorRequest) {
        // No reply-to: fall back to most recent only (single-request approval)
        targetRequests = pendingRequests.slice(-1);
      } else {
        targetRequests = pendingRequests.filter(
          (r) => r.requesting_agent_id === anchorRequest.requesting_agent_id
        );
      }
    } else if (match.scope === 'studio') {
      // "approve studio" — filter to same studio.
      // Requires reply-to anchor so the scope is unambiguous.
      if (!anchorRequest) {
        targetRequests = pendingRequests.slice(-1);
      } else {
        targetRequests = anchorRequest.studio_id
          ? pendingRequests.filter((r) => r.studio_id === anchorRequest.studio_id)
          : [anchorRequest];
      }
    } else if (action === 'grant-session') {
      // "approve session" — filter to same session.
      // Requires reply-to anchor so the scope is unambiguous.
      if (!anchorRequest) {
        targetRequests = pendingRequests.slice(-1);
      } else {
        targetRequests = anchorRequest.session_id
          ? pendingRequests.filter((r) => r.session_id === anchorRequest.session_id)
          : [anchorRequest];
      }
    } else {
      targetRequests = pendingRequests;
    }
  } else if (replyToMessageId) {
    // Reply-to threading: match by metadata.telegramMessageId or batchMessageId
    const replyMatch = pendingRequests.find(
      (r) =>
        r.metadata &&
        typeof r.metadata === 'object' &&
        (('telegramMessageId' in r.metadata &&
          String(r.metadata.telegramMessageId) === replyToMessageId) ||
          ('batchMessageId' in r.metadata &&
            String(r.metadata.batchMessageId) === replyToMessageId))
    );
    if (replyMatch) {
      // Bare approve/yes on a batch resolves only the single matched request.
      // Use "approve all" or numbered "approve 1,3" for batch-wide resolution.
      targetRequests = [replyMatch];
    } else {
      targetRequests = [pendingRequests[pendingRequests.length - 1]];
    }
  } else {
    // Default: most recent pending request
    targetRequests = [pendingRequests[pendingRequests.length - 1]];
  }

  if (targetRequests.length === 0) {
    return { intercepted: false };
  }

  // Resolve all targeted requests
  const status = action === 'deny' ? 'denied' : 'granted';
  const resolvedRequests: Array<{ id: string; tool: string; action: string; agentId?: string }> =
    [];

  for (const req of targetRequests) {
    const grantedTools = action !== 'deny' ? [req.tool + (req.args ? `(${req.args})` : '')] : null;

    const { error: updateError } = await supabase
      .from('approval_requests')
      .update({
        status,
        action,
        granted_tools: grantedTools,
        granted_by: grantedBy,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', req.id)
      .eq('status', 'pending'); // Optimistic lock

    if (updateError) {
      logger.error('Failed to resolve approval request', {
        requestId: req.id,
        error: updateError,
      });
      continue;
    }

    resolvedRequests.push({
      id: req.id,
      tool: req.tool,
      action,
      agentId: req.requesting_agent_id,
    });
  }

  if (resolvedRequests.length === 0) {
    return { intercepted: false };
  }

  logger.info('Approval requests resolved via platform', {
    count: resolvedRequests.length,
    action,
    grantedBy,
    tools: resolvedRequests.map((r) => r.tool),
  });

  return {
    intercepted: true,
    action,
    requestId: resolvedRequests[0].id,
    resolvedRequests,
  };
}

/**
 * Build a rich confirmation message for the Telegram response.
 */
export function formatApprovalConfirmation(result: ApprovalInterceptResult): string {
  if (!result.resolvedRequests?.length) {
    const emoji = result.action === 'deny' ? '\u{1F6AB}' : '\u{2705}';
    return `${emoji} Permission ${result.action}: request ${result.requestId}`;
  }

  const isDeny = result.action === 'deny';
  const emoji = isDeny ? '\u{1F6AB}' : '\u{2705}';
  const tools = result.resolvedRequests.map((r) => r.tool);
  const uniqueTools = [...new Set(tools)];
  const agents = [...new Set(result.resolvedRequests.map((r) => r.agentId).filter(Boolean))];

  let scopeLabel = '';
  if (result.action === 'grant-session') scopeLabel = ' (session scope)';
  else if (result.action === 'grant-agent') scopeLabel = ' (permanent, agent scope)';
  else if (result.action === 'grant-studio') scopeLabel = ' (permanent, studio scope)';
  else if (result.action === 'allow') scopeLabel = ' (permanent, agent scope)';

  const verb = isDeny ? 'Denied' : 'Granted';
  const toolList = uniqueTools.map((t) => `\`${t}\``).join(', ');
  const agentLabel = agents.length > 0 ? ` for ${agents.join(', ')}` : '';

  if (result.resolvedRequests.length === 1) {
    return `${emoji} ${verb}${agentLabel}: ${toolList}${scopeLabel}`;
  }

  return `${emoji} ${verb} ${result.resolvedRequests.length} tools${agentLabel}: ${toolList}${scopeLabel}`;
}

// ─── Batch Notification ──────────────────────────────────────────

/**
 * Send an approval request notification to a user's connected platform(s).
 * Debounces rapid-fire requests into a single consolidated message.
 *
 * When multiple requests arrive within DEBOUNCE_MS of each other, they're
 * batched into a numbered list with batch approval options.
 */
export async function notifyPlatformOfApprovalRequest(request: {
  id: string;
  userId: string;
  tool: string;
  args?: string | null;
  reason?: string | null;
  requestingAgentId: string;
  studioId?: string | null;
  sessionId?: string | null;
  expiresAt: string;
}): Promise<void> {
  const bufferKey = request.userId;
  const existing = notificationBuffer.get(bufferKey);

  const buffered: BufferedRequest = {
    id: request.id,
    userId: request.userId,
    tool: request.tool,
    args: request.args,
    reason: request.reason,
    requestingAgentId: request.requestingAgentId,
    studioId: request.studioId,
    sessionId: request.sessionId,
    expiresAt: request.expiresAt,
  };

  if (existing) {
    clearTimeout(existing.timer);
    existing.requests.push(buffered);
    existing.timer = setTimeout(() => flushNotificationBuffer(bufferKey), DEBOUNCE_MS);
  } else {
    const timer = setTimeout(() => flushNotificationBuffer(bufferKey), DEBOUNCE_MS);
    notificationBuffer.set(bufferKey, { requests: [buffered], timer });
  }
}

async function flushNotificationBuffer(bufferKey: string): Promise<void> {
  const entry = notificationBuffer.get(bufferKey);
  notificationBuffer.delete(bufferKey);
  if (!entry || entry.requests.length === 0) return;

  const { requests } = entry;
  const userId = requests[0].userId;

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: trustedUsers } = await supabase
    .from('trusted_users')
    .select('platform, platform_user_id')
    .eq('user_id', userId)
    .in('platform', ['telegram', 'whatsapp']);

  if (!trustedUsers?.length) {
    logger.warn('No connected platforms for approval notification', {
      userId,
      requestCount: requests.length,
    });
    return;
  }

  // Build the message — single or batch format
  const isBatch = requests.length > 1;
  const message = isBatch
    ? formatBatchNotification(requests)
    : formatSingleNotification(requests[0]);

  for (const tu of trustedUsers) {
    if (tu.platform === 'telegram') {
      await sendTelegramNotification(supabase, tu, requests, message, isBatch);
    }
    // TODO: WhatsApp notification support
  }
}

function formatSingleNotification(req: BufferedRequest): string {
  const toolDisplay = req.args ? `${req.tool}(${req.args})` : req.tool;
  const expiresIn = Math.max(
    1,
    Math.round((new Date(req.expiresAt).getTime() - Date.now()) / 60000)
  );

  return (
    `\u{1F510} *Permission request* from ${req.requestingAgentId}:\n\n` +
    `\`${toolDisplay}\`\n\n` +
    (req.reason ? `Reason: ${req.reason}\n` : '') +
    (req.studioId ? `Studio: ${req.studioId}\n` : '') +
    `Expires in: ${expiresIn} min\n\n` +
    `Reply: *approve* / *deny* / *approve session*\n` +
    `Permanent: *approve agent* / *approve studio*`
  );
}

function formatBatchNotification(requests: BufferedRequest[]): string {
  const agents = [...new Set(requests.map((r) => r.requestingAgentId))];
  const agentLabel = agents.length === 1 ? agents[0] : agents.join(', ');
  const expiresIn = Math.max(
    1,
    Math.round(
      (Math.min(...requests.map((r) => new Date(r.expiresAt).getTime())) - Date.now()) / 60000
    )
  );

  let msg = `\u{1F510} *${requests.length} permission requests* from ${agentLabel}:\n\n`;

  requests.forEach((req, i) => {
    const toolDisplay = req.args ? `${req.tool}(${req.args})` : req.tool;
    msg += `${i + 1}. \`${toolDisplay}\`\n`;
    if (req.reason) msg += `   ${req.reason}\n`;
  });

  msg += `\nExpires in: ${expiresIn} min\n\n`;
  msg += `Reply:\n`;
  msg += `  *approve all* / *deny all*\n`;
  msg += `  *approve 1,3* / *deny 2*\n`;
  msg += `  *approve session* / *approve agent* / *approve studio*`;

  return msg;
}

async function sendTelegramNotification(
  supabase: ReturnType<typeof createClient<any, 'public', any>>,
  tu: { platform: string; platform_user_id: string },
  requests: BufferedRequest[],
  message: string,
  isBatch: boolean
): Promise<void> {
  try {
    const botToken = env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return;

    const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: tu.platform_user_id,
        text: message,
        parse_mode: 'Markdown',
      }),
    });

    if (resp.ok) {
      const result = (await resp.json()) as { result?: { message_id?: number } };
      const telegramMessageId = result.result?.message_id;

      if (telegramMessageId) {
        if (isBatch) {
          // Store the batch message ID on ALL requests in the batch
          // so the interceptor can match reply-to for numbered selection
          for (const req of requests) {
            await supabase
              .from('approval_requests')
              .update({
                metadata: {
                  batchMessageId: telegramMessageId,
                  batchIndex: requests.indexOf(req),
                  platform: 'telegram',
                  chatId: tu.platform_user_id,
                },
              })
              .eq('id', req.id);
          }
        } else {
          await supabase
            .from('approval_requests')
            .update({
              metadata: {
                telegramMessageId,
                platform: 'telegram',
                chatId: tu.platform_user_id,
              },
            })
            .eq('id', requests[0].id);
        }

        logger.info('Approval notification sent to Telegram', {
          requestIds: requests.map((r) => r.id),
          chatId: tu.platform_user_id,
          telegramMessageId,
          isBatch,
        });
      }
    } else {
      logger.error('Failed to send Telegram approval notification', {
        requestIds: requests.map((r) => r.id),
        status: resp.status,
      });
    }
  } catch (err) {
    logger.error('Error sending Telegram approval notification', {
      requestIds: requests.map((r) => r.id),
      error: String(err),
    });
  }
}
