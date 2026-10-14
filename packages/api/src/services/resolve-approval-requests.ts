/**
 * Shared persistence for already-authorized human approval decisions.
 *
 * This is NOT an authentication or request-selection boundary. Callers must
 * authenticate the human, read requests within that human's authorized scope,
 * and apply their transport's selection policy before calling. No command text,
 * request scope or approver identity may be taken from an untrusted decision body.
 * The platform interceptor is the only caller today; no app grant route is added.
 *
 * A conditional update is the decision's linearization point. Only its winner
 * is reported and may wake a one-use requester. A lost/unknown write is never
 * retried here, and a wake failure does not undo a confirmed decision.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger';

/** The server-read fields needed to resolve a previously selected request. */
export interface ApprovalResolutionRequest {
  id: string;
  tool: string;
  args: string | null;
  expires_at: string;
  requesting_agent_id: string;
  session_id: string | null;
  scope_key?: string | null;
  cwd?: string | null;
}

export type ApprovalResolutionAction =
  | 'grant'
  | 'deny'
  | 'grant-session'
  | 'grant-agent'
  | 'grant-studio'
  | 'allow';

const RESOLUTION_ACTIONS: readonly ApprovalResolutionAction[] = [
  'grant',
  'deny',
  'grant-session',
  'grant-agent',
  'grant-studio',
  'allow',
];

export interface ResolvedApprovalRequest {
  id: string;
  tool: string;
  action: ApprovalResolutionAction;
  sbSlug?: string;
}

export async function resolveApprovalRequests(
  supabase: SupabaseClient,
  decision: {
    userId: string;
    grantedBy: string;
    action: ApprovalResolutionAction;
    requests: readonly ApprovalResolutionRequest[];
  }
): Promise<ResolvedApprovalRequest[]> {
  const { userId, grantedBy, action, requests } = decision;
  // Internal callers still get an explicit closed vocabulary; an unknown action
  // must never become a grant merely because it is not spelled "deny".
  if (!RESOLUTION_ACTIONS.includes(action)) throw new Error('Unsupported approval decision');
  const status = action === 'deny' ? 'denied' : 'granted';
  const resolvedRequests: ResolvedApprovalRequest[] = [];

  const oneUseGranted: ApprovalResolutionRequest[] = [];
  for (const req of requests) {
    const grantedTools = action !== 'deny' ? [req.tool + (req.args ? `(${req.args})` : '')] : null;
    // A one-use grant is spent once whatever the reply said: never a
    // session, agent or studio grant.
    const resolvedAction = req.scope_key && action !== 'deny' ? 'grant' : action;

    // Optimistic lock: still pending, still this user's, not yet expired. Only
    // a write that changed the row counts: the loser of a race, or a request
    // that expired between the read and the write, is neither reported nor
    // woken (Lumen, #853). PostgREST reports success for zero rows, so the
    // changed rows are read back.
    const nowIso = new Date().toISOString();
    const { data: changed, error: updateError } = await supabase
      .from('approval_requests')
      .update({
        status,
        action: resolvedAction,
        granted_tools: grantedTools,
        granted_by: grantedBy,
        resolved_at: nowIso,
      })
      .eq('id', req.id)
      .eq('status', 'pending')
      .eq('user_id', userId)
      .gt('expires_at', nowIso)
      .select('id');

    if (updateError) {
      logger.error('Failed to resolve approval request', {
        requestId: req.id,
        error: updateError,
      });
      continue;
    }
    if (!Array.isArray(changed) || changed.length !== 1) {
      logger.info('Approval request was resolved elsewhere or expired first; not resolved here', {
        requestId: req.id,
      });
      continue;
    }

    resolvedRequests.push({
      id: req.id,
      tool: req.tool,
      action: resolvedAction,
      sbSlug: req.requesting_agent_id,
    });
    if (req.scope_key && status === 'granted' && req.session_id) oneUseGranted.push(req);
  }

  for (const req of oneUseGranted) {
    await resumeApprovedSession(userId, req).catch((err) => {
      logger.error('Approved, but the session could not be woken', {
        requestId: req.id,
        sessionId: req.session_id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return resolvedRequests;
}

/**
 * Wake the session a one-use grant was asked from, so its next turn runs the
 * command again and spends the grant. Sent to that session by id, as a
 * session_resume; it queues behind a running turn like any message.
 */
async function resumeApprovedSession(
  userId: string,
  req: ApprovalResolutionRequest
): Promise<void> {
  const [{ handleSendToInbox }, { getDataComposer }] = await Promise.all([
    import('../mcp/tools/inbox-handlers.js'),
    import('../data/composer.js'),
  ]);
  await handleSendToInbox(
    {
      userId,
      recipientSlug: req.requesting_agent_id,
      recipientSessionId: req.session_id,
      senderSlug: 'system',
      messageType: 'session_resume',
      priority: 'high',
      content:
        `Conor approved: \`${req.args ?? req.tool}\` in \`${req.cwd ?? 'the same directory'}\`. ` +
        'Run it again, exactly as it was and from that directory: the approval is good ' +
        `once, for that command there, until ${req.expires_at}.`,
      trigger: true,
      triggerType: 'message',
      triggerSummary: 'Approval granted: run the command again',
      metadata: { source: 'approval_interceptor', approvalRequestId: req.id },
    },
    await getDataComposer()
  );
}
