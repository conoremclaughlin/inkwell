/**
 * Whether a turn may start for an inkling: the spawn seam's half of the
 * owner/dev gate (Lumen 97b1d66a). SessionService.processMessage asks this
 * after it loads the identity and before anything is spawned, for every
 * path that starts a turn: thread wakes, reminders and heartbeats,
 * strategies, channels, web chat, retries.
 *
 * The creation half (inkling-thread-gate.ts) keeps an inkling's
 * conversations between it and its owner. This half refuses everything
 * else that could wake it: an SB's or the system's send, a heartbeat, a
 * reminder, a strategy, a channel message, and every turn while the owner
 * test is off. Only a person's message, on the owner's own account, wakes
 * an inkling born under the test.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { INKLING_CLIENT } from './inkling-service';

/** Attempts at the conditional counter update before a contended claim is refused. */
const CLAIM_ATTEMPTS = 5;

/**
 * Count one turn against an inkling's cap before it is spawned: a
 * conditional update of metadata.ownerTestTurns, guarded on updated_at as
 * naming is, so two turns starting together cannot both take the last one.
 * A failed or unfinished turn still counts: the cap bounds how often the
 * inkling runs, not how often it succeeds. An unreadable identity, or a
 * claim still contended after a few attempts, is refused rather than run.
 */
export async function claimInklingTurn(
  supabase: SupabaseClient,
  sbId: string,
  userId: string,
  cap: number
): Promise<{ allowed: boolean; used: number }> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const { data, error } = await supabase
      .from('agent_identities')
      .select('metadata, updated_at')
      .eq('id', sbId)
      .eq('user_id', userId)
      .maybeSingle();
    const row = data as { metadata: Record<string, unknown> | null; updated_at: string } | null;
    if (error || !row) return { allowed: false, used: 0 };
    const metadata = row.metadata ?? {};
    const counted = metadata.ownerTestTurns;
    const used = typeof counted === 'number' && Number.isInteger(counted) ? counted : 0;
    if (used >= cap) return { allowed: false, used };
    const { data: won } = await supabase
      .from('agent_identities')
      .update({
        metadata: { ...metadata, ownerTestTurns: used + 1 },
        updated_at: new Date().toISOString(),
      })
      .eq('id', sbId)
      .eq('user_id', userId)
      .eq('updated_at', row.updated_at)
      .select('id')
      .maybeSingle();
    if (won) return { allowed: true, used: used + 1 };
  }
  return { allowed: false, used: cap };
}

/**
 * What the SB a turn is for is, as far as the database can say:
 * - 'inkling', with its row;
 * - 'other', positively not an inkling;
 * - 'unknown', when the row could not be read or found.
 * Read by id with no user filter, so an inkling never hides behind a
 * mismatched account. With no id, it is read by the account and slug, and
 * any inkling among those rows makes it one. Lumen's review of 8b9d7f50:
 * an unreadable or absent identity used to skip the whole gate.
 */
export type InklingIdentity =
  | { kind: 'inkling'; id: string; userId: string; metadata: Record<string, unknown> }
  | { kind: 'other' }
  | { kind: 'unknown' };

export async function classifyInklingIdentity(
  supabase: SupabaseClient,
  input: { sbId: string | null | undefined; sbSlug: string; userId: string }
): Promise<InklingIdentity> {
  type Row = { id: string; user_id: string; metadata: Record<string, unknown> | null };
  let rows: Row[];
  if (input.sbId) {
    const { data, error } = await supabase
      .from('agent_identities')
      .select('id, user_id, metadata')
      .eq('id', input.sbId)
      .maybeSingle();
    if (error || !data) return { kind: 'unknown' };
    rows = [data as Row];
  } else {
    const { data, error } = await supabase
      .from('agent_identities')
      .select('id, user_id, metadata')
      .eq('user_id', input.userId)
      .eq('agent_id', input.sbSlug);
    if (error || !data || data.length === 0) return { kind: 'unknown' };
    rows = data as Row[];
  }
  const inkling = rows.find((r) => r.metadata?.client === INKLING_CLIENT);
  if (!inkling) return { kind: 'other' };
  return {
    kind: 'inkling',
    id: inkling.id,
    userId: inkling.user_id,
    metadata: inkling.metadata ?? {},
  };
}

/**
 * Every inkling's slug is kindle-<token id>, set when it is awakened and
 * never changed by naming. So an SB whose identity cannot be read is
 * refused when its slug could be an inkling's, and only then.
 */
export function mayBeInklingSlug(sbSlug: string): boolean {
  return sbSlug.toLowerCase().startsWith('kindle-');
}

/**
 * Did the owner, as a person, really send the message that woke this turn,
 * in a conversation the inkling is on? Read from the stored message the
 * trigger names, which the send path wrote with its server-derived sender.
 * A sender label ('user') proves nothing: trigger_agent takes one from its
 * caller (Lumen's review of 8b9d7f50). No message id, or anything unread,
 * is a no.
 */
export async function isOwnersOwnMessage(
  supabase: SupabaseClient,
  input: { threadMessageId: string | undefined; inklingId: string; ownerUserId: string | null }
): Promise<boolean> {
  if (!input.threadMessageId || !input.ownerUserId) return false;
  const { data: message, error } = await supabase
    .from('inbox_thread_messages')
    .select('thread_id, sender_kind, sender_user_id')
    .eq('id', input.threadMessageId)
    .maybeSingle();
  const row = message as {
    thread_id: string;
    sender_kind: string | null;
    sender_user_id: string | null;
  } | null;
  if (error || !row) return false;
  if (row.sender_kind !== 'user') return false;
  if ((row.sender_user_id ?? '').toLowerCase() !== input.ownerUserId.toLowerCase()) return false;
  const { data: member, error: memberError } = await supabase
    .from('inbox_thread_participants')
    .select('sb_id')
    .eq('thread_id', row.thread_id)
    .eq('sb_id', input.inklingId)
    .maybeSingle();
  return !memberError && !!member;
}

export interface InklingTurnInput {
  identity: InklingIdentity;
  sbSlug: string;
  /** The account the turn runs for. */
  userId: string;
  /** isOwnersOwnMessage, for an inkling's turn. */
  fromOwnersOwnMessage: boolean;
}

/** Null when the turn may start; otherwise why it may not. Only inklings, or possible ones, are ever refused. */
export function inklingTurnRefusal(
  input: InklingTurnInput,
  ownerTestUserId: string | null
): string | null {
  const { identity } = input;
  if (identity.kind === 'unknown') {
    return mayBeInklingSlug(input.sbSlug)
      ? 'the identity could not be read, and it may be an inkling'
      : null;
  }
  if (identity.kind === 'other') return null;
  if (ownerTestUserId === null) return 'inklings are not open on this server';
  const owner = ownerTestUserId.toLowerCase();
  if (identity.userId.toLowerCase() !== owner || input.userId.toLowerCase() !== owner) {
    return 'this inkling belongs to an account outside the owner test';
  }
  if (identity.metadata.ownerTest !== true) return 'this inkling was not born under the owner test';
  if (!input.fromOwnersOwnMessage) {
    return 'an inkling wakes only for a stored message its owner sent in its conversation';
  }
  return null;
}
