/**
 * Inklings in a group answer their owner's message in turn
 * (ink://specs/inkling-group-dynamics).
 *
 * With nobody addressed, the owner's message opens a chain of the members in
 * reply order, before any of them is routed. Each member is woken only once
 * its own routing is done, and only when nobody else's wake for the message is
 * under way. When that wake ends, the next is woken with the conversation as
 * it now stands, so it reads the replies before it. Each member is woken once
 * per message: that is the loop guard, and an inkling's own reply still wakes
 * nobody (inkling-thread-gate.ts).
 *
 * A wake has ended when its turn finished, or when it failed and no retry is
 * coming. Chain wakes always spawn a turn, never an inline delivery to a live
 * CLI, so a finished turn is a real signal (triggerTurnCompleted). A failed
 * wake that will be retried keeps its place, so a retry never runs beside the
 * next member's turn, and a retry whose chain has since ended is not sent. A
 * wake the gateway does not accept has no turn to end, so the next member is
 * woken at once, still one at a time.
 *
 * Every later wake carries the OWNER's message id, never the previous
 * inkling's reply: the turn gate admits an inkling only for a stored message
 * its owner sent (inkling-turn-gate.ts).
 *
 * What came first is decided by tickets, taken when each owner's send reaches
 * the server and before anything else it does (routes/admin.ts), so no await
 * can let a later Stop or send overtake it unseen. A newer owner message in the
 * same conversation ends the chain of an older one, whether that chain is
 * waiting, being routed or not yet opened: the person has moved on, so members
 * not yet woken are not woken for the older message. Stopping a member ends
 * every chain it belongs to, before its running turn is aborted, so the abort
 * cannot wake the next one (InklingService.cancel). It also ends any send that
 * had arrived before the Stop and has not opened its chain yet. The request
 * that opened a chain asks whether it is still live at every step, so an ended
 * chain wakes nobody further.
 *
 * This lives in memory, like the turn registry (inkling-turns.ts) and the
 * stop fence (inkling-stop-fence.ts): one API process holds it, and a restart
 * loses members still waiting. The owner's message keeps whatever replies it
 * already has.
 */
import type { AgentTriggerPayload } from '../../channels/agent-gateway';
import { logger } from '../../utils/logger';

export interface SbRef {
  sbId: string;
  sbSlug: string;
}

/** Sends one wake and says whether the gateway accepted it. */
export type DispatchWake = (payload: AgentTriggerPayload) => { accepted?: boolean };

interface Member extends SbRef {
  /** Its wake, once its routing is done. */
  payload?: AgentTriggerPayload;
}

interface Chain {
  threadId: string;
  ownerMessageId: string;
  /** The ticket its send took on arrival. */
  ticket: number;
  /** Members not woken yet, in reply order. */
  waiting: Member[];
  /** The member whose wake for this message is under way, if any. */
  current: string | null;
  /** Whether a member's wake has been accepted; those after it are told so. */
  answered: boolean;
  /** The request that opened it is still routing its members. */
  routing: boolean;
}

/** A chain as the request that opened it holds it. */
export type ReplyChain = Readonly<Pick<Chain, 'threadId' | 'ownerMessageId'>>;

const byMessage = new Map<string, Chain>();
const byThread = new Map<string, Chain>();
let lastTicket = 0;
/** Per conversation, the newest ticket whose send has decided who answers. */
const newestByThread = new Map<string, number>();
/** Per inkling, the newest ticket handed out when it was last stopped. */
const stoppedAt = new Map<string, number>();
/** How many rounds each conversation has started, so who goes first rotates. */
const rounds = new Map<string, number>();

/**
 * The order members answer in: a stable order by slug, rotated one place per
 * round in this conversation, so the same inkling doesn't always go first.
 */
export function replyOrder<T extends SbRef>(threadId: string, members: T[]): T[] {
  const sorted = [...members].sort((a, b) => a.sbSlug.localeCompare(b.sbSlug));
  if (sorted.length < 2) return sorted;
  const round = rounds.get(threadId) ?? 0;
  rounds.set(threadId, round + 1);
  const start = round % sorted.length;
  return [...sorted.slice(start), ...sorted.slice(0, start)];
}

function forget(chain: Chain): void {
  if (byMessage.get(chain.ownerMessageId) === chain) byMessage.delete(chain.ownerMessageId);
  if (byThread.get(chain.threadId) === chain) byThread.delete(chain.threadId);
}

/** The chain if it is still the live one for its message, else undefined. */
function live(chain: ReplyChain): Chain | undefined {
  const found = byMessage.get(chain.ownerMessageId);
  return found === chain ? found : undefined;
}

