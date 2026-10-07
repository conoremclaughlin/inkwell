import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentGateway, type AgentTriggerPayload } from '../../channels/agent-gateway';
import { TriggerRetryScheduler, getTriggerAttempt } from '../../channels/trigger-retry';
import { logger } from '../../utils/logger';
import {
  attachReplyChain,
  dropReplyChainsFor,
  inklingWakeDue,
  inTurnNote,
  openReplyChain,
  replyChainWakeDue,
  replyOrder,
  resetReplyChains,
  routedInReplyChain,
  routingDoneInReplyChain,
  stoppedSinceTicket,
  supersedeReplyChain,
  takeReplyTicket,
  waitingInReplyChain,
  wakeNextInReplyChain,
  type ReplyChain,
} from './inkling-reply-chain';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const OWNER_MESSAGE = 'message-owner-1';
const member = (slug: string) => ({ sbId: `sb-${slug}`, sbSlug: slug });
const wakeFor = (slug: string, threadMessageId = OWNER_MESSAGE): AgentTriggerPayload => ({
  fromSlug: 'user',
  toSlug: slug,
  toSbId: `sb-${slug}`,
  threadId: 'thread-a',
  threadMessageId,
  triggerType: 'message',
});
const ended = (slug: string, threadMessageId = OWNER_MESSAGE) => ({
  threadMessageId,
  toSbId: `sb-${slug}`,
});

/** A gateway stand-in: every wake it is sent, accepted unless told otherwise. */
function wakes(refuse: string[] = []) {
  const sent: AgentTriggerPayload[] = [];
  const dispatch = vi.fn((payload: AgentTriggerPayload) => {
    sent.push(payload);
    return { accepted: !refuse.includes(payload.toSlug) };
  });
  return { sent, dispatch, slugs: () => sent.map((p) => p.toSlug) };
}

/** Opens a chain and routes every member at once, as a request with no delays would. */
function openRouted(
  slugs: string[],
  dispatch: (p: AgentTriggerPayload) => { accepted?: boolean },
  threadMessageId = OWNER_MESSAGE,
  ticket = takeReplyTicket()
): ReplyChain {
  const chain = openReplyChain({
    threadId: 'thread-a',
    ownerMessageId: threadMessageId,
    ticket,
    members: slugs.map(member),
  });
  for (const slug of slugs) {
    routedInReplyChain(chain, `sb-${slug}`, wakeFor(slug, threadMessageId), dispatch);
  }
  routingDoneInReplyChain(chain, dispatch);
  return chain;
}

/** What the trigger handler does when a wake's turn has finished. */
const turnFinished = (payload: AgentTriggerPayload) => {
  payload.metadata = { ...(payload.metadata ?? {}), triggerTurnCompleted: true };
};

beforeEach(() => resetReplyChains());

describe('who answers first', () => {
  it('is a stable order by slug, rotated one place per round in a conversation', () => {
    const members = [member('tam'), member('pip'), member('kit')];
    const firsts = [1, 2, 3, 4].map(() => replyOrder('thread-a', members).map((m) => m.sbSlug));
    expect(firsts).toEqual([
      ['kit', 'pip', 'tam'],
      ['pip', 'tam', 'kit'],
      ['tam', 'kit', 'pip'],
      ['kit', 'pip', 'tam'],
    ]);
    // Another conversation keeps its own rounds.
    expect(replyOrder('thread-b', members)[0]?.sbSlug).toBe('kit');
  });
});

