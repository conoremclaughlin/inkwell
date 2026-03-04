import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  extractClaudeHistorySessionsForProject,
  extractSessionFromStartSessionResponse,
  filterUntrackedLocalBackendSessions,
  filterPcpSessionsForContext,
  filterUntrackedLocalClaudeSessions,
  getClaudeLocalSessionsForProject,
  getKnownClaudeSessionIds,
  getCodexLocalSessionsForProject,
  hasBackendSessionOverride,
  resolveCapturedBackendSessionIdFromRuntime,
  resolveAdoptableLocalBackendSessionId,
  resolveBackendSessionIdForResume,
  resolveBackendSessionSeedId,
  resolveStartedSessionFromList,
  sanitizeBackendExecutionArgs,
  shouldRetryWithFreshBackendSession,
  shouldAutoResumeRuntimeSession,
} from './claude.js';

describe('hasBackendSessionOverride', () => {
  it('detects explicit Codex resume subcommand in positional prompt parts', () => {
    expect(
      hasBackendSessionOverride('codex', [], ['resume', '019c44fd-68f6-7332-9eda-2dc7c8afcedf'])
    ).toBe(true);
  });

  it('detects explicit Codex resume subcommand in passthrough args', () => {
    expect(
      hasBackendSessionOverride('codex', ['resume', '019c44fd-68f6-7332-9eda-2dc7c8afcedf'])
    ).toBe(true);
  });

  it('does not treat plain prompt text as resume override', () => {
    expect(hasBackendSessionOverride('codex', [], ['resume this bug'])).toBe(false);
    expect(hasBackendSessionOverride('codex', [], ['resume'])).toBe(false);
  });

  it('treats codex resume passthrough args as override', () => {
    expect(hasBackendSessionOverride('codex', ['resume'])).toBe(true);
    expect(hasBackendSessionOverride('codex', ['resume', '--latest'])).toBe(true);
  });

  it('still respects flag-based resume overrides', () => {
    expect(hasBackendSessionOverride('codex', ['--resume', 'abc123'])).toBe(true);
    expect(hasBackendSessionOverride('claude', ['--resume', 'abc123'])).toBe(true);
    expect(hasBackendSessionOverride('gemini', ['--session-id', 'abc123'])).toBe(true);
  });
});