/**
 * Taken by an owner's send as it arrives, before anything else it does: the
 * order of tickets is the order the person did things in.
 */
export function takeReplyTicket(): number {
  return ++lastTicket;
}

/** Whether `sbId` was stopped after the send holding `ticket` arrived. */
export function stoppedSinceTicket(sbId: string, ticket: number): boolean {
  return (stoppedAt.get(sbId) ?? 0) >= ticket;
}

/**
 * Whether an owner's send that names its members, or has one, should still
 * wake `sbId`: that member wasn't stopped after the send arrived, and no newer
 * send in the conversation has decided who answers. The send asks just before
 * each wake, after routing's awaits, not when it decides who answers.
 */
export function inklingWakeDue(threadId: string, sbId: string, ticket: number): boolean {
  return !stoppedSinceTicket(sbId, ticket) && (newestByThread.get(threadId) ?? 0) <= ticket;
}

/**
 * An owner's send in this conversation has decided who answers: a chain of an
 * older send ends, whether waiting or still being routed. A send older than
 * one that already decided changes nothing, since two sends can finish out of
 * order. Returns how many members were not woken.
 */
export function supersedeReplyChain(threadId: string, ticket: number): number {
  if ((newestByThread.get(threadId) ?? 0) > ticket) return 0;
  newestByThread.set(threadId, ticket);
  const chain = byThread.get(threadId);
  if (!chain) return 0;
  forget(chain);
  return chain.waiting.length;
}

/**
 * Opens the chain for an owner's message, before any member is routed, and
 * ends the conversation's older chain. It starts ended, and wakes nobody, if
 * a newer send in the conversation has already decided, or if any member was
 * stopped after this send arrived.
 */
export function openReplyChain(input: {
  threadId: string;
  ownerMessageId: string;
  ticket: number;
  members: SbRef[];
}): ReplyChain {
  const chain: Chain = {
    threadId: input.threadId,
    ownerMessageId: input.ownerMessageId,
    ticket: input.ticket,
    waiting: input.members.map(({ sbId, sbSlug }) => ({ sbId, sbSlug })),
    current: null,
    answered: false,
    routing: true,
  };
  if ((newestByThread.get(input.threadId) ?? 0) > input.ticket) return chain;
  if (input.members.some((m) => stoppedSinceTicket(m.sbId, input.ticket))) return chain;
  supersedeReplyChain(input.threadId, input.ticket);
  byMessage.set(chain.ownerMessageId, chain);
  byThread.set(chain.threadId, chain);
  return chain;
}

/** Wakes the next members while nobody's wake is under way, one accepted wake at most. */
function advance(chain: Chain, dispatch: DispatchWake): void {
  while (chain.current === null) {
    const next = chain.waiting[0];
    if (!next) {
      if (!chain.routing) forget(chain);
      return;
    }
    // Its routing isn't done: routedInReplyChain moves the chain on then.
    if (!next.payload) return;
    chain.waiting.shift();
    // Always a spawned turn, so its end is a real signal; marked as a chain
    // wake, so a retry can ask whether its chain still wants it.
    const payload: AgentTriggerPayload = {
      ...next.payload,
      forceSpawn: true,
      metadata: {
        ...(next.payload.metadata ?? {}),
        inklingReplyChain: true,
        ...(chain.answered ? { inklingAnswersInTurn: true } : {}),
      },
    };
    if (dispatch(payload).accepted) {
      chain.current = next.sbId;
      chain.answered = true;
    }
    // Not accepted: no turn will end for it, so the next member goes now.
  }
}

/**
 * A member's routing is done and its wake is ready: it is woken now if it is
 * its turn, else when its turn comes. Nothing happens if the chain has ended.
 */
export function routedInReplyChain(
  chain: ReplyChain,
  sbId: string,
  payload: AgentTriggerPayload,
  dispatch: DispatchWake
): void {
  const open = live(chain);
  const member = open?.waiting.find((m) => m.sbId === sbId);
  if (!open || !member) return;
  member.payload = payload;
  advance(open, dispatch);
}

/**
 * The request has routed every member it could. A member it never readied is
 * passed over rather than waited for.
 */
export function routingDoneInReplyChain(chain: ReplyChain, dispatch: DispatchWake): void {
  const open = live(chain);
  if (!open) return;
  open.routing = false;
  open.waiting = open.waiting.filter((m) => m.payload);
  advance(open, dispatch);
}

