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
 *
 * One exception, in a team space only (inkling-shared-space.ts): a
 * conversation shared with the space's people. That is a group created with
 * other people of the space (`inklingShared`), or a public conversation
 * (conversation_mode 'public', conversation-mode.ts), which any write-role
 * member of the space may start or join by posting. Its people are
 * write-role members of the inklings' space, any of them may write, and a
 * member inkling answers whoever is present. A starter space, and every
 * other conversation, keeps the owner-only rule.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  inklingOwnerTestUserIds,
  isInklingOwnerTestUser,
  type OwnerTestAllowlist,
} from '../../config/inkling-flags';
import type { Principal, SbPrincipal } from '../principals';
import { INKLING_CLIENT, INKLINGS_DISABLED } from './inkling-service';
import { areSpaceWriters, INKLING_SHARED_MARK, isSharedInklingSpace } from './inkling-shared-space';
import { isPublicConversation } from '../threads/conversation-mode';

export const INKLING_THREAD_REFUSED = 'inkling_thread_refused';

/** The most inklings one owner-present conversation may hold. */
export const MAX_CONVERSATION_INKLINGS = 3;

/** The thread-row metadata key that marks an inkling conversation from its creation. */
export const INKLING_CONVERSATION_MARK = 'inklingConversation';

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
  workspace_id: string | null;
  metadata: Record<string, unknown> | null;
}