describe('filterPcpSessionsForContext', () => {
  it('filters claude sessions by workingDir when present', () => {
    const filtered = filterPcpSessionsForContext(
      [
        {
          id: 'a',
          startedAt: '2026-02-28T00:00:00.000Z',
          backend: 'claude',
          workingDir: '/tmp/project-a',
        },
        {
          id: 'b',
          startedAt: '2026-02-28T00:00:00.000Z',
          backend: 'claude',
          workingDir: '/tmp/project-b',
        },
      ],
      'claude',
      '/tmp/project-a'
    );

    expect(filtered.map((session) => session.id)).toEqual(['a']);
  });

  it('retains claude sessions without workingDir when local claude session id matches', () => {
    const filtered = filterPcpSessionsForContext(
      [
        {
          id: 'pcp-1',
          startedAt: '2026-02-28T00:00:00.000Z',
          backend: 'claude',
          backendSessionId: 'claude-local-123',
        },
      ],
      'claude',
      '/tmp/project-a',
      new Set(['claude-local-123'])
    );

    expect(filtered.map((session) => session.id)).toEqual(['pcp-1']);
  });

  it('strictly excludes claude sessions outside current project when no local match exists', () => {
    const filtered = filterPcpSessionsForContext(
      [
        {
          id: 'pcp-1',
          startedAt: '2026-02-28T00:00:00.000Z',
          backend: 'claude',
          backendSessionId: 'remote-session-id',
          workingDir: '/tmp/another-project',
        },
      ],
      'claude',
      '/tmp/current-project',
      new Set()
    );

    expect(filtered).toEqual([]);
  });

  it('path-scopes non-claude sessions and excludes other repos', () => {
    const filtered = filterPcpSessionsForContext(
      [
        {
          id: 'codex-1',
          startedAt: '2026-02-28T00:00:00.000Z',
          backend: 'codex',
          workingDir: '/tmp/other',
        },
        {
          id: 'gemini-1',
          startedAt: '2026-02-28T00:00:00.000Z',
          backend: 'gemini',
          workingDir: '/tmp/project',
        },
      ],
      'codex',
      '/tmp/project'
    );

    expect(filtered.map((session) => session.id)).toEqual([]);
  });

  it('treats codex backend aliases as equivalent during filtering', () => {
    const filtered = filterPcpSessionsForContext(
      [
        {
          id: 'codex-legacy-label',
          startedAt: '2026-02-28T00:00:00.000Z',
          backend: 'codex-cli',
          workingDir: '/tmp/project-a',
        },
      ],
      'codex',
      '/tmp/project-a'
    );

    expect(filtered.map((session) => session.id)).toEqual(['codex-legacy-label']);
  });

  it('path-scopes codex sessions when workingDir data is available', () => {
    const filtered = filterPcpSessionsForContext(
      [
        {
          id: 'codex-a',
          startedAt: '2026-02-28T00:00:00.000Z',
          backend: 'codex',
          workingDir: '/tmp/project-a',
        },
        {
          id: 'codex-b',
          startedAt: '2026-02-28T00:00:00.000Z',
          backend: 'codex',
          workingDir: '/tmp/project-b',
        },
      ],
      'codex',
      '/tmp/project-a'
    );

    expect(filtered.map((session) => session.id)).toEqual(['codex-a']);
  });

  it('keeps path-ambiguous codex sessions visible alongside path-scoped matches', () => {
    const nowIso = new Date().toISOString();
    const filtered = filterPcpSessionsForContext(
      [
        {
          id: 'codex-a',
          startedAt: nowIso,
          backend: 'codex',
          workingDir: '/tmp/project-a',
        },
        {
          id: 'codex-unknown',
          startedAt: nowIso,
          backend: 'codex',
        },
      ],
      'codex',
      '/tmp/project-a'
    );

    expect(filtered.map((session) => session.id)).toEqual(['codex-a', 'codex-unknown']);
  });
});

describe('filterUntrackedLocalClaudeSessions', () => {
  it('excludes local claude sessions already represented by PCP sessions', () => {
    const local = [
      {
        sessionId: 'claude-1',
        projectPath: '/tmp/project',
        modified: '2026-02-28T00:00:00.000Z',
      },
      {
        sessionId: 'claude-2',
        projectPath: '/tmp/project',
        modified: '2026-02-28T00:00:00.000Z',
      },
    ];

    const filtered = filterUntrackedLocalClaudeSessions(local, [
      {
        id: 'pcp-1',
        startedAt: '2026-02-28T00:00:00.000Z',
        backend: 'claude',
        backendSessionId: 'claude-1',
      },
    ]);

    expect(filtered.map((session) => session.sessionId)).toEqual(['claude-2']);
  });
});

