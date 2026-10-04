/**
 * Who may write to a conversation that holds an inkling (Lumen 97b1d66a).
 *
 * In the owner test an inkling is a trusted personal SB with its owner's
 * reach, so its conversations stay between its owner, an owner-test
 * account, as a person, and that owner's own inklings: one, or a group of
 * up to MAX_CONVERSATION_INKLINGS. No other SB, no other person, no system
 * or strategy send, and nothing at all while the test is off.
 * handleSendToInbox asks before it writes anything, so a refused send
 * leaves no thread, participant or message behind. Turn dispatch checks
 * again at the spawn seam; this is the creation half.
 *
 * Two senders write: the owner, and a member inkling replying. An inkling
 * only replies, in a conversation it is already a member of with its
 * owner, to members already there; it never starts one or brings anyone
 * in. Its send wakes nobody (the verdict's `quiet`), so one inkling never
 * wakes another, and the turn gate wakes an inkling only for its owner's
 * message besides.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  inklingOwnerTestUserIds,
  isInklingOwnerTestUser,
  type OwnerTestAllowlist,
} from '../../config/inkling-flags';
import type { Principal, SbPrincipal } from '../principals';
import { INKLING_CLIENT, INKLINGS_DISABLED } from './inkling-service';

export const INKLING_THREAD_REFUSED = 'inkling_thread_refused';

/** The most inklings one owner-present conversation may hold. */
export const MAX_CONVERSATION_INKLINGS = 3;

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

/** What an allowed send may do besides being written. */
export interface InklingThreadVerdict {
  /** True when an inkling is the sender: its send must wake nobody. */
  quiet: boolean;
}

/**
 * Refuses (throws) a send that would put an inkling in a conversation with
 * anyone but its owner and that owner's other inklings, or that comes from
 * anyone but that owner or, as a reply, one of those inklings. A send that
 * touches no inkling passes untouched.
 */
export async function assertInklingThreadAllowed(
  supabase: SupabaseClient,
  input: {
    sender: Principal;
    /** Every SB this send puts on the thread: recipients, and an SB sender. */
    participantSbs: SbPrincipal[];
    existingThreadId: string | null;
  },
  ownerTestUserIds: OwnerTestAllowlist = inklingOwnerTestUserIds()
): Promise<InklingThreadVerdict> {
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
  if (sbIds.size === 0) return { quiet: false };

  const { data, error } = await supabase
    .from('agent_identities')
    .select('id, user_id, metadata')
    .in('id', [...sbIds]);
  if (error) throw new Error(`Failed to read the conversation's SBs: ${error.message}`);
  const identities = (data ?? []) as IdentityRow[];
  const inklings = identities.filter((r) => r.metadata?.client === INKLING_CLIENT);
  if (inklings.length === 0) return { quiet: false };

  if (ownerTestUserIds.size === 0) {
    throw new InklingThreadRefusedError(INKLINGS_DISABLED, 'Inklings are not open on this server');
  }
  // The inklings' owner, who must be one of the owner test's accounts.
  const owner = inklings[0].user_id.toLowerCase();
  const sender = input.sender;
  const fromOwner = sender.kind === 'user' && sender.userId.toLowerCase() === owner;
  // A member answering: in a conversation it is already in, with its owner
  // in it too, to members already there. Never a new conversation, never
  // one its owner has left, and never bringing anyone in. Every SB here is
  // one of the owner's inklings (below), so a member sender is one too.
  const replyFromInkling =
    sender.kind === 'sb' &&
    members.has(sender.sbId) &&
    input.participantSbs.every((sb) => members.has(sb.sbId)) &&
    people.has(owner);
  const allowed =
    isInklingOwnerTestUser(owner, ownerTestUserIds) &&
    (fromOwner || replyFromInkling) &&
    // Every SB in the conversation is an inkling: none is another SB, and
    // none is an id with no identity row.
    inklings.length === sbIds.size &&
    sbIds.size <= MAX_CONVERSATION_INKLINGS &&
    inklings.every(
      (inkling) => inkling.user_id.toLowerCase() === owner && inkling.metadata?.ownerTest === true
    ) &&
    [...people].every((person) => person === owner);
  if (!allowed) {
    throw new InklingThreadRefusedError(
      INKLING_THREAD_REFUSED,
      "An inkling's conversation is only between its owner and the owner's own inklings"
    );
  }
  return { quiet: sender.kind === 'sb' };
}
