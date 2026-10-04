/**
 * Who may write to a conversation that holds an inkling (Lumen 97b1d66a).
 *
 * In the owner test an inkling is a trusted personal SB with its owner's
 * reach, so its conversations stay between the two of them: the gate's
 * account, as a person, and that one inkling. No other SB, no other
 * person, no system or strategy send, and nothing at all while the test is
 * off. handleSendToInbox asks before it writes anything, so a refused send
 * leaves no thread, participant or message behind. Turn dispatch checks
 * again at the spawn seam; this is the creation half.
 *
 * Two senders write: the owner, and the inkling replying. The inkling only
 * replies, in a conversation it is already a member of with its owner; it
 * never starts one. Its reply addresses itself and wakes nobody, and the
 * turn gate wakes an inkling only for its owner's message, so a reply
 * cannot start another turn.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { inklingOwnerTestUserId } from '../../config/inkling-flags';
import type { Principal, SbPrincipal } from '../principals';
import { INKLING_CLIENT, INKLINGS_DISABLED } from './inkling-service';

export const INKLING_THREAD_REFUSED = 'inkling_thread_refused';

export class InklingThreadRefusedError extends Error {
  constructor(
    readonly code: typeof INKLINGS_DISABLED | typeof INKLING_THREAD_REFUSED,
    message: string
  ) {
    super(message);
    this.name = 'InklingThreadRefusedError';
  }
}

interface IdentityRow {
  id: string;
  user_id: string;
  metadata: Record<string, unknown> | null;
}

/**
 * Refuses (throws) a send that would put an inkling in a conversation with
 * anyone but its owner, or that comes from anyone but that owner or, as a
 * reply, the inkling itself. A send that touches no inkling passes
 * untouched.
 */
export async function assertInklingThreadAllowed(
  supabase: SupabaseClient,
  input: {
    sender: Principal;
    /** Every SB this send puts on the thread: recipients, and an SB sender. */
    participantSbs: SbPrincipal[];
    existingThreadId: string | null;
  },
  ownerTestUserId: string | null = inklingOwnerTestUserId()
): Promise<void> {
  const sbIds = new Set(input.participantSbs.map((sb) => sb.sbId));
  const people = new Set<string>();
  /** The SBs already in the conversation, before this send. */
  const members = new Set<string>();
  if (input.existingThreadId) {
    const { data, error } = await supabase
      .from('inbox_thread_participants')
      .select('sb_id, user_id')
      .eq('thread_id', input.existingThreadId);
    if (error) throw new Error(`Failed to read the conversation's members: ${error.message}`);
    for (const row of (data ?? []) as Array<{ sb_id: string | null; user_id: string | null }>) {
      if (row.sb_id) {
        sbIds.add(row.sb_id);
        members.add(row.sb_id);
      }
      if (row.user_id) people.add(row.user_id.toLowerCase());
    }
  }
  if (sbIds.size === 0) return;

  const { data, error } = await supabase
    .from('agent_identities')
    .select('id, user_id, metadata')
    .in('id', [...sbIds]);
  if (error) throw new Error(`Failed to read the conversation's SBs: ${error.message}`);
  const identities = (data ?? []) as IdentityRow[];
  const inklings = identities.filter((r) => r.metadata?.client === INKLING_CLIENT);
  if (inklings.length === 0) return;

  if (ownerTestUserId === null) {
    throw new InklingThreadRefusedError(INKLINGS_DISABLED, 'Inklings are not open on this server');
  }
  const owner = ownerTestUserId.toLowerCase();
  const [inkling] = inklings;
  const sender = input.sender;
  const fromOwner = sender.kind === 'user' && sender.userId.toLowerCase() === owner;
  // The inkling answering: in a conversation it is already in, with its
  // owner in it too. Never a new one, and never one its owner has left.
  const replyFromInkling =
    sender.kind === 'sb' &&
    sender.sbId === inkling.id &&
    members.has(inkling.id) &&
    people.has(owner);
  const allowed =
    (fromOwner || replyFromInkling) &&
    inklings.length === 1 &&
    sbIds.size === 1 &&
    inkling.user_id.toLowerCase() === owner &&
    inkling.metadata?.ownerTest === true &&
    [...people].every((person) => person === owner);
  if (!allowed) {
    throw new InklingThreadRefusedError(
      INKLING_THREAD_REFUSED,
      "An inkling's conversation is only between it and its owner"
    );
  }
}