describe('getClaudeLocalSessionsForProject', () => {
  it('excludes non-resumable snapshot-only jsonl files', () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-claude-local-'));
    const homeDir = join(root, 'home');
    const projectDir = join(root, 'project');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    const projectKey = projectDir.replace(/[\\/]/g, '-');
    const claudeProjectDir = join(homeDir, '.claude', 'projects', projectKey);
    mkdirSync(claudeProjectDir, { recursive: true });

    const validSessionId = '11111111-1111-4111-8111-111111111111';
    const poisonSessionId = '22222222-2222-4222-8222-222222222222';

    writeFileSync(
      join(claudeProjectDir, `${validSessionId}.jsonl`),
      JSON.stringify({
        type: 'progress',
        sessionId: validSessionId,
        timestamp: '2026-03-04T00:00:00.000Z',
      }) + '\n'
    );

    writeFileSync(
      join(claudeProjectDir, `${poisonSessionId}.jsonl`),
      JSON.stringify({
        type: 'file-history-snapshot',
        messageId: 'abc',
        snapshot: {
          messageId: 'abc',
          trackedFileBackups: {},
          timestamp: '2026-03-04T00:00:00.000Z',
        },
      }) + '\n'
    );

    const previousHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      const sessions = getClaudeLocalSessionsForProject(projectDir, 20);
      expect(sessions.map((session) => session.sessionId)).toContain(validSessionId);
      expect(sessions.map((session) => session.sessionId)).not.toContain(poisonSessionId);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('getKnownClaudeSessionIds', () => {
  it('excludes snapshot-only session files from known resumable ids', () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-claude-known-'));
    const homeDir = join(root, 'home');
    mkdirSync(homeDir, { recursive: true });

    const projectDir = join(homeDir, '.claude', 'projects', '-tmp-project');
    mkdirSync(projectDir, { recursive: true });

    const validSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const snapshotOnlySessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    writeFileSync(
      join(projectDir, `${validSessionId}.jsonl`),
      JSON.stringify({
        type: 'progress',
        sessionId: validSessionId,
        timestamp: '2026-03-04T00:00:00.000Z',
      }) + '\n'
    );
    writeFileSync(
      join(projectDir, `${snapshotOnlySessionId}.jsonl`),
      JSON.stringify({
        type: 'file-history-snapshot',
        messageId: 'abc',
      }) + '\n'
    );

    const previousHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      const known = getKnownClaudeSessionIds();
      expect(known.has(validSessionId)).toBe(true);
      expect(known.has(snapshotOnlySessionId)).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('filterUntrackedLocalBackendSessions', () => {
  it('excludes local codex sessions already represented by PCP sessions', () => {
    const local = [
      {
        sessionId: 'codex-1',
        projectPath: '/tmp/project',
        modified: '2026-02-28T00:00:00.000Z',
      },
      {
        sessionId: 'codex-2',
        projectPath: '/tmp/project',
        modified: '2026-02-28T00:00:00.000Z',
      },
    ];

    const filtered = filterUntrackedLocalBackendSessions(local, [
      {
        id: 'pcp-1',
        startedAt: '2026-02-28T00:00:00.000Z',
        backend: 'codex',
        backendSessionId: 'codex-1',
      },
    ]);

    expect(filtered.map((session) => session.sessionId)).toEqual(['codex-2']);
  });
});

describe('sanitizeBackendExecutionArgs', () => {
  it('redacts claude system prompt and one-shot prompt text', () => {
    const sanitized = sanitizeBackendExecutionArgs(
      [
        '-p',
        '--append-system-prompt',
        'identity text',
        '--mcp-config',
        '/tmp/.mcp.json',
        'fix this bug',
      ],
      'claude'
    );
    expect(sanitized).toEqual([
      '-p',
      '--append-system-prompt',
      '<redacted-system-prompt>',
      '--mcp-config',
      '/tmp/.mcp.json',
      '<redacted-prompt>',
    ]);
  });

  it('redacts trailing codex prompt parts when present', () => {
    const sanitized = sanitizeBackendExecutionArgs(
      [
        '--config',
        'model_instructions_file=/tmp/identity.md',
        '--model',
        'o3',
        'please',
        'summarize',
      ],
      'codex',
      ['please', 'summarize']
    );

    expect(sanitized).toEqual([
      '--config',
      'model_instructions_file=/tmp/identity.md',
      '--model',
      'o3',
      '<redacted-prompt-part>',
      '<redacted-prompt-part>',
    ]);
  });
});

describe('shouldAutoResumeRuntimeSession', () => {
  it('auto-resumes only for non-tty execution when runtime has a PCP session', () => {
    expect(shouldAutoResumeRuntimeSession({ pcpSessionId: 'pcp-1' }, false)).toBe(true);
    expect(shouldAutoResumeRuntimeSession({ pcpSessionId: 'pcp-1' }, true)).toBe(false);
    expect(shouldAutoResumeRuntimeSession(undefined, false)).toBe(false);
    expect(shouldAutoResumeRuntimeSession({ backendSessionId: 'b-1' }, false)).toBe(false);
  });
});

describe('shouldRetryWithFreshBackendSession', () => {
  it('retries claude when resume fails with no conversation found', () => {
    expect(
      shouldRetryWithFreshBackendSession({
        backend: 'claude',
        attemptedBackendSessionId: 'abc123',
        stderrText: 'No conversation found with session ID: abc123',
      })
    ).toBe(true);
  });

  it('retries claude when session id is already in use', () => {
    expect(
      shouldRetryWithFreshBackendSession({
        backend: 'claude',
        attemptedBackendSessionId: 'abc123',
        stderrText: 'Error: Session ID abc123 is already in use.',
      })
    ).toBe(true);
  });

  it('does not retry when no backend session id was attempted', () => {
    expect(
      shouldRetryWithFreshBackendSession({
        backend: 'claude',
        stderrText: 'No conversation found with session ID: abc123',
      })
    ).toBe(false);
  });
});

describe('resolveBackendSessionIdForResume', () => {
  it('keeps selected local backend session id when provided', () => {
    expect(
      resolveBackendSessionIdForResume({
        backend: 'claude',
        chosen: {
          id: 'pcp-1',
          startedAt: '2026-02-28T00:00:00.000Z',
          backend: 'claude',
          backendSessionId: 'stale-id',
        },
        selectedLocalBackendSessionId: 'local-id',
        localBackendSessionIds: new Set(['local-id']),
      })
    ).toEqual({ backendSessionId: 'local-id' });
  });

  it('drops stale tracked backend id when local project sessions are known and do not match', () => {
    expect(
      resolveBackendSessionIdForResume({
        backend: 'claude',
        chosen: {
          id: 'pcp-1',
          startedAt: '2026-02-28T00:00:00.000Z',
          backend: 'claude',
          backendSessionId: 'stale-id',
        },
        localBackendSessionIds: new Set(['local-a', 'local-b']),
      })
    ).toEqual({
      backendSessionId: 'pcp-1',
      staleTrackedBackendSessionId: 'stale-id',
      fallbackMode: 'resume_pcp_session_id',
    });
  });

  it('does not classify session as stale when it exists in global backend index', () => {
    expect(
      resolveBackendSessionIdForResume({
        backend: 'claude',
        chosen: {
          id: 'pcp-1',
          startedAt: '2026-02-28T00:00:00.000Z',
          backend: 'claude',
          backendSessionId: 'known-global-id',
        },
        localBackendSessionIds: new Set(['local-a', 'local-b']),
        knownBackendSessionIds: new Set(['known-global-id', 'local-a']),
      })
    ).toEqual({ backendSessionId: 'known-global-id' });
  });

  it('keeps tracked backend id when it matches local project sessions', () => {
    expect(
      resolveBackendSessionIdForResume({
        backend: 'claude',
        chosen: {
          id: 'pcp-1',
          startedAt: '2026-02-28T00:00:00.000Z',
          backend: 'claude',
          backendSessionId: 'local-a',
        },
        localBackendSessionIds: new Set(['local-a', 'local-b']),
      })
    ).toEqual({ backendSessionId: 'local-a' });
  });

  it('accepts backend aliases when validating chosen session backend', () => {
    expect(
      resolveBackendSessionIdForResume({
        backend: 'codex',
        chosen: {
          id: 'pcp-codex',
          startedAt: '2026-02-28T00:00:00.000Z',
          backend: 'codex-cli',
          backendSessionId: 'codex-local-a',
        },
        localBackendSessionIds: new Set(['codex-local-a']),
      })
    ).toEqual({ backendSessionId: 'codex-local-a' });
  });
});

describe('resolveAdoptableLocalBackendSessionId', () => {
  it('does not adopt for claude backend', () => {
    expect(
      resolveAdoptableLocalBackendSessionId({
        backend: 'claude',
        chosen: { id: 'pcp-1', startedAt: '2026-03-02T21:30:14.354Z' },
        localSessions: [
          {
            backend: 'claude',
            sessionId: 'local-1',
            projectPath: '/tmp/project',
            modified: '2026-03-02T21:30:20.000Z',
          },
        ],
      })
    ).toBeUndefined();
  });

  it('adopts the single untracked codex local session', () => {
    expect(
      resolveAdoptableLocalBackendSessionId({
        backend: 'codex',
        createdNewPcpSession: false,
        chosen: { id: 'pcp-1', startedAt: '2026-03-02T21:30:14.354Z' },
        localSessions: [
          {
            backend: 'codex',
            sessionId: '019cb076-af49-7471-bd8e-12315a616dca',
            projectPath: '/tmp/project',
            modified: '2026-03-02T21:33:22.000Z',
          },
        ],
      })
    ).toBe('019cb076-af49-7471-bd8e-12315a616dca');
  });

  it('does not auto-adopt local codex sessions for newly created PCP sessions', () => {
    expect(
      resolveAdoptableLocalBackendSessionId({
        backend: 'codex',
        createdNewPcpSession: true,
        chosen: { id: 'pcp-1', startedAt: '2026-03-02T21:30:14.354Z' },
        localSessions: [
          {
            backend: 'codex',
            sessionId: '019cb076-af49-7471-bd8e-12315a616dca',
            projectPath: '/tmp/project',
            modified: '2026-03-02T21:33:22.000Z',
          },
        ],
      })
    ).toBeUndefined();
  });

  it('adopts by start-time proximity when exactly one nearby session exists', () => {
    expect(
      resolveAdoptableLocalBackendSessionId({
        backend: 'gemini',
        chosen: { id: 'pcp-1', startedAt: '2026-03-02T21:30:14.354Z' },
        localSessions: [
          {
            backend: 'gemini',
            sessionId: 'gem-nearby',
            projectPath: '/tmp/project',
            modified: '2026-03-02T21:31:00.000Z',
          },
          {
            backend: 'gemini',
            sessionId: 'gem-old',
            projectPath: '/tmp/project',
            modified: '2026-03-02T20:00:00.000Z',
          },
        ],
      })
    ).toBe('gem-nearby');
  });

  it('does not adopt when multiple nearby sessions exist', () => {
    expect(
      resolveAdoptableLocalBackendSessionId({
        backend: 'codex',
        chosen: { id: 'pcp-1', startedAt: '2026-03-02T21:30:14.354Z' },
        localSessions: [
          {
            backend: 'codex',
            sessionId: 'local-1',
            projectPath: '/tmp/project',
            modified: '2026-03-02T21:31:00.000Z',
          },
          {
            backend: 'codex',
            sessionId: 'local-2',
            projectPath: '/tmp/project',
            modified: '2026-03-02T21:32:00.000Z',
          },
        ],
      })
    ).toBeUndefined();
  });
});

describe('resolveBackendSessionSeedId', () => {
  it('seeds claude on first run when pcp session is newly created', () => {
    expect(
      resolveBackendSessionSeedId({
        backend: 'claude',
        chosenSessionId: 'pcp-new-1',
        createdNewPcpSession: true,
      })
    ).toBe('pcp-new-1');
  });

  it('does not seed claude for stale existing sessions (uses resume fallback instead)', () => {
    expect(
      resolveBackendSessionSeedId({
        backend: 'claude',
        chosenSessionId: 'pcp-existing-1',
        createdNewPcpSession: false,
      })
    ).toBeUndefined();
  });

  it('does not seed when backend-native session id is already known', () => {
    expect(
      resolveBackendSessionSeedId({
        backend: 'claude',
        chosenSessionId: 'pcp-existing-1',
        backendSessionId: 'claude-123',
        createdNewPcpSession: false,
      })
    ).toBeUndefined();
  });
});

describe('resolveCapturedBackendSessionIdFromRuntime', () => {
  it('returns fallback when no pcp session id is present', () => {
    expect(
      resolveCapturedBackendSessionIdFromRuntime({
        backend: 'claude',
        fallbackBackendSessionId: 'fallback-id',
      })
    ).toBe('fallback-id');
  });

  it('falls back to new local backend session for the project when runtime linkage is missing', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'sb-claude-runtime-'));
    const tempHome = join(tempRoot, 'home');
    const tempRepo = join(tempRoot, 'repo');
    mkdirSync(tempHome, { recursive: true });
    mkdirSync(tempRepo, { recursive: true });

    const projectDirName = tempRepo.replace(/[\\/]/g, '-');
    const projectKeyDir = join(tempHome, '.claude', 'projects', projectDirName);
    mkdirSync(projectKeyDir, { recursive: true });

    const oldHome = process.env.HOME;
    process.env.HOME = tempHome;

    try {
      const oldSessionId = '11111111-1111-4111-8111-111111111111';
      const newSessionId = '22222222-2222-4222-8222-222222222222';
      writeFileSync(
        join(projectKeyDir, `${oldSessionId}.jsonl`),
        JSON.stringify({
          type: 'progress',
          sessionId: oldSessionId,
          timestamp: '2026-03-04T00:00:00.000Z',
        }) + '\n'
      );
      writeFileSync(
        join(projectKeyDir, `${newSessionId}.jsonl`),
        JSON.stringify({
          type: 'progress',
          sessionId: newSessionId,
          timestamp: '2026-03-04T00:01:00.000Z',
        }) + '\n'
      );

      const resolved = resolveCapturedBackendSessionIdFromRuntime({
        cwd: tempRepo,
        backend: 'claude',
        pcpSessionId: 'pcp-session-1',
        knownLocalSessionIds: new Set([oldSessionId]),
      });

      expect(resolved).toBe(newSessionId);
    } finally {
      if (oldHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = oldHome;
      }
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('extractClaudeHistorySessionsForProject', () => {
  it('parses local claude sessions from history.jsonl for the current project path', () => {
    const jsonl = [
      JSON.stringify({
        sessionId: 'sess-clearpol-1',
        project: '/Users/conormclaughlin/ws/clearpol-ai',
        timestamp: 1772254853007,
        display: 'Hi Wren',
      }),
      JSON.stringify({
        sessionId: 'sess-other',
        project: '/Users/conormclaughlin/ws/another-repo',
        timestamp: 1772254853007,
      }),
    ].join('\n');

    const parsed = extractClaudeHistorySessionsForProject(
      jsonl,
      '/Users/conormclaughlin/ws/clearpol-ai'
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0].sessionId).toBe('sess-clearpol-1');
    expect(parsed[0].backend).toBe('claude');
    expect(parsed[0].firstPrompt).toBe('Hi Wren');
  });
});

describe('getClaudeLocalSessionsForProject previews', () => {
  it('extracts latest assistant preview from claude project jsonl', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'sb-claude-preview-'));
    const tempHome = join(tempRoot, 'home');
    const projectPath = join(tempRoot, 'repo');
    mkdirSync(tempHome, { recursive: true });
    mkdirSync(projectPath, { recursive: true });

    const projectDirName = projectPath.replace(/[\\/]/g, '-');
    const projectDir = join(tempHome, '.claude', 'projects', projectDirName);
    mkdirSync(projectDir, { recursive: true });

    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const hugePrefix = 'x'.repeat(400_000);
    writeFileSync(
      join(projectDir, `${sessionId}.jsonl`),
      [
        hugePrefix,
        JSON.stringify({
          type: 'user',
          sessionId,
          timestamp: '2026-03-04T08:00:00.000Z',
          message: { role: 'user', content: 'Hello Wren' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId,
          timestamp: '2026-03-04T08:00:05.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi Conor — latest assistant reply' }],
          },
        }),
      ].join('\n') + '\n'
    );

    const originalHome = process.env.HOME;
    process.env.HOME = tempHome;

    try {
      const sessions = getClaudeLocalSessionsForProject(projectPath, 10);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.sessionId).toBe(sessionId);
      expect(sessions[0]?.latestPrompt).toBe('assistant: Hi Conor — latest assistant reply');
      expect(sessions[0]?.latestPromptAt).toBe('2026-03-04T08:00:05.000Z');
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('getCodexLocalSessionsForProject', () => {
  it('falls back to codex session jsonl files when sqlite db is unavailable', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'codex-jsonl-fallback-'));
    const projectPath = join(tempHome, 'repo');
    mkdirSync(projectPath, { recursive: true });

    const codexSessionsDir = join(tempHome, '.codex', 'sessions', '2026', '03', '02');
    mkdirSync(codexSessionsDir, { recursive: true });

    const matchingSessionId = '019a23ac-e563-7d53-8bf0-5a948546bf29';
    const nonMatchingSessionId = '019a23b9-b211-7972-b007-012a8bc1d6f2';
    writeFileSync(
      join(codexSessionsDir, `rollout-2026-03-02T11-44-41-${matchingSessionId}.jsonl`),
      [
        JSON.stringify({
          timestamp: '2026-03-02T11:44:41.000Z',
          type: 'session_meta',
          payload: {
            id: matchingSessionId,
            cwd: projectPath,
            timestamp: '2026-03-02T11:44:41.000Z',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-02T11:44:51.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Most recent assistant reply' }],
          },
        }),
      ].join('\n') + '\n'
    );
    writeFileSync(
      join(codexSessionsDir, `rollout-2026-03-02T11-44-41-${nonMatchingSessionId}.jsonl`),
      `${JSON.stringify({
        timestamp: '2026-03-02T11:44:41.000Z',
        type: 'session_meta',
        payload: {
          id: nonMatchingSessionId,
          cwd: join(tempHome, 'other-repo'),
          timestamp: '2026-03-02T11:44:41.000Z',
        },
      })}\n`
    );

    const originalHome = process.env.HOME;
    process.env.HOME = tempHome;

    try {
      const sessions = getCodexLocalSessionsForProject(projectPath, 10);
      expect(sessions.map((session) => session.sessionId)).toEqual([matchingSessionId]);
      expect(sessions[0]?.latestPrompt).toBe('assistant: Most recent assistant reply');
      expect(sessions[0]?.transcriptPath).toContain(matchingSessionId);
    } finally {
      process.env.HOME = originalHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('extractSessionFromStartSessionResponse', () => {
  it('extracts nested session payload', () => {
    expect(
      extractSessionFromStartSessionResponse({
        session: {
          id: 'pcp-1',
          startedAt: '2026-03-03T00:00:00.000Z',
          backend: 'codex',
        },
      })
    ).toMatchObject({ id: 'pcp-1', backend: 'codex' });
  });

  it('extracts top-level session payload', () => {
    expect(
      extractSessionFromStartSessionResponse({
        id: 'pcp-2',
        startedAt: '2026-03-03T00:00:00.000Z',
        backend: 'codex',
      })
    ).toMatchObject({ id: 'pcp-2', backend: 'codex' });
  });

  it('returns undefined for payloads without session objects', () => {
    expect(
      extractSessionFromStartSessionResponse({ success: true, message: 'ok' })
    ).toBeUndefined();
  });
});

describe('resolveStartedSessionFromList', () => {
  it('prefers requested session id when present', () => {
    const resolved = resolveStartedSessionFromList({
      beforeSessionIds: new Set(['pcp-old']),
      requestedSessionId: 'pcp-new',
      listedSessions: [
        {
          id: 'pcp-old',
          startedAt: '2026-03-03T00:00:00.000Z',
          backend: 'codex',
        },
        {
          id: 'pcp-new',
          startedAt: '2026-03-03T00:01:00.000Z',
          backend: 'codex',
        },
      ],
    });

    expect(resolved?.id).toBe('pcp-new');
  });

  it('falls back to the newest newly created session', () => {
    const resolved = resolveStartedSessionFromList({
      beforeSessionIds: new Set(['pcp-old']),
      listedSessions: [
        {
          id: 'pcp-old',
          startedAt: '2026-03-03T00:00:00.000Z',
          backend: 'codex',
        },
        {
          id: 'pcp-new-a',
          startedAt: '2026-03-03T00:01:00.000Z',
          backend: 'codex',
        },
        {
          id: 'pcp-new-b',
          startedAt: '2026-03-03T00:02:00.000Z',
          backend: 'codex',
        },
      ],
    });

    expect(resolved?.id).toBe('pcp-new-b');
  });

  it('returns undefined when no new session can be inferred', () => {
    const resolved = resolveStartedSessionFromList({
      beforeSessionIds: new Set(['pcp-old']),
      listedSessions: [
        {
          id: 'pcp-old',
          startedAt: '2026-03-03T00:00:00.000Z',
          backend: 'codex',
        },
      ],
    });

    expect(resolved).toBeUndefined();
  });
});
