import {
  createThreadDrainState,
  drainLegacyInbox,
  drainThreads,
  type PollDeps,
} from '@inklabs/shared';

/** Existing routing/ack contract, not a second mailbox implementation. */
export function createCodexMailPoller(deps: PollDeps) {
  const state = createThreadDrainState();
  return async () => {
    const result = await deps.callInk('get_inbox', {
      sbSlug: deps.sbSlug,
      status: 'unread',
      markRead: false,
      channelPoll: true,
      limit: 20,
    });
    if (!result?.success || result.channelPollIncomplete)
      throw new Error('Inkmail discovery unavailable');
    const threadResult = await drainThreads(
      deps,
      state,
      (result.threadsWithUnread as Array<Record<string, unknown>>) ?? [],
      { moreThreadsPending: result.unreadThreadsTruncated === true }
    );
    const legacyResult = await drainLegacyInbox(
      deps,
      state.seenMessageIds,
      (result.messages as Array<Record<string, unknown>>) ?? [],
      (msg) => {
        const ink = (msg.metadata as any)?.pcp;
        if (ink?.recipient?.studioId && ink.recipient.studioId !== deps.studioId) return 'foreign';
        if (
          msg.senderSlug === deps.sbSlug &&
          (!ink?.sender?.studioId || ink.sender.studioId === deps.studioId)
        )
          return 'skip';
        return 'deliver';
      }
    );
    return { threadResult, legacyResult };
  };
}
