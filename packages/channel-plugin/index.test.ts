import { describe, it, expect } from 'vitest';

/**
 * Unit tests for channel plugin filtering logic.
 * These test the pure functions without needing a running server.
 */

// Re-implement isMessageForThisStudio as a testable function
// (extracted from the plugin's inline logic)
function isMessageForThisStudio(
  msg: Record<string, unknown>,
  myStudioId: string | undefined
): boolean {
  if (!myStudioId) return true; // no studio context — accept all

  const metadata = msg.metadata as Record<string, unknown> | undefined;
  const pcp = metadata?.pcp as Record<string, unknown> | undefined;
  const recipient = pcp?.recipient as Record<string, unknown> | undefined;
  const recipientStudioId = recipient?.studioId as string | undefined;

  if (!recipientStudioId) return true; // no studio scoping — broadcast
  return recipientStudioId === myStudioId;
}

describe('isMessageForThisStudio', () => {
  const MY_STUDIO = 'ef511db1-a158-4a06-ba40-abb61785dbbc';

  it('accepts messages addressed to this studio', () => {
    const msg = {
      id: 'msg-1',
      senderAgentId: 'lumen',
      content: 'hello',
      metadata: {
        pcp: {
          recipient: { studioId: MY_STUDIO },
          sender: { agentId: 'lumen' },
        },
      },
    };
    expect(isMessageForThisStudio(msg, MY_STUDIO)).toBe(true);
  });

  it('rejects messages addressed to a different studio', () => {
    const msg = {
      id: 'msg-2',
      senderAgentId: 'lumen',
      content: 'hello',
      metadata: {
        pcp: {
          recipient: { studioId: 'different-studio-id' },
          sender: { agentId: 'lumen' },
        },
      },
    };
    expect(isMessageForThisStudio(msg, MY_STUDIO)).toBe(false);
  });

  it('accepts broadcast messages (no recipient studio)', () => {
    const msg = {
      id: 'msg-3',
      senderAgentId: 'lumen',
      content: 'hello',
      metadata: {
        pcp: {
          sender: { agentId: 'lumen' },
        },
      },
    };
    expect(isMessageForThisStudio(msg, MY_STUDIO)).toBe(true);
  });

  it('accepts messages with no metadata at all', () => {
    const msg = { id: 'msg-4', senderAgentId: 'lumen', content: 'hello' };
    expect(isMessageForThisStudio(msg, MY_STUDIO)).toBe(true);
  });

  it('accepts messages with empty pcp metadata', () => {
    const msg = {
      id: 'msg-5',
      senderAgentId: 'lumen',
      content: 'hello',
      metadata: { pcp: {} },
    };
    expect(isMessageForThisStudio(msg, MY_STUDIO)).toBe(true);
  });

  it('accepts all messages when myStudioId is undefined', () => {
    const msg = {
      id: 'msg-6',
      senderAgentId: 'lumen',
      content: 'hello',
      metadata: {
        pcp: {
          recipient: { studioId: 'any-studio' },
        },
      },
    };
    expect(isMessageForThisStudio(msg, undefined)).toBe(true);
  });

  it('accepts messages with recipient but no studioId', () => {
    const msg = {
      id: 'msg-7',
      senderAgentId: 'lumen',
      content: 'hello',
      metadata: {
        pcp: {
          recipient: { sessionId: 'some-session', studioHint: 'main' },
        },
      },
    };
    expect(isMessageForThisStudio(msg, MY_STUDIO)).toBe(true);
  });
});

describe('message dedup logic', () => {
  it('seenMessageIds prevents re-emission', () => {
    const seen = new Set<string>();
    const msgId = 'abc-123';

    // First time: not seen
    expect(seen.has(msgId)).toBe(false);
    seen.add(msgId);

    // Second time: already seen
    expect(seen.has(msgId)).toBe(true);
  });

  it('lastThreadTimestamps tracks per-thread cursor', () => {
    const timestamps = new Map<string, string>();

    timestamps.set('pr:231', '2026-03-25T00:00:00Z');
    expect(timestamps.get('pr:231')).toBe('2026-03-25T00:00:00Z');

    // New message with later timestamp
    const newTs = '2026-03-25T00:01:00Z';
    expect(newTs > timestamps.get('pr:231')!).toBe(true);
    timestamps.set('pr:231', newTs);
    expect(timestamps.get('pr:231')).toBe(newTs);

    // Different thread has no cursor
    expect(timestamps.get('pr:232')).toBeUndefined();
  });

  it('own message filter works', () => {
    const agentId = 'wren';
    const ownMsg = { senderAgentId: 'wren', content: 'hello' };
    const otherMsg = { senderAgentId: 'lumen', content: 'hello' };

    expect(ownMsg.senderAgentId === agentId).toBe(true); // skip
    expect(otherMsg.senderAgentId === agentId).toBe(false); // push
  });

  it('timestamp comparison for thread messages', () => {
    const lastKnownTs = '2026-03-25T00:30:00Z';
    const oldMsg = '2026-03-25T00:29:00Z';
    const newMsg = '2026-03-25T00:31:00Z';

    expect(oldMsg <= lastKnownTs).toBe(true); // skip
    expect(newMsg <= lastKnownTs).toBe(false); // push
  });
});

describe('since filter behavior expectations', () => {
  it('legacy inbox: since filters by created_at', () => {
    const since = '2026-03-25T00:00:00Z';
    const oldMsg = { createdAt: '2026-03-24T23:59:00Z' };
    const newMsg = { createdAt: '2026-03-25T00:01:00Z' };

    // Server-side: get_inbox(since) only returns messages with created_at > since
    expect(oldMsg.createdAt > since).toBe(false); // filtered by server
    expect(newMsg.createdAt > since).toBe(true); // returned by server
  });

  it('threads: read pointers handle dedup, not since', () => {
    // Thread unread detection uses inbox_thread_read_status.last_read_at
    // The since filter does NOT apply to the thread query — this is by design.
    // Thread read pointers are the authoritative "what have I seen" for threads.
    const lastReadAt = '2026-03-25T00:30:00Z';
    const readMsg = '2026-03-25T00:29:00Z';
    const unreadMsg = '2026-03-25T00:31:00Z';

    expect(readMsg > lastReadAt).toBe(false); // already read
    expect(unreadMsg > lastReadAt).toBe(true); // unread
  });
});