describe('a chain of members answering one owner message', () => {
  it('wakes the next only when the current member ends, once each, then is done', () => {
    const gate = wakes();
    const chain = openRouted(['pip', 'tam', 'kit'], gate.dispatch);
    expect(gate.slugs()).toEqual(['pip']);
    // Nobody else's ending moves it.
    wakeNextInReplyChain(ended('tam'), gate.dispatch);
    wakeNextInReplyChain(ended('pip', 'message-other'), gate.dispatch);
    wakeNextInReplyChain({ ...ended('pip'), routeOnly: true }, gate.dispatch);
    expect(gate.slugs()).toEqual(['pip']);
    wakeNextInReplyChain(ended('pip'), gate.dispatch);
    expect(gate.slugs()).toEqual(['pip', 'tam']);
    // A retried or duplicate ending of pip's turn finds the chain past it.
    wakeNextInReplyChain(ended('pip'), gate.dispatch);
    expect(waitingInReplyChain(chain)).toEqual(['kit']);
    wakeNextInReplyChain(ended('tam'), gate.dispatch);
    wakeNextInReplyChain(ended('kit'), gate.dispatch);
    wakeNextInReplyChain(ended('kit'), gate.dispatch);
    expect(gate.slugs()).toEqual(['pip', 'tam', 'kit']);
    expect(supersedeReplyChain('thread-a', takeReplyTicket())).toBe(0);
  });

  it('wakes every member to a spawned turn, marked as a chain wake', () => {
    const gate = wakes();
    openRouted(['pip', 'tam'], gate.dispatch);
    wakeNextInReplyChain(ended('pip'), gate.dispatch);
    expect(gate.sent).toHaveLength(2);
    for (const wake of gate.sent) {
      expect(wake).toMatchObject({ forceSpawn: true, metadata: { inklingReplyChain: true } });
    }
  });

  it("wakes each later member for the owner's message, told that others answered first", () => {
    const gate = wakes();
    openRouted(['pip', 'tam'], gate.dispatch);
    wakeNextInReplyChain(ended('pip'), gate.dispatch);
    const [first, second] = gate.sent;
    expect(first?.metadata?.inklingAnswersInTurn).toBeUndefined();
    expect(second).toMatchObject({
      toSlug: 'tam',
      threadMessageId: OWNER_MESSAGE,
      metadata: { inklingAnswersInTurn: true },
    });
  });

  it('wakes a member only once its own routing is done, in order, whoever finishes first', () => {
    const gate = wakes();
    const chain = openReplyChain({
      threadId: 'thread-a',
      ownerMessageId: OWNER_MESSAGE,
      members: ['pip', 'tam', 'kit'].map(member),
    });
    // kit is routed before tam: it still waits for tam's turn.
    routedInReplyChain(chain, 'sb-kit', wakeFor('kit'), gate.dispatch);
    expect(gate.slugs()).toEqual([]);
    routedInReplyChain(chain, 'sb-pip', wakeFor('pip'), gate.dispatch);
    expect(gate.slugs()).toEqual(['pip']);
    // pip's turn ends while tam is still being routed: nothing is lost.
    wakeNextInReplyChain(ended('pip'), gate.dispatch);
    expect(gate.slugs()).toEqual(['pip']);
    routedInReplyChain(chain, 'sb-tam', wakeFor('tam'), gate.dispatch);
    expect(gate.slugs()).toEqual(['pip', 'tam']);
    routingDoneInReplyChain(chain, gate.dispatch);
    wakeNextInReplyChain(ended('tam'), gate.dispatch);
    expect(gate.slugs()).toEqual(['pip', 'tam', 'kit']);
  });

  it('passes over a member its request never routed, rather than waiting for it', () => {
    const gate = wakes();
    const chain = openReplyChain({
      threadId: 'thread-a',
      ownerMessageId: OWNER_MESSAGE,
      members: ['pip', 'tam', 'kit'].map(member),
    });
    routedInReplyChain(chain, 'sb-pip', wakeFor('pip'), gate.dispatch);
    routedInReplyChain(chain, 'sb-kit', wakeFor('kit'), gate.dispatch);
    wakeNextInReplyChain(ended('pip'), gate.dispatch);
    expect(gate.slugs()).toEqual(['pip']);
    routingDoneInReplyChain(chain, gate.dispatch);
    expect(gate.slugs()).toEqual(['pip', 'kit']);
  });

  it('wakes the next member, one at a time, when a wake is not accepted', () => {
    const gate = wakes(['pip']);
    openRouted(['pip', 'tam', 'kit'], gate.dispatch);
    expect(gate.slugs()).toEqual(['pip', 'tam']);
    // tam is the first that will answer: it isn't told others answered first.
    expect(gate.sent[1]?.metadata?.inklingAnswersInTurn).toBeUndefined();
    wakeNextInReplyChain(ended('tam'), gate.dispatch);
    expect(gate.slugs()).toEqual(['pip', 'tam', 'kit']);
  });
});

