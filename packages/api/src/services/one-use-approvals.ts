/**
 * One-use approval grants for destructive commands (spec
 * automated-turn-permissions §3.5).
 *
 * A headless turn that meets a destructive command outside its own
 * directories asks Conor and is denied at once. When he grants it, the
 * session is woken, runs the command again, and the hook spends the grant.
 *
 * THE SCOPE IS THE SERVER'S. The user, the session, and that session's
 * studio and SB come from the signed runner token and the session row it
 * names, never from the request body or the unsigned x-ink-context header.
 * The tool, the full command and the directory it runs in come from the
 * hook; they only narrow the grant. All of it is digested into
 * `scope_key`, so the same command from another directory, another session
 * or another studio (after a move, say) needs its own approval.
 *
 * SPENT ONCE. A consume is a conditional update on `consumed_at IS NULL`,
 * per candidate row, so two racing turns cannot both spend one grant.
 */
import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface OneUseScope {
  userId: string;
  sessionId: string;
  studioId: string | null;
  sbId: string | null;
  tool: string;
  args: string;
  cwd: string;
}

/** The digest a one-use grant is keyed on. Canonical: fixed key order. */
export function approvalScopeKey(scope: OneUseScope): string {
  const canonical = JSON.stringify([
    'one-use-approval/v1',
    scope.userId,
    scope.sessionId,
    scope.studioId,
    scope.sbId,
    scope.tool,
    scope.args,
    scope.cwd,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export interface SignedSession {
  sessionId: string;
  studioId: string | null;
  sbId: string | null;
  /** The session's SB slug, from its row: who asked, as the approver reads it. */
  sbSlug: string | null;
}

/**
 * The session a signed runner token names, read from its row for this
 * user. Null when the row is gone or belongs to someone else: no scope can
 * be established, so no one-use grant can be asked for or spent.
 */
export async function readSignedSession(
  supabase: SupabaseClient,
  userId: string,
  tokenSessionId: string | undefined
): Promise<SignedSession | null> {
  if (!tokenSessionId) return null;
  const { data, error } = await supabase
    .from('sessions')
    .select('id, studio_id, sb_id, agent_id')
    .eq('id', tokenSessionId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`session ${tokenSessionId} could not be read: ${error.message}`);
  const row = data as {
    id: string;
    studio_id: string | null;
    sb_id: string | null;
    agent_id: string | null;
  } | null;
  return row
    ? { sessionId: row.id, studioId: row.studio_id, sbId: row.sb_id, sbSlug: row.agent_id }
    : null;
}

/**
 * Spend one unspent, unexpired grant for exactly this scope. Returns the
 * request id spent, or null when there is none to spend.
 */
export async function consumeOneUseGrant(
  supabase: SupabaseClient,
  scope: { userId: string; sessionId: string; scopeKey: string },
  now: Date = new Date()
): Promise<string | null> {
  const { data, error } = await supabase
    .from('approval_requests')
    .select('id')
    .eq('user_id', scope.userId)
    .eq('session_id', scope.sessionId)
    .eq('scope_key', scope.scopeKey)
    .eq('status', 'granted')
    .is('consumed_at', null)
    .gt('expires_at', now.toISOString())
    .order('created_at', { ascending: true })
    .limit(5);
  if (error) throw new Error(`grants could not be read: ${error.message}`);
  for (const candidate of (data ?? []) as Array<{ id: string }>) {
    const { data: spent, error: spendError } = await supabase
      .from('approval_requests')
      .update({ consumed_at: now.toISOString() })
      .eq('id', candidate.id)
      .eq('user_id', scope.userId)
      .eq('session_id', scope.sessionId)
      .eq('scope_key', scope.scopeKey)
      .eq('status', 'granted')
      .is('consumed_at', null)
      .gt('expires_at', now.toISOString())
      .select('id');
    if (spendError) throw new Error(`grant could not be spent: ${spendError.message}`);
    if (Array.isArray(spent) && spent.length === 1) return candidate.id;
  }
  return null;
}
