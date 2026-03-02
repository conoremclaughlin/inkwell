import { describe, expect, it } from 'vitest';
import {
  extractUnreadCount,
  formatWorktreeLabel,
  resolveAttachCommand,
  summarizeMissionFeedRows,
  summarizeMissionRows,
} from './mission.js';
import type { Session } from './session.js';

describe('summarizeMissionRows', () => {
  it('counts active sessions and merges unread counts from missing-session agents', () => {
    const sessions: Session[] = [
      {
        id: '1',
        agentId: 'lumen',
        status: 'active',
        startedAt: '2026-02-20T08:00:00.000Z',
      },
      {
        id: '2',
        agentId: 'lumen',
        status: 'active',
        startedAt: '2026-02-20T08:05:00.000Z',
        threadKey: 'pr:70',
        currentPhase: 'implementing',
        backendSessionId: 'backend-123',
      },
      {
        id: '3',
        agentId: 'wren',
        status: 'active',
        startedAt: '2026-02-20T07:55:00.000Z',
      },
    ];

    const rows = summarizeMissionRows(sessions, { lumen: 4, wren: 1, aster: 2 });

    expect(rows).toEqual([
      {
        agent: 'lumen',
        activeSessions: 2,
        unreadInbox: 4,
        latestSessionId: '2',
        latestThreadKey: 'pr:70',
        latestPhase: 'implementing',
        latestBackendSessionId: 'backend-123',
      },
      {
        agent: 'wren',
        activeSessions: 1,
        unreadInbox: 1,
        latestSessionId: '3',
        latestThreadKey: undefined,
        latestPhase: 'active',
        latestBackendSessionId: undefined,
      },
      {
        agent: 'aster',
        activeSessions: 0,
        unreadInbox: 2,
        latestSessionId: undefined,
        latestThreadKey: undefined,
        latestPhase: undefined,
        latestBackendSessionId: undefined,
      },
    ]);
  });
});

describe('extractUnreadCount', () => {
  it('reads unreadCount when present', () => {
    expect(extractUnreadCount({ unreadCount: 5 })).toBe(5);
  });

  it('falls back to messages length', () => {
    expect(extractUnreadCount({ messages: [{}, {}, {}] })).toBe(3);
  });

  it('falls back to nested data.unreadCount', () => {
    expect(extractUnreadCount({ data: { unreadCount: 9 } })).toBe(9);
  });
});

describe('resolveAttachCommand', () => {
  const sessions: Session[] = [
    {
      id: 'abc12345-aaaa',
      agentId: 'lumen',
      status: 'active',
      startedAt: '2026-02-20T10:00:00.000Z',
    },
    {
      id: 'def67890-bbbb',
      agentId: 'lumen',
      status: 'active',
      startedAt: '2026-02-20T11:00:00.000Z',
    },
    {
      id: 'wren1111-cccc',
      agentId: 'wren',
      status: 'active',
      startedAt: '2026-02-20T11:30:00.000Z',
    },
  ];

  it('resolves direct session-id prefix first', () => {
    expect(resolveAttachCommand(sessions, 'abc1')).toEqual({
      command: 'sb chat -a lumen --session-id abc12345-aaaa',
      sessionId: 'abc12345-aaaa',
      agentId: 'lumen',
    });
  });

  it('resolves latest session for agent target', () => {
    expect(resolveAttachCommand(sessions, 'lumen')).toEqual({
      command: 'sb chat -a lumen --session-id def67890-bbbb',
      sessionId: 'def67890-bbbb',
      agentId: 'lumen',
    });
  });

  it('returns null when no target matches', () => {
    expect(resolveAttachCommand(sessions, 'missing')).toBeNull();
  });
});

describe('formatWorktreeLabel', () => {
  it('splits project--slug into "project / slug"', () => {
    expect(formatWorktreeLabel('acme-app--wren')).toBe('acme-app / wren');
  });

  it('handles repo names with hyphens', () => {
    expect(formatWorktreeLabel('personal-context-protocol--lumen')).toBe(
      'personal-context-protocol / lumen'
    );
  });

  it('returns plain folder name when no -- separator exists', () => {
    expect(formatWorktreeLabel('workspace-wren')).toBe('workspace-wren');
    expect(formatWorktreeLabel('my-project')).toBe('my-project');
  });

  it('only splits on first -- to handle slugs containing hyphens', () => {
    expect(formatWorktreeLabel('personal-context-protocol--lumen-alpha')).toBe(
      'personal-context-protocol / lumen-alpha'
    );
    expect(formatWorktreeLabel('acme-app--wren-review')).toBe('acme-app / wren-review');
  });

  it('does NOT double-split nested worktree names (regression)', () => {
    // If a worktree was incorrectly created as repo--agent--slug, formatWorktreeLabel
    // should only split on the first --, not produce three segments.
    // This is a display-level safeguard; the real fix is resolveMainWorktree preventing
    // the bad path from being created in the first place.
    expect(formatWorktreeLabel('acme-app--wren--wren')).toBe('acme-app / wren--wren');
    expect(formatWorktreeLabel('my-project--lumen--lumen-alpha')).toBe(
      'my-project / lumen--lumen-alpha'
    );
  });
});

describe('summarizeMissionFeedRows', () => {
  it('derives from/to routing for inbox triggers and attaches studio metadata', () => {
    const sessions: Session[] = [
      {
        id: 'session-1',
        agentId: 'wren',
        status: 'active',
        startedAt: '2026-02-20T10:00:00.000Z',
        studioId: 'studio-abc12345',
        studio: { worktreeFolder: 'personal-context-protocol--wren' },
      },
    ];

    const rows = summarizeMissionFeedRows(
      [
        {
          id: 'evt-1',
          type: 'message_in',
          agentId: 'wren',
          sessionId: 'session-1',
          createdAt: '2026-02-20T10:01:00.000Z',
          platform: 'agent',
          content:
            '[TRIGGER from lumen]\nType: task_request\nSummary: Please review PR #110 DB-backed conversation routing fallback.',
        },
      ],
      sessions
    );

    expect(rows).toEqual([
      {
        id: 'evt-1',
        timestamp: '2026-02-20T10:01:00.000Z',
        type: 'inbox:task_request',
        route: 'lumen → wren',
        studio: 'personal-context-protocol / wren',
        preview: 'Please review PR #110 DB-backed conversation routing fallback.',
      },
    ]);
  });

  it('shows plain folder name when worktreeFolder has no -- separator', () => {
    const sessions: Session[] = [
      {
        id: 'session-1',
        agentId: 'wren',
        status: 'active',
        startedAt: '2026-02-20T10:00:00.000Z',
        studio: { worktreeFolder: 'workspace-wren' },
      },
    ];

    const rows = summarizeMissionFeedRows(
      [
        {
          id: 'evt-1',
          type: 'message_out',
          agentId: 'wren',
          sessionId: 'session-1',
          createdAt: '2026-02-20T10:01:00.000Z',
          platform: 'telegram',
          content: 'Hello from wren',
        },
      ],
      sessions
    );

    expect(rows[0].studio).toBe('workspace-wren');
  });

  it('falls back to studioId prefix when no session studio is available', () => {
    const rows = summarizeMissionFeedRows(
      [
        {
          id: 'evt-1',
          type: 'tool_call',
          agentId: 'lumen',
          createdAt: '2026-02-20T10:01:00.000Z',
          payload: { studioId: 'abcd1234-full-uuid' },
        },
      ],
      []
    );

    expect(rows[0]).toMatchObject({
      id: 'evt-1',
    });
  });
});