describe('a newer owner message', () => {
  it('ends a chain still waiting on the older one', () => {
    const gate = wakes();
    openRouted(['pip', 'tam', 'kit'], gate.dispatch);
    expect(supersedeReplyChain('thread-a', takeReplyTicket())).toBe(2);
    wakeNextInReplyChain(ended('pip'), gate.dispatch);
    expect(gate.slugs()).toEqual(['pip']);
  });

  it('ends a chain still being routed: its request wakes nobody further', () => {
    const gate = wakes();
    const older = openReplyChain({
      threadId: 'thread-a',
      ownerMessageId: OWNER_MESSAGE,
      ticket: takeReplyTicket(),
      members: ['pip', 'tam'].map(member),
    });
    routedInReplyChain(older, 'sb-pip', wakeFor('pip'), gate.dispatch);
    openRouted(['tam', 'pip'], gate.dispatch, 'message-owner-2');
    expect(gate.slugs()).toEqual(['pip', 'tam']);
    // The older request finishes routing after the newer message: nothing.
    routedInReplyChain(older, 'sb-tam', wakeFor('tam'), gate.dispatch);
    routingDoneInReplyChain(older, gate.dispatch);
    wakeNextInReplyChain(ended('pip'), gate.dispatch);
    expect(gate.slugs()).toEqual(['pip', 'tam']);
    // The newer chain goes on.
    wakeNextInReplyChain(ended('tam', 'message-owner-2'), gate.dispatch);
    expect(gate.slugs()).toEqual(['pip', 'tam', 'pip']);
    expect(gate.sent[2]?.threadMessageId).toBe('message-owner-2');
  });

  it('is never replaced by the chain of an older send that decided later', () => {
    const gate = wakes();
    const [olderTicket, newerTicket] = [takeReplyTicket(), takeReplyTicket()];
    openRouted(['pip', 'tam'], gate.dispatch, 'message-owner-2', newerTicket);
    const older = openRouted(['tam', 'pip'], gate.dispatch, OWNER_MESSAGE, olderTicket);
    expect(gate.slugs()).toEqual(['pip']);
    expect(waitingInReplyChain(older)).toEqual([]);
    // Nor ended by an older send naming a member.
    expect(supersedeReplyChain('thread-a', olderTicket)).toBe(0);
    wakeNextInReplyChain(ended('pip', 'message-owner-2'), gate.dispatch);
    expect(gate.slugs()).toEqual(['pip', 'tam']);
  });
});

describe('Stop', () => {
  it('drops every chain the member is in, under way, waiting or being routed', () => {
    const gate = wakes();
    openRouted(['pip', 'tam', 'kit'], gate.dispatch);
    const routing = openReplyChain({
      threadId: 'thread-b',
      ownerMessageId: 'message-owner-b',
      ticket: takeReplyTicket(),
      members: ['kit', 'pip'].map(member),
    });
    // Stopping a waiting member ends its chains too.
    expect(dropReplyChainsFor('sb-tam')).toBe(2);
    wakeNextInReplyChain(ended('pip'), gate.dispatch);
    expect(gate.slugs()).toEqual(['pip']);
    // The other conversation's chain, still being routed, ends when pip stops.
    expect(dropReplyChainsFor('sb-pip')).toBe(2);
    routedInReplyChain(routing, 'sb-kit', wakeFor('kit', 'message-owner-b'), gate.dispatch);
    routingDoneInReplyChain(routing, gate.dispatch);
    expect(gate.slugs()).toEqual(['pip']);
    expect(dropReplyChainsFor('sb-pip')).toBe(0);
  });

  it('ends a send that arrived before the Stop and had not opened its chain yet', () => {
    const gate = wakes();
    const ticket = takeReplyTicket();
    expect(stoppedSinceTicket('sb-tam', ticket)).toBe(false);
    dropReplyChainsFor('sb-tam');
    expect(stoppedSinceTicket('sb-tam', ticket)).toBe(true);
    expect(stoppedSinceTicket('sb-pip', ticket)).toBe(false);
    const chain = openRouted(['pip', 'tam'], gate.dispatch, OWNER_MESSAGE, ticket);
    expect(gate.slugs()).toEqual([]);
    expect(waitingInReplyChain(chain)).toEqual([]);
    // A send that arrives after the Stop is answered as usual.
    expect(stoppedSinceTicket('sb-tam', takeReplyTicket())).toBe(false);
    openRouted(['pip', 'tam'], gate.dispatch, 'message-owner-2');
    expect(gate.slugs()).toEqual(['pip']);
  });
});