/** The members of a live chain not woken yet. */
export function waitingInReplyChain(chain: ReplyChain): string[] {
  return live(chain)?.waiting.map((m) => m.sbSlug) ?? [];
}

/**
 * `finished`'s wake has ended: if it was its chain's current member, the next
 * is woken. Any other ending (an earlier member's, a duplicate, route-only
 * assignment) moves nothing.
 */
export function wakeNextInReplyChain(
  finished: { threadMessageId?: string; toSbId?: string; routeOnly?: boolean },
  dispatch: DispatchWake
): void {
  if (finished.routeOnly || !finished.threadMessageId || !finished.toSbId) return;
  const chain = byMessage.get(finished.threadMessageId);
  if (!chain || chain.current !== finished.toSbId) return;
  chain.current = null;
  advance(chain, dispatch);
}

/**
 * A retry of a chain wake is sent only while its chain still wants it: the
 * chain is live and that member's wake is the one under way. Stop or a newer
 * message ends the chain, and then the retry is not sent. Any other wake is.
 */
export function replyChainWakeDue(payload: AgentTriggerPayload): boolean {
  if (payload.metadata?.inklingReplyChain !== true) return true;
  const chain = payload.threadMessageId ? byMessage.get(payload.threadMessageId) : undefined;
  return !!chain && chain.current === payload.toSbId;
}

/**
 * Stopping an inkling ends every chain it is part of, under way, waiting or
 * still being routed: nobody further is woken for those messages. A send that
 * arrived before the Stop and has not decided yet is ended too (openReplyChain,
 * stoppedSinceTicket). Returns how many waiting members were dropped.
 */
export function dropReplyChainsFor(sbId: string): number {
  stoppedAt.set(sbId, lastTicket);
  let dropped = 0;
  for (const chain of [...byMessage.values()]) {
    if (chain.current !== sbId && !chain.waiting.some((m) => m.sbId === sbId)) continue;
    dropped += chain.waiting.length;
    forget(chain);
  }
  return dropped;
}

/** The part of the agent gateway the chain needs: its processed event, and a wake. */
export interface ReplyChainGateway {
  on(
    event: 'trigger:processed',
    listener: (event: { payload: AgentTriggerPayload }) => void
  ): unknown;
  dispatchTrigger(payload: AgentTriggerPayload): { accepted?: boolean };
}

/**
 * A chain wake was processed without a turn finishing: it was delivered
 * somewhere the server cannot see the end of. Its chain ends, so nobody is
 * told others answered when they may not have. Chain wakes force a spawn, so
 * this is a guard, not a path.
 */
function endChainOf(payload: AgentTriggerPayload): void {
  if (payload.routeOnly || !payload.threadMessageId) return;
  const chain = byMessage.get(payload.threadMessageId);
  if (!chain || chain.current !== payload.toSbId) return;
  forget(chain);
  logger.warn('[ReplyChain] A wake ended without a finished turn; its chain ends here', {
    threadId: chain.threadId,
    ownerMessageId: chain.ownerMessageId,
    toSlug: payload.toSlug,
    notWoken: chain.waiting.map((m) => m.sbSlug),
  });
}

/**
 * Moves every chain on as wakes end. A processed wake has ended when its turn
 * finished (the trigger handler marks triggerTurnCompleted). A failed one has
 * ended only if no retry is coming, which only the failure listener knows once
 * it has decided, so it calls the function returned here for those
 * (server.ts). server.ts attaches this once.
 */
export function attachReplyChain(
  gateway: ReplyChainGateway
): (failed: AgentTriggerPayload) => void {
  const dispatch: DispatchWake = (payload) => gateway.dispatchTrigger(payload);
  gateway.on('trigger:processed', ({ payload }) => {
    if (payload.metadata?.triggerTurnCompleted === true) wakeNextInReplyChain(payload, dispatch);
    else endChainOf(payload);
  });
  return (failed) => wakeNextInReplyChain(failed, dispatch);
}

/**
 * What a member answering in turn is told, after the thread line of its
 * wake prompt (server.ts). Null for any other wake.
 */
export function inTurnNote(metadata: Record<string, unknown> | undefined): string | null {
  if (metadata?.inklingAnswersInTurn !== true) return null;
  return 'Other inklings in this conversation answered this message before you. Read their replies in the thread first. Add what you see differently or what they missed; if you have nothing to add, end your turn without sending a message.';
}

/** Test seam: forget every chain, round, ticket and stop. */
export function resetReplyChains(): void {
  byMessage.clear();
  byThread.clear();
  rounds.clear();
  newestByThread.clear();
  stoppedAt.clear();
  lastTicket = 0;
}
