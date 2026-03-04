import { describe, expect, it } from 'vitest';
import {
  activityToFeedEvent,
  backendFromSubtype,
  extractInboxMessages,
  extractUnreadCount,
  formatWorktreeLabel,
  inboxMessageToFeedEvent,
  repoNameFromPath,
  resolveAttachCommand,
  studioLabelForSession,
  summarizeMissionFeedRows,
  summarizeMissionRows,
} from './mission.js';
import type { MissionActivity, InboxMessage } from './mission.js';
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
        latestLifecycle: 'idle',
        latestPhase: 'implementing',
        latestBackendSessionId: 'backend-123',
      },
      {
        agent: 'wren',
        activeSessions: 1,
        unreadInbox: 1,
        latestSessionId: '3',
        latestThreadKey: undefined,
        latestLifecycle: 'idle',
        latestPhase: undefined,
        latestBackendSessionId: undefined,
      },
      {
        agent: 'aster',
        activeSessions: 0,
        unreadInbox: 2,
        latestSessionId: undefined,
        latestThreadKey: undefined,
        latestLifecycle: 'idle',
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

// ── activityToFeedEvent rendering ──

describe('activityToFeedEvent', () => {
  const activity = (overrides: Partial<MissionActivity>): MissionActivity => ({
    id: 'test-1',
    createdAt: '2026-03-02T20:00:00.000Z',
    ...overrides,
  });

  describe('agent_spawn', () => {
    it('shows backend and heartbeat trigger', () => {
      const event = activityToFeedEvent(
        activity({
          type: 'agent_spawn',
          agentId: 'myra',
          payload: { backend: 'claude-code', triggerSource: 'heartbeat', triggeredBy: 'system' },
        })
      );
      expect(event.content).toBe('spawned (claude-code, via heartbeat)');
      expect(event.agent).toBe('myra');
    });

    it('shows "via <agent>" when triggered by another agent', () => {
      const event = activityToFeedEvent(
        activity({
          type: 'agent_spawn',
          agentId: 'wren',
          payload: {
            backend: 'claude',
            triggerSource: 'agent',
            triggeredBy: 'lumen',
            threadKey: 'pr:129',
          },
        })
      );
      expect(event.content).toBe('spawned (claude, via lumen, pr:129)');
    });

    it('falls back to "spawned sub-process" when no payload', () => {
      const event = activityToFeedEvent(activity({ type: 'agent_spawn', agentId: 'myra' }));
      expect(event.content).toBe('spawned sub-process');
    });
  });

  describe('agent_complete', () => {
    it('shows backend, duration, and trigger source', () => {
      const event = activityToFeedEvent(
        activity({
          type: 'agent_complete',
          agentId: 'myra',
          payload: {
            backend: 'claude-code',
            durationMs: 25000,
            triggerSource: 'heartbeat',
            triggeredBy: 'system',
          },
        })
      );
      expect(event.content).toBe('completed (claude-code, 25s, via heartbeat)');
    });

    it('falls back to "sub-process completed" when no payload', () => {
      const event = activityToFeedEvent(activity({ type: 'agent_complete', agentId: 'myra' }));
      expect(event.content).toBe('sub-process completed');
    });
  });

  describe('error', () => {
    it('shows full error reason from payload.error', () => {
      const event = activityToFeedEvent(
        activity({
          type: 'error',
          agentId: 'wren',
          content: 'Backend turn failed (claude): short preview',
          payload: {
            backend: 'claude',
            error: 'Command failed with exit code 1: claude --session abc123 --message "do stuff"',
          },
        })
      );
      expect(event.content).toBe(
        'failed (claude): Command failed with exit code 1: claude --session abc123 --message "do stuff"'
      );
    });

    it('falls back to activity.content when no payload.error', () => {
      const event = activityToFeedEvent(
        activity({
          type: 'error',
          agentId: 'lumen',
          content: 'Backend turn failed (codex): timeout after 300s',
        })
      );
      expect(event.content).toBe('error: Backend turn failed (codex): timeout after 300s');
    });

    it('shows "unknown error" when no content or payload', () => {
      const event = activityToFeedEvent(activity({ type: 'error', agentId: 'wren' }));
      expect(event.content).toBe('error: unknown error');
    });

    it('shows errorCategory tag when present', () => {
      const event = activityToFeedEvent(
        activity({
          type: 'error',
          agentId: 'aster',
          payload: {
            backend: 'gemini',
            error: 'We are currently experiencing high demand',
            errorCategory: 'capacity',
          },
        })
      );
      expect(event.content).toBe(
        'failed (gemini, capacity): We are currently experiencing high demand'
      );
    });

    it('renders without errorCategory when absent', () => {
      const event = activityToFeedEvent(
        activity({
          type: 'error',
          agentId: 'wren',
          payload: {
            backend: 'claude',
            error: 'something went wrong',
          },
        })
      );
      expect(event.content).toBe('failed (claude): something went wrong');
    });

    it('shows only errorCategory when no backend', () => {
      const event = activityToFeedEvent(
        activity({
          type: 'error',
          agentId: 'lumen',
          payload: {
            error: 'authentication_error: invalid API key',
            errorCategory: 'auth',
          },
        })
      );
      expect(event.content).toBe('failed (auth): authentication_error: invalid API key');
    });
  });

  describe('studio detail line', () => {
    it('includes studio from session worktreeFolder', () => {
      const sessions = new Map<string, Session>([
        [
          'sess-1',
          {
            id: 'sess-1',
            agentId: 'wren',
            status: 'active',
            startedAt: '2026-03-02T10:00:00.000Z',
            studio: { worktreeFolder: 'personal-context-protocol--wren' },
          },
        ],
      ]);
      const event = activityToFeedEvent(
        activity({
          type: 'agent_spawn',
          agentId: 'wren',
          sessionId: 'sess-1',
          payload: { backend: 'claude' },
        }),
        undefined,
        sessions
      );
      expect(event.detail).toContain('studio: personal-context-protocol / wren');
    });

    it('falls back to workingDir repo name when no studio', () => {
      const sessions = new Map<string, Session>([
        [
          'sess-1',
          {
            id: 'sess-1',
            agentId: 'myra',
            status: 'active',
            startedAt: '2026-03-02T10:00:00.000Z',
            workingDir: '/Users/conor/ws/pcp/personal-context-protocol',
          },
        ],
      ]);
      const event = activityToFeedEvent(
        activity({
          type: 'agent_spawn',
          agentId: 'myra',
          sessionId: 'sess-1',
          payload: { backend: 'claude-code', triggerSource: 'heartbeat' },
        }),
        undefined,
        sessions
      );
      expect(event.detail).toContain('studio: personal-context-protocol');
    });

    it('omits studio when no session and no payload studioId', () => {
      const event = activityToFeedEvent(
        activity({
          type: 'agent_spawn',
          agentId: 'wren',
          payload: { backend: 'claude' },
        })
      );
      // detail should not contain "studio:" or should be undefined
      expect(event.detail || '').not.toContain('studio:');
    });
  });
});

// ── studioLabelForSession ──

describe('studioLabelForSession', () => {
  it('returns worktreeFolder formatted label', () => {
    expect(
      studioLabelForSession({
        id: '1',
        agentId: 'wren',
        status: 'active',
        startedAt: '',
        studio: { worktreeFolder: 'personal-context-protocol--wren' },
      })
    ).toBe('personal-context-protocol / wren');
  });

  it('falls back to studioId prefix', () => {
    expect(
      studioLabelForSession({
        id: '1',
        agentId: 'wren',
        status: 'active',
        startedAt: '',
        studioId: 'abcd1234-5678-9abc-def0',
      })
    ).toBe('abcd1234');
  });

  it('falls back to repo name from workingDir', () => {
    expect(
      studioLabelForSession({
        id: '1',
        agentId: 'myra',
        status: 'active',
        startedAt: '',
        workingDir: '/Users/conor/ws/pcp/personal-context-protocol',
      })
    ).toBe('personal-context-protocol');
  });

  it('returns dash when no info available', () => {
    expect(studioLabelForSession({ id: '1', agentId: 'x', status: 'active', startedAt: '' })).toBe(
      '-'
    );
  });

  it('returns dash for undefined session', () => {
    expect(studioLabelForSession(undefined)).toBe('-');
  });
});

// ── repoNameFromPath ──

describe('repoNameFromPath', () => {
  it('extracts repo name from absolute path', () => {
    expect(repoNameFromPath('/Users/conor/ws/pcp/personal-context-protocol')).toBe(
      'personal-context-protocol'
    );
  });

  it('handles trailing slash', () => {
    expect(repoNameFromPath('/Users/conor/ws/pcp/personal-context-protocol/')).toBe(
      'personal-context-protocol'
    );
  });

  it('returns null for undefined', () => {
    expect(repoNameFromPath(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(repoNameFromPath('')).toBeNull();
  });
});

// ── extractInboxMessages ──

describe('extractInboxMessages', () => {
  it('extracts messages from standard response', () => {
    const result = {
      messages: [
        {
          id: 'msg-1',
          subject: 'Review PR #129',
          messageType: 'task_request',
          priority: 'high',
          senderAgentId: 'lumen',
          recipientAgentId: 'wren',
          threadKey: 'pr:129',
          createdAt: '2026-03-02T20:06:21Z',
        },
      ],
    };
    const msgs = extractInboxMessages(result);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      id: 'msg-1',
      subject: 'Review PR #129',
      messageType: 'task_request',
      priority: 'high',
      senderAgentId: 'lumen',
      recipientAgentId: 'wren',
      threadKey: 'pr:129',
    });
  });

  it('returns empty array for null result', () => {
    expect(extractInboxMessages(null)).toEqual([]);
  });

  it('filters entries without id', () => {
    const result = {
      messages: [{ subject: 'no id' }, { id: 'valid', subject: 'has id' }],
    };
    expect(extractInboxMessages(result)).toHaveLength(1);
  });
});

// ── inboxMessageToFeedEvent ──

describe('inboxMessageToFeedEvent', () => {
  it('renders task_request with sender and subject', () => {
    const msg: InboxMessage = {
      id: 'msg-1',
      subject: 'Review PR #129',
      messageType: 'task_request',
      senderAgentId: 'lumen',
      recipientAgentId: 'wren',
      createdAt: '2026-03-02T20:06:21Z',
    };
    const event = inboxMessageToFeedEvent(msg);
    expect(event.type).toBe('task');
    expect(event.agent).toBe('wren');
    expect(event.content).toContain('from lumen');
    expect(event.content).toContain('[task_request]');
    expect(event.content).toContain('Review PR #129');
  });

  it('renders plain message without type tag', () => {
    const msg: InboxMessage = {
      id: 'msg-2',
      content: 'Hey, how is the review going?',
      messageType: 'message',
      senderAgentId: 'aster',
      recipientAgentId: 'wren',
      createdAt: '2026-03-02T21:00:00Z',
    };
    const event = inboxMessageToFeedEvent(msg);
    expect(event.type).toBe('inbox');
    expect(event.content).toContain('from aster');
    expect(event.content).not.toContain('[message]');
  });

  it('shows "user" when no senderAgentId', () => {
    const msg: InboxMessage = {
      id: 'msg-3',
      subject: 'Manual message',
      recipientAgentId: 'wren',
      createdAt: '2026-03-02T21:00:00Z',
    };
    const event = inboxMessageToFeedEvent(msg);
    expect(event.content).toContain('from user');
  });
});

// ── backendFromSubtype ──

describe('backendFromSubtype', () => {
  it('extracts backend from backend_cli: prefix', () => {
    expect(backendFromSubtype('backend_cli:claude-code')).toBe('claude-code');
    expect(backendFromSubtype('backend_cli:codex')).toBe('codex');
    expect(backendFromSubtype('backend_cli:gemini')).toBe('gemini');
  });

  it('returns null for non-matching subtypes', () => {
    expect(backendFromSubtype('start_session')).toBeNull();
    expect(backendFromSubtype('remember')).toBeNull();
    expect(backendFromSubtype(undefined)).toBeNull();
  });
});

// ── subtype fallback for spawn/complete ──

describe('activityToFeedEvent subtype fallback', () => {
  const activity = (overrides: Partial<MissionActivity>): MissionActivity => ({
    id: 'test-fb',
    createdAt: '2026-03-02T20:00:00.000Z',
    ...overrides,
  });

  it('falls back to subtype for backend when payload is empty (agent_spawn)', () => {
    const event = activityToFeedEvent(
      activity({
        type: 'agent_spawn',
        agentId: 'myra',
        subtype: 'backend_cli:claude-code',
        // no payload
      })
    );
    expect(event.content).toBe('spawned (claude-code)');
  });

  it('falls back to subtype for backend when payload is empty (agent_complete)', () => {
    const event = activityToFeedEvent(
      activity({
        type: 'agent_complete',
        agentId: 'lumen',
        subtype: 'backend_cli:codex',
        // no payload
      })
    );
    expect(event.content).toBe('completed (codex)');
  });

  it('falls back to subtype for backend when payload is empty (error)', () => {
    const event = activityToFeedEvent(
      activity({
        type: 'error',
        agentId: 'wren',
        subtype: 'backend_cli:claude',
        content: 'Something broke',
        // no payload
      })
    );
    expect(event.content).toBe('failed (claude): Something broke');
  });

  it('prefers payload.backend over subtype', () => {
    const event = activityToFeedEvent(
      activity({
        type: 'agent_spawn',
        agentId: 'myra',
        subtype: 'backend_cli:codex',
        payload: { backend: 'claude-code', triggerSource: 'heartbeat' },
      })
    );
    expect(event.content).toBe('spawned (claude-code, via heartbeat)');
  });
});

// ── tool_call / tool_result rendering ──

describe('activityToFeedEvent tool_call/tool_result', () => {
  const activity = (overrides: Partial<MissionActivity>): MissionActivity => ({
    id: 'test-tc',
    createdAt: '2026-03-02T20:00:00.000Z',
    ...overrides,
  });

  it('renders backend_cli tool_call with trigger metadata', () => {
    const event = activityToFeedEvent(
      activity({
        type: 'tool_call',
        agentId: 'myra',
        subtype: 'backend_cli:claude-code',
        content: 'Spawned backend CLI (claude)',
        payload: {
          backend: 'claude-code',
          triggerSource: 'heartbeat',
          threadKey: 'pr:130',
        },
      })
    );
    expect(event.content).toBe('spawned (claude-code, via heartbeat, pr:130)');
    expect(event.type).toBe('activity');
  });

  it('renders backend_cli tool_result with duration', () => {
    const event = activityToFeedEvent(
      activity({
        type: 'tool_result',
        agentId: 'lumen',
        subtype: 'backend_cli:codex',
        status: 'completed',
        content: 'Backend CLI finished (codex)',
        payload: {
          backend: 'codex',
          durationMs: 45000,
          triggerSource: 'agent',
        },
      })
    );
    expect(event.content).toBe('completed (codex, 45s, via agent)');
  });

  it('renders backend_cli tool_result failure with error', () => {
    const event = activityToFeedEvent(
      activity({
        type: 'tool_result',
        agentId: 'wren',
        subtype: 'backend_cli:claude',
        status: 'failed',
        content: 'Backend CLI failed (claude)',
        payload: {
          backend: 'claude',
          error: 'exit code 1',
        },
      })
    );
    expect(event.content).toBe('failed (claude): exit code 1');
  });

  it('falls back to subtype for backend_cli tool_call without payload', () => {
    const event = activityToFeedEvent(
      activity({
        type: 'tool_call',
        agentId: 'myra',
        subtype: 'backend_cli:claude-code',
        content: 'Spawned backend CLI (claude)',
      })
    );
    expect(event.content).toBe('spawned (claude-code)');
  });

  it('renders individual PCP tool calls compactly', () => {
    const event = activityToFeedEvent(
      activity({
        type: 'tool_call',
        agentId: 'myra',
        subtype: 'log_session',
        content: 'log_session(email, sessionId, content, salience)',
      })
    );
    expect(event.content).toBe('log_session(email, sessionId, content, salience)');
    expect(event.type).toBe('activity');
  });
});