describe('a named or one-to-one wake', () => {
  it('is due only while its member was not stopped since and no newer send has decided', () => {
    const older = takeReplyTicket();
    supersedeReplyChain('thread-a', older);
    expect(inklingWakeDue('thread-a', 'sb-pip', older)).toBe(true);
    const newer = takeReplyTicket();
    supersedeReplyChain('thread-a', newer);
    expect(inklingWakeDue('thread-a', 'sb-pip', older)).toBe(false);
    expect(inklingWakeDue('thread-a', 'sb-pip', newer)).toBe(true);
    // Another conversation's sends change nothing here.
    supersedeReplyChain('thread-b', takeReplyTicket());
    expect(inklingWakeDue('thread-a', 'sb-pip', newer)).toBe(true);
    dropReplyChainsFor('sb-pip');
    expect(inklingWakeDue('thread-a', 'sb-pip', newer)).toBe(false);
    expect(inklingWakeDue('thread-a', 'sb-tam', newer)).toBe(true);
  });
});

describe('a retry of a chain wake', () => {
  it('is wanted only while its chain waits on that member, and is ended by Stop', () => {
    const gate = wakes();
    openRouted(['pip', 'tam'], gate.dispatch);
    const pipWake = gate.sent[0]!;
    expect(replyChainWakeDue(pipWake)).toBe(true);
    expect(replyChainWakeDue({ ...wakeFor('tam'), metadata: { inklingReplyChain: true } })).toBe(
      false
    );
    // Any other wake is retried as before.
    expect(replyChainWakeDue(wakeFor('tam'))).toBe(true);
    dropReplyChainsFor('sb-tam');
    expect(replyChainWakeDue(pipWake)).toBe(false);
  });

  it('is not wanted once a newer owner message has ended its chain', () => {
    const gate = wakes();
    openRouted(['pip', 'tam'], gate.dispatch);
    const pipWake = gate.sent[0]!;
    supersedeReplyChain('thread-a', takeReplyTicket());
    expect(replyChainWakeDue(pipWake)).toBe(false);
  });
});

describe('what a member answering in turn is told', () => {
  it('is only for a wake marked in turn, and lets it stay quiet', () => {
    expect(inTurnNote(undefined)).toBeNull();
    expect(inTurnNote({})).toBeNull();
    expect(inTurnNote({ inklingAnswersInTurn: 'yes' })).toBeNull();
    const note = inTurnNote({ inklingAnswersInTurn: true });
    expect(note).toMatch(/answered this message before you/);
    expect(note).toMatch(/Read their replies in the thread first/);
    expect(note).toMatch(/end your turn without sending a message/);
  });
});