/** What an allowed send may do besides being written. */
export interface InklingThreadVerdict {
  /** True when an inkling is the sender: its send must wake nobody. */
  quiet: boolean;
  /** True when the conversation holds an inkling, so its members are fixed at creation. */
  inklingConversation: boolean;
  /**
   * True when the conversation is a group shared with the space's people
   * (inkling-shared-space.ts): created as a group with people in a team
   * space, or one already marked so. A public conversation without people
   * is not one: it carries its mode, not this mark.
   */
  shared: boolean;
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
    /**
     * People this send puts on a conversation it creates, beside its sender:
     * a group in a team space (POST /threads `people`). Never on a reply.
     */
    addedPeople?: string[];
    /**
     * This send creates a public conversation (POST /threads `mode`), which
     * a write-role member of a team space may start with its inkling.
     */
    creatingPublic?: boolean;
  },
  ownerTestUserIds: OwnerTestAllowlist = inklingOwnerTestUserIds()
): Promise<InklingThreadVerdict> {
  const sbIds = new Set(input.participantSbs.map((sb) => sb.sbId));
  const people = new Set<string>();
  /** The SBs already in the conversation, before this send. */
  const members = new Set<string>();
  /**
   * Marked as an inkling conversation on its thread row, which is written
   * in the same insert that creates the thread: true before any of its
   * members' rows can be seen.
   */
  let marked = false;
  /** Created as a group shared with the space's people. */
  let sharedMark = false;
  /** Created public to the space's people (conversation_mode). */
  let publicMode = false;
  if (input.existingThreadId) {
    const { data: threadRows, error: threadError } = await supabase
      .from('inbox_threads')
      .select('metadata, conversation_mode')
      .eq('id', input.existingThreadId);
    if (threadError) throw new Error(`Failed to read the conversation: ${threadError.message}`);
    const [threadRow] = (threadRows ?? []) as Array<{
      metadata: Record<string, unknown> | null;
      conversation_mode: string | null;
    }>;
    marked = threadRow?.metadata?.[INKLING_CONVERSATION_MARK] === true;
    sharedMark = threadRow?.metadata?.[INKLING_SHARED_MARK] === true;
    publicMode = isPublicConversation(threadRow ?? {});
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
  // The SB acting, when this write puts someone else on the thread
  // (add_thread_participant's caller). It is classified too, or an inkling
  // acting outside its own conversation would read as an ordinary write. It
  // is not counted among the conversation's SBs: it joins nothing.
  const actorSbId =
    input.sender.kind === 'sb' && !sbIds.has(input.sender.sbId) ? input.sender.sbId : null;
  const addedPeople = [...new Set((input.addedPeople ?? []).map((id) => id.toLowerCase()))];
  if (addedPeople.length > 0 && input.existingThreadId !== null && !sharedMark) {
    // People join a conversation only as it is made, never after. The one
    // exception is a retry finishing its own interrupted create (POST
    // /threads adoption), on the thread that create marked shared; the
    // people it names are held to the same membership as at creation below
    // (Lumen's review of 4f7896e6).
    throw new InklingThreadRefusedError(
      INKLING_THREAD_REFUSED,
      'People are added to a conversation only when it is created'
    );
  }
  if (sbIds.size === 0 && !marked && !actorSbId) {
    return { quiet: false, inklingConversation: false, shared: false };
  }

  const lookup = actorSbId ? [...sbIds, actorSbId] : [...sbIds];
  let identities: IdentityRow[] = [];
  if (lookup.length > 0) {
    const { data, error } = await supabase
      .from('agent_identities')
      .select('id, user_id, workspace_id, metadata')
      .in('id', lookup);
    if (error) throw new Error(`Failed to read the conversation's SBs: ${error.message}`);
    identities = (data ?? []) as IdentityRow[];
  }
  const isInkling = (r: IdentityRow) => r.metadata?.client === INKLING_CLIENT;
  // An inkling writes only as a member of its own conversation, so one
  // acting on a conversation it is not in is refused, whatever that holds.
  if (actorSbId && identities.some((r) => r.id === actorSbId && isInkling(r))) {
    throw new InklingThreadRefusedError(
      INKLING_THREAD_REFUSED,
      "An inkling's conversation is only between its owner and the owner's own inklings"
    );
  }
  const inklings = identities.filter((r) => sbIds.has(r.id) && isInkling(r));
  if (inklings.length === 0) {
    if (!marked) return { quiet: false, inklingConversation: false, shared: false };
    // An inkling conversation whose inklings this send cannot see yet: its
    // creator is still writing them. Nothing joins it on that view.
    throw new InklingThreadRefusedError(
      INKLING_THREAD_REFUSED,
      "An inkling's conversation is only between its owner and the owner's own inklings"
    );
  }

  if (ownerTestUserIds.size === 0) {
    throw new InklingThreadRefusedError(INKLINGS_DISABLED, 'Inklings are not open on this server');
  }
  // The inklings' owner, who must be one of the owner test's accounts.
  const owner = inklings[0].user_id.toLowerCase();
  const sender = input.sender;
  const fromOwner = sender.kind === 'user' && sender.userId.toLowerCase() === owner;
  // A member inkling answering, in a conversation it is already in. Never
  // a new conversation. Every SB here is one of the owner's inklings
  // (below), so a member sender is one too.
  const fromMemberInkling = sender.kind === 'sb' && members.has(sender.sbId);
  // Members are fixed when a conversation is created: no send, the
  // owner's included, adds an SB to one that exists. Adding is what two
  // concurrent sends could each do against the same snapshot of members.
  const noNewMembers =
    input.existingThreadId === null || input.participantSbs.every((sb) => members.has(sb.sbId));
  const inklingsHold =
    isInklingOwnerTestUser(owner, ownerTestUserIds) &&
    noNewMembers &&
    // Every SB in the conversation is an inkling: none is another SB, and
    // none is an id with no identity row.
    inklings.length === sbIds.size &&
    sbIds.size <= MAX_CONVERSATION_INKLINGS &&
    inklings.every(
      (inkling) => inkling.user_id.toLowerCase() === owner && inkling.metadata?.ownerTest === true
    );
  // The owner's own conversation: the owner writes, or a member inkling
  // answers with its owner in it too (never one its owner has left), and
  // nobody else is in it.
  const ownersOwn =
    inklingsHold &&
    !sharedMark &&
    addedPeople.length === 0 &&
    (fromOwner || (fromMemberInkling && people.has(owner))) &&
    [...people].every((person) => person === owner);
  if (ownersOwn) return { quiet: sender.kind === 'sb', inklingConversation: true, shared: false };

  // A conversation shared with the space's people: a group created with
  // people, or marked so when it was, or a public conversation, made so or
  // being made. Its people are write-role members of a team space, the
  // inklings' own, and a member inkling answers whoever of them is present.
  const creatingShared =
    input.existingThreadId === null && (addedPeople.length > 0 || input.creatingPublic === true);
  const space = inklings[0].workspace_id;
  const sharedShape =
    inklingsHold &&
    (sharedMark || publicMode || creatingShared) &&
    !!space &&
    inklings.every((inkling) => inkling.workspace_id === space) &&
    (sender.kind === 'user' || (fromMemberInkling && people.size > 0));
  if (sharedShape && space) {
    const writers = [...people, ...addedPeople];
    if (sender.kind === 'user') writers.push(sender.userId.toLowerCase());
    const [teamSpace, allWriters] = await Promise.all([
      isSharedInklingSpace(supabase, space),
      areSpaceWriters(supabase, space, writers),
    ]);
    if (teamSpace === 'unreadable' || allWriters === 'unreadable') {
      throw new Error("Failed to read the conversation's space");
    }
    if (teamSpace === 'yes' && allWriters === 'yes') {
      return {
        quiet: sender.kind === 'sb',
        inklingConversation: true,
        // The group mark is for a group made with people, never for a
        // public conversation made without them.
        shared: sharedMark || addedPeople.length > 0,
      };
    }
  }
  throw new InklingThreadRefusedError(
    INKLING_THREAD_REFUSED,
    "An inkling's conversation is only between its owner and the owner's own inklings"
  );
}
