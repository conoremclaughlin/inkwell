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
import { isInklingOwnerTestUser, type OwnerTestAllowlist } from '../../config/inkling-flags';
import { INKLING_CLIENT } from './inkling-service';

/**
 * What the SB a turn is for is, as far as the database can say:
 * - 'inkling', with its row;
 * - 'other', positively not an inkling: its row says so, or no identity
 *   row exists at all;
 * - 'unknown', when its canonical identity could not be established.
 *   `transient` is true when a read failed, false when nothing names one
 *   identity (an ambiguous slug, an id that names no row).
 * Lumen's review of 8b9d7f50: an unreadable or absent identity used to skip
 * the whole gate.
 */
export type InklingIdentity =
  | { kind: 'inkling'; id: string; userId: string; metadata: Record<string, unknown> }
  | { kind: 'other' }
  | { kind: 'unknown'; transient: boolean };

/**
 * Read the canonical identity by its id, with no user filter, so an inkling
 * never hides behind a mismatched account. The id is the session's, or the
 * one routing resolves (SessionService.classifyTurnIdentity); a slug is
 * never the authority.
 */
export async function classifyIdentityById(
  supabase: SupabaseClient,
  sbId: string
): Promise<InklingIdentity> {
  const { data, error } = await supabase
    .from('agent_identities')
    .select('id, user_id, metadata')
    .eq('id', sbId)
    .maybeSingle();
  if (error) return { kind: 'unknown', transient: true };
  const row = data as {
    id: string;
    user_id: string;
    metadata: Record<string, unknown> | null;
  } | null;
  if (!row) return { kind: 'unknown', transient: false };
  if (row.metadata?.client !== INKLING_CLIENT) return { kind: 'other' };
  return { kind: 'inkling', id: row.id, userId: row.user_id, metadata: row.metadata ?? {} };
}

/**
 * Did the owner, as a person, really send the message that woke this turn,
 * in a conversation the inkling is on? Read from the stored message the
 * trigger names, which the send path wrote with its server-derived sender.
 * A sender label ('user') proves nothing: trigger_agent takes one from its
 * caller (Lumen's review of 8b9d7f50).
 * - 'yes': the stored message is the owner's own, in the inkling's
 *   conversation.
 * - 'no': no message id, no such message, another sender, or another
 *   conversation.
 * - 'unreadable': a read failed. That still refuses the turn, but as
 *   something worth retrying (Lumen's re-review of 5516ec7c).
 */
export type OwnerMessageProof = 'yes' | 'no' | 'unreadable';

export async function isOwnersOwnMessage(
  supabase: SupabaseClient,
  input: { threadMessageId: string | undefined; inklingId: string; ownerUserId: string | null }
): Promise<OwnerMessageProof> {
  if (!input.threadMessageId || !input.ownerUserId) return 'no';
  const { data: message, error } = await supabase
    .from('inbox_thread_messages')
    .select('thread_id, sender_kind, sender_user_id')
    .eq('id', input.threadMessageId)
    .maybeSingle();
  if (error) return 'unreadable';
  const row = message as {
    thread_id: string;
    sender_kind: string | null;
    sender_user_id: string | null;
  } | null;
  if (!row) return 'no';
  if (row.sender_kind !== 'user') return 'no';
  if ((row.sender_user_id ?? '').toLowerCase() !== input.ownerUserId.toLowerCase()) return 'no';
  const { data: member, error: memberError } = await supabase
    .from('inbox_thread_participants')
    .select('sb_id')
    .eq('thread_id', row.thread_id)
    .eq('sb_id', input.inklingId)
    .maybeSingle();
  if (memberError) return 'unreadable';
  return member ? 'yes' : 'no';
}

export interface InklingTurnInput {
  identity: InklingIdentity;
  /** The account the turn runs for. */
  userId: string;
  /** isOwnersOwnMessage, for an inkling's turn. */
  ownerMessage: OwnerMessageProof;
}

/** Why a turn may not start, and whether trying again could change that. */
export interface InklingTurnRefusal {
  reason: string;
  /** True only when a database read failed: nothing about the turn itself was decided. */
  retryable: boolean;
}

/** Null when the turn may start. Only inklings, or SBs whose identity cannot be established, are ever refused. */
export function inklingTurnRefusal(
  input: InklingTurnInput,
  ownerTestUserIds: OwnerTestAllowlist
): InklingTurnRefusal | null {
  const { identity } = input;
  if (identity.kind === 'unknown') {
    return identity.transient
      ? { reason: "the SB's identity could not be read", retryable: true }
      : { reason: "the SB's identity could not be established", retryable: false };
  }
  if (identity.kind === 'other') return null;
  const refuse = (reason: string): InklingTurnRefusal => ({ reason, retryable: false });
  if (ownerTestUserIds.size === 0) return refuse('inklings are not open on this server');
  // The inkling's owner must be in the test, and the turn must run on that
  // same account: another listed account never reaches this inkling.
  const owner = identity.userId.toLowerCase();
  if (!isInklingOwnerTestUser(owner, ownerTestUserIds) || input.userId.toLowerCase() !== owner) {
    return refuse('this inkling belongs to an account outside the owner test');
  }
  if (identity.metadata.ownerTest !== true) {
    return refuse('this inkling was not born under the owner test');
  }
  if (input.ownerMessage === 'unreadable') {
    return { reason: 'the message that woke it could not be read', retryable: true };
  }
  if (input.ownerMessage !== 'yes') {
    return refuse('an inkling wakes only for a stored message its owner sent in its conversation');
  }
  return null;
}