describe('through the real gateway', () => {
  const drain = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  afterEach(() => vi.useRealTimers());

  it('moves on after a processed turn and a failed one that will not be retried, never on assignment', async () => {
    const gateway = new AgentGateway();
    const handled: string[] = [];
    gateway.setDefaultHandler(async (payload) => {
      handled.push(payload.routeOnly ? `${payload.toSlug} (routed)` : payload.toSlug);
      if (payload.toSlug === 'tam' && !payload.routeOnly) throw new Error('the turn failed');
      if (!payload.routeOnly) turnFinished(payload);
    });
    const wakeFailed = attachReplyChain(gateway);
    // The failure listener's part (server.ts): no retry is coming for tam.
    gateway.on('trigger:error', ({ payload }) => wakeFailed(payload));

    // Assigning a member's session starts no turn and moves nothing.
    await gateway.processTrigger({ ...wakeFor('pip'), routeOnly: true });
    openRouted(['pip', 'tam', 'kit'], (p) => gateway.dispatchTrigger(p));
    await vi.waitFor(() => expect(handled).toEqual(['pip (routed)', 'pip', 'tam', 'kit']));
  });

  it('keeps a failed member in its place while its retry is pending, so the two never overlap', async () => {
    vi.useFakeTimers();
    const gateway = new AgentGateway();
    const handled: string[] = [];
    gateway.setDefaultHandler(async (payload) => {
      handled.push(`${payload.toSlug}#${getTriggerAttempt(payload)}`);
      if (payload.toSlug === 'pip' && getTriggerAttempt(payload) === 1)
        throw new Error('fetch failed');
      turnFinished(payload);
    });
    // As server.ts sends a retry: only while its chain still wants it.
    const retry = new TriggerRetryScheduler((payload) => {
      if (replyChainWakeDue(payload)) gateway.dispatchTrigger(payload);
    });
    const wakeFailed = attachReplyChain(gateway);
    gateway.on('trigger:error', ({ payload, error }) => {
      const scheduled = retry.scheduleRetry(
        payload,
        { category: 'network', summary: 'fetch failed', retryable: true },
        error
      );
      if (!scheduled.scheduled) wakeFailed(payload);
    });
    openRouted(['pip', 'tam'], (p) => gateway.dispatchTrigger(p));
    await drain();
    expect(handled).toEqual(['pip#1']);
    await vi.advanceTimersByTimeAsync(120_000);
    await drain();
    expect(handled).toEqual(['pip#1', 'pip#2', 'tam#1']);
    retry.clear();
  });

  it('never sends a pending retry after Stop has ended its chain', async () => {
    vi.useFakeTimers();
    const gateway = new AgentGateway();
    const handled: string[] = [];
    gateway.setDefaultHandler(async (payload) => {
      handled.push(`${payload.toSlug}#${getTriggerAttempt(payload)}`);
      if (getTriggerAttempt(payload) === 1) throw new Error('fetch failed');
      turnFinished(payload);
    });
    const retry = new TriggerRetryScheduler((payload) => {
      if (replyChainWakeDue(payload)) gateway.dispatchTrigger(payload);
    });
    attachReplyChain(gateway);
    gateway.on('trigger:error', ({ payload, error }) =>
      retry.scheduleRetry(
        payload,
        { category: 'network', summary: 'fetch failed', retryable: true },
        error
      )
    );
    openRouted(['pip', 'tam'], (p) => gateway.dispatchTrigger(p));
    await drain();
    expect(retry.pendingCount).toBe(1);
    dropReplyChainsFor('sb-pip');
    await vi.advanceTimersByTimeAsync(120_000);
    await drain();
    expect(handled).toEqual(['pip#1']);
  });

  it('ends the chain when a wake is processed without a finished turn, telling nobody others answered', async () => {
    const gateway = new AgentGateway();
    const handled: string[] = [];
    // Delivered somewhere whose end the server cannot see: no finished turn.
    gateway.setDefaultHandler(async (payload) => void handled.push(payload.toSlug));
    attachReplyChain(gateway);
    openRouted(['pip', 'tam'], (p) => gateway.dispatchTrigger(p));
    await drain();
    expect(handled).toEqual(['pip']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/without a finished turn/),
      expect.objectContaining({ toSlug: 'pip', notWoken: ['tam'] })
    );
    expect(supersedeReplyChain('thread-a', takeReplyTicket())).toBe(0);
  });

  it('does not strand the last member when a middle wake has nowhere to go (Lumen)', async () => {
    const gateway = new AgentGateway();
    const handled: string[] = [];
    gateway.registerHandler('pip', async (payload) => {
      handled.push('pip');
      turnFinished(payload);
    });
    gateway.registerHandler('kit', async (payload) => {
      handled.push('kit');
      turnFinished(payload);
    });
    attachReplyChain(gateway);
    openRouted(['pip', 'tam', 'kit'], (p) => gateway.dispatchTrigger(p));
    await vi.waitFor(() => expect(handled).toEqual(['pip', 'kit']));
  });
});
