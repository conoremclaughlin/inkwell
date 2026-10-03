import { describe, expect, it } from 'vitest';
import type { SpineSession, ThreadSpine } from '../threads-api/index.js';
import {
  byLatestMessage,
  isConversation,
  isSessionLive,
  lastSpokeAt,
  liveAgentsOf,
  matchesThreadSearch,
  spineStatus,
} from './spines.js';

const session = (over: Partial<SpineSession> = {}): SpineSession => ({
  id: 's1',
  sbSlug: 'wren',
  lifecycle: 'idle',
  status: 'active',
  phase: null,
  relation: 'anchor',
  updatedAt: '2026-09-25T00:00:00.000Z',
  studioId: null,
  ...over,
});

const spine = (over: Partial<ThreadSpine> = {}): ThreadSpine => ({
  key: 'pr:670',
  identity: null,
  thread: {
    title: 'The threads page is a chat',
    summary: 'Three columns, markdown, read cursors',
    status: 'open',
    createdBySlug: 'wren',
    participants: ['wren', 'lumen'],
    closedAt: null,
    lastMessage: {
      id: 'm1',
      senderKind: 'sb',
      senderSlug: 'lumen',
      senderName: 'lumen',
      isOwn: false,
      messageType: 'message',
      preview: 'Round 4: exact-head LGTM',
      createdAt: '2026-09-25T00:00:00.000Z',
    },
  },
  sessions: [],
  studios: [],
  taskGroups: [],
  participants: ['wren', 'lumen'],
  sources: ['thread'],
  lastActivityAt: '2026-09-25T00:00:00.000Z',
  ...over,
});

const names = (slug: string) => ({ wren: 'Wren', lumen: 'Lumen' })[slug] ?? slug;

describe('isConversation', () => {
  it('lists a key with a thread, and not one only a session references', () => {
    expect(isConversation(spine())).toBe(true);
    expect(isConversation(spine({ thread: null, sources: ['session'] }))).toBe(false);
  });
});

/** A spine whose newest message and last activity are set independently. */
const spoke = (key: string, messageAt: string | null, activityAt: string): ThreadSpine => {
  const base = spine({ key, lastActivityAt: activityAt });
  base.thread = {
    ...base.thread!,
    lastMessage: messageAt ? { ...base.thread!.lastMessage!, createdAt: messageAt } : null,
  };
  return base;
};

describe('lastSpokeAt', () => {
  it("is the newest message's time, whatever else touched the key since", () => {
    expect(lastSpokeAt(spoke('a', '2026-10-02T18:00:00Z', '2026-10-03T07:00:00Z'))).toBe(
      '2026-10-02T18:00:00Z'
    );
  });

  it('falls back to the last activity for a thread with no message, or an older server', () => {
    expect(lastSpokeAt(spoke('a', null, '2026-10-03T07:00:00Z'))).toBe('2026-10-03T07:00:00Z');
    const older = spine({ lastActivityAt: '2026-10-03T07:00:00Z' });
    older.thread = { ...older.thread!, lastMessage: undefined };
    expect(lastSpokeAt(older)).toBe('2026-10-03T07:00:00Z');
  });
});

describe('byLatestMessage', () => {
  it('puts the newest message first, not the newest session activity', () => {
    // Conor's list, 2026-10-03: a thread whose session was busy six hours
    // after its last message sat above one answered ten minutes ago.
    const busySession = spoke('busy', '2026-10-03T01:00:00Z', '2026-10-03T07:05:00Z');
    const justAnswered = spoke('answered', '2026-10-03T07:00:00Z', '2026-10-03T07:00:00Z');
    const yesterday = spoke('yesterday', '2026-10-02T09:00:00Z', '2026-10-03T07:06:00Z');
    expect([yesterday, busySession, justAnswered].sort(byLatestMessage).map((s) => s.key)).toEqual([
      'answered',
      'busy',
      'yesterday',
    ]);
  });

  it('compares instants at full precision and breaks ties by key', () => {
    const later = spoke('z', '2026-10-03T07:00:00.000002Z', '2026-10-03T07:00:00Z');
    const earlier = spoke('y', '2026-10-03T07:00:00.000001Z', '2026-10-03T07:00:00Z');
    const tieB = spoke('b', '2026-10-03T06:00:00Z', '2026-10-03T06:00:00Z');
    const tieA = spoke('a', '2026-10-03T06:00:00Z', '2026-10-03T06:00:00Z');
    expect([tieB, earlier, tieA, later].sort(byLatestMessage).map((s) => s.key)).toEqual([
      'z',
      'y',
      'a',
      'b',
    ]);
  });
});

describe('isSessionLive', () => {
  it("takes the server's verdict over the lifecycle", () => {
    expect(isSessionLive(session({ live: false, lifecycle: 'running' }))).toBe(false);
    expect(isSessionLive(session({ live: true, lifecycle: 'idle' }))).toBe(true);
  });

  it('falls back to the lifecycle when an older server sends no verdict', () => {
    expect(isSessionLive(session({ lifecycle: 'running' }))).toBe(true);
    expect(isSessionLive(session({ lifecycle: 'idle' }))).toBe(false);
  });
});

describe('liveAgentsOf', () => {
  it('names each working SB once', () => {
    const sessions = [
      session({ id: 'a', sbSlug: 'wren', live: true }),
      session({ id: 'b', sbSlug: 'wren', live: true }),
      session({ id: 'c', sbSlug: 'lumen', live: false }),
      session({ id: 'd', sbSlug: null, live: true }),
    ];
    expect(liveAgentsOf(spine({ sessions }))).toEqual(['wren']);
  });
});

describe('spineStatus', () => {
  it('keeps a closed thread active while someone is still working on it', () => {
    const closed = spine();
    closed.thread = { ...closed.thread!, status: 'closed' };
    expect(spineStatus(closed)).toBe('closed');
    expect(spineStatus({ ...closed, sessions: [session({ live: true })] })).toBe('active');
  });
});

describe('matchesThreadSearch', () => {
  it('matches the key, title, summary, preview and participant names', () => {
    for (const needle of ['pr:670', 'is a chat', 'markdown', 'exact-head', 'lumen']) {
      expect(matchesThreadSearch(spine(), needle, names)).toBe(true);
    }
    expect(matchesThreadSearch(spine({ participants: ['wren'] }), 'wren', () => 'Robin')).toBe(
      true
    );
    expect(matchesThreadSearch(spine({ participants: ['x'] }), 'robin', () => 'Robin')).toBe(true);
  });

  it('matches everything with an empty needle, and nothing unrelated', () => {
    expect(matchesThreadSearch(spine(), '', names)).toBe(true);
    expect(matchesThreadSearch(spine(), 'inktrade', names)).toBe(false);
  });
});
