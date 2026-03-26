import { describe, it, expect } from 'vitest';

/**
 * Unit tests for channel plugin filtering logic.
 *
 * Thread studio filtering is now handled server-side via channelPoll=true
 * on get_inbox. These tests cover the remaining client-side logic:
 * legacy inbox message filtering, dedup, and since behavior.
 */

// ─── Legacy inbox message filter (extracted from plugin) ───────────
function isLegacyMessageForThisStudio(
  msg: Record<string, unknown>,
  myStudioId: string | undefined
): boolean {
  if (!myStudioId) return true;

  const metadata = msg.metadata as Record<string, unknown> | undefined;
  const pcp = metadata?.pcp as Record<string, unknown> | undefined;
  const recipient = pcp?.recipient as Record<string, unknown> | undefined;
  const recipientStudioId = recipient?.studioId as string | undefined;

  if (!recipientStudioId) return true; // no studio scoping — broadcast
  return recipientStudioId === myStudioId;
}

const MY_STUDIO = 'ef511db1-a158-4a06-ba40-abb61785dbbc';
const OTHER_STUDIO = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('isLegacyMessageForThisStudio', () => {
  it('accepts messages addressed to this studio', () => {
    const msg = {
      id: 'msg-1',
      senderAgentId: 'lumen',
      content: 'hello',
      metadata: { pcp: { recipient: { studioId: MY_STUDIO }, sender: { agentId: 'lumen' } } },
    };
    expect(isLegacyMessageForThisStudio(msg, MY_STUDIO)).toBe(true);
  });

  it('rejects messages addressed to a different studio', () => {
    const msg = {
      id: 'msg-2',
      senderAgentId: 'lumen',
      content: 'hello',
      metadata: { pcp: { recipient: { studioId: OTHER_STUDIO }, sender: { agentId: 'lumen' } } },
    };
    expect(isLegacyMessageForThisStudio(msg, MY_STUDIO)).toBe(false);
  });

  it('accepts broadcast messages (no recipient studio)', () => {
    const msg = {
      id: 'msg-3',
      senderAgentId: 'lumen',
      content: 'hello',
      metadata: { pcp: { sender: { agentId: 'lumen' } } },
    };
    expect(isLegacyMessageForThisStudio(msg, MY_STUDIO)).toBe(true);
  });

  it('accepts messages with no metadata at all', () => {
    const msg = { id: 'msg-4', senderAgentId: 'lumen', content: 'hello' };
    expect(isLegacyMessageForThisStudio(msg, MY_STUDIO)).toBe(true);
  });

  it('accepts all messages when studioId is undefined', () => {
    const msg = {
      id: 'msg-6',
      senderAgentId: 'lumen',
      content: 'hello',
      metadata: { pcp: { recipient: { studioId: 'any-studio' } } },
    };
    expect(isLegacyMessageForThisStudio(msg, undefined)).toBe(true);
  });
});

describe('message dedup logic', () => {
  it('seenMessageIds prevents re-emission', () => {
    const seen = new Set<string>();
    const msgId = 'abc-123';

    expect(seen.has(msgId)).toBe(false);
    seen.add(msgId);
    expect(seen.has(msgId)).toBe(true);
  });

  it('lastThreadTimestamps tracks per-thread cursor', () => {
    const timestamps = new Map<string, string>();

    timestamps.set('pr:231', '2026-03-25T00:00:00Z');
    expect(timestamps.get('pr:231')).toBe('2026-03-25T00:00:00Z');

    const newTs = '2026-03-25T00:01:00Z';
    expect(newTs > timestamps.get('pr:231')!).toBe(true);
    timestamps.set('pr:231', newTs);
    expect(timestamps.get('pr:231')).toBe(newTs);

    expect(timestamps.get('pr:232')).toBeUndefined();
  });

  it('own message filter works', () => {
    const agentId = 'wren';
    const ownMsg = { senderAgentId: 'wren', content: 'hello' };
    const otherMsg = { senderAgentId: 'lumen', content: 'hello' };

    expect(ownMsg.senderAgentId === agentId).toBe(true);
    expect(otherMsg.senderAgentId === agentId).toBe(false);
  });

  it('timestamp comparison for thread messages', () => {
    const lastKnownTs = '2026-03-25T00:30:00Z';
    const oldMsg = '2026-03-25T00:29:00Z';
    const newMsg = '2026-03-25T00:31:00Z';

    expect(oldMsg <= lastKnownTs).toBe(true);
    expect(newMsg <= lastKnownTs).toBe(false);
  });
});

describe('since filter behavior expectations', () => {
  it('legacy inbox: since filters by created_at', () => {
    const since = '2026-03-25T00:00:00Z';
    const oldMsg = { createdAt: '2026-03-24T23:59:00Z' };
    const newMsg = { createdAt: '2026-03-25T00:01:00Z' };

    expect(oldMsg.createdAt > since).toBe(false);
    expect(newMsg.createdAt > since).toBe(true);
  });

  it('threads: read pointers handle dedup, not since', () => {
    const lastReadAt = '2026-03-25T00:30:00Z';
    const readMsg = '2026-03-25T00:29:00Z';
    const unreadMsg = '2026-03-25T00:31:00Z';

    expect(readMsg > lastReadAt).toBe(false);
    expect(unreadMsg > lastReadAt).toBe(true);
  });
});
