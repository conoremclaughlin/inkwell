import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  extractClaudeHistorySessionsForProject,
  filterPcpSessionsForContext,
  filterUntrackedLocalClaudeSessions,
  hasBackendSessionOverride,
  parseClaudeSessionIdFromOutputLine,
  resolveCapturedBackendSessionIdFromRuntime,
  resolveBackendSessionIdForResume,
  resolveBackendSessionSeedId,
  resolveClaudeStaleBackendSessionRecovery,
  sanitizeBackendExecutionArgs,
  shouldRetryClaudeAfterFailedLaunch,
  shouldRetryWithFreshBackendSession,
  shouldAutoResumeRuntimeSession,
} from './claude.js';
import { upsertRuntimeSession } from '../session/runtime.js';

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
    expect(hasBackendSessionOverride('codex', ['resume'])).toBe(false);
    expect(hasBackendSessionOverride('codex', ['resume', '--latest'])).toBe(false);
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

  it('filters non-claude sessions only by backend', () => {
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

    expect(filtered.map((session) => session.id)).toEqual(['codex-1']);
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

describe('parseClaudeSessionIdFromOutputLine', () => {
  it('parses backend session id from explicit resume command line', () => {
    expect(
      parseClaudeSessionIdFromOutputLine(
        'Resume this session with: claude --resume c72051cc-5abd-4403-84cb-a0852ae86a30'
      )
    ).toBe('c72051cc-5abd-4403-84cb-a0852ae86a30');
  });

  it('ignores generic json lines that contain session_id fields', () => {
    expect(
      parseClaudeSessionIdFromOutputLine(
        '{"type":"event","session_id":"f56adc85-f3c3-4721-a1fe-5e673dd1e705"}'
      )
    ).toBeUndefined();
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

describe('shouldRetryClaudeAfterFailedLaunch', () => {
  it('retries once on nonzero claude exit when session routing was attempted', () => {
    expect(
      shouldRetryClaudeAfterFailedLaunch({
        backend: 'claude',
        exitCode: 1,
        attempt: 1,
        maxAttempts: 2,
        attemptedBackendSessionId: 'abc123',
      })
    ).toBe(true);
  });

  it('does not retry for user-interrupt exits', () => {
    expect(
      shouldRetryClaudeAfterFailedLaunch({
        backend: 'claude',
        exitCode: 130,
        attempt: 1,
        maxAttempts: 2,
        attemptedBackendSessionId: 'abc123',
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

  it('flags stale tracked backend id when local project sessions are known and do not match', () => {
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
      staleTrackedBackendSessionId: 'stale-id',
    });
  });

  it('for non-claude backends, keeps tracked id when it exists in global backend index', () => {
    expect(
      resolveBackendSessionIdForResume({
        backend: 'codex',
        chosen: {
          id: 'pcp-1',
          startedAt: '2026-02-28T00:00:00.000Z',
          backend: 'codex',
          backendSessionId: 'known-global-id',
        },
        localBackendSessionIds: new Set(['local-a', 'local-b']),
        knownBackendSessionIds: new Set(['known-global-id', 'local-a']),
      })
    ).toEqual({ backendSessionId: 'known-global-id' });
  });

  it('for claude, treats global-only matches as stale if not present in local project sessions', () => {
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
    ).toEqual({ staleTrackedBackendSessionId: 'known-global-id' });
  });

  it('for claude, trusts canonical pcp-matched backend id even when local scans miss it', () => {
    expect(
      resolveBackendSessionIdForResume({
        backend: 'claude',
        chosen: {
          id: 'c72051cc-5abd-4403-84cb-a0852ae86a30',
          startedAt: '2026-02-28T00:00:00.000Z',
          backend: 'claude',
          backendSessionId: 'c72051cc-5abd-4403-84cb-a0852ae86a30',
        },
        localBackendSessionIds: new Set(['recent-a', 'recent-b']),
      })
    ).toEqual({ backendSessionId: 'c72051cc-5abd-4403-84cb-a0852ae86a30' });
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

describe('resolveClaudeStaleBackendSessionRecovery', () => {
  it('resumes orphaned PCP session id when it exists locally', () => {
    expect(
      resolveClaudeStaleBackendSessionRecovery({
        pcpSessionId: 'pcp-123',
        localBackendSessionIds: new Set(['pcp-123', 'other']),
      })
    ).toEqual({
      backendSessionId: 'pcp-123',
      recoveryMode: 'resume_orphaned_pcp_id',
    });
  });

  it('seeds with PCP session id when orphan does not exist locally', () => {
    expect(
      resolveClaudeStaleBackendSessionRecovery({
        pcpSessionId: 'pcp-123',
        localBackendSessionIds: new Set(['local-a']),
      })
    ).toEqual({
      backendSessionSeedId: 'pcp-123',
      recoveryMode: 'seed_with_pcp_id',
    });
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
      writeFileSync(join(projectKeyDir, `${oldSessionId}.jsonl`), '');
      writeFileSync(join(projectKeyDir, `${newSessionId}.jsonl`), '');

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

  it('prefers explicit fallback backend session id over local discovery', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'sb-claude-runtime-fallback-'));
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
      writeFileSync(join(projectKeyDir, `${oldSessionId}.jsonl`), '');
      writeFileSync(join(projectKeyDir, `${newSessionId}.jsonl`), '');

      const resolved = resolveCapturedBackendSessionIdFromRuntime({
        cwd: tempRepo,
        backend: 'claude',
        pcpSessionId: 'pcp-session-1',
        knownLocalSessionIds: new Set([oldSessionId]),
        fallbackBackendSessionId: 'fallback-resume-id',
      });

      expect(resolved).toBe('fallback-resume-id');
    } finally {
      if (oldHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = oldHome;
      }
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('prefers fallback even when runtime cache has a different backend session id', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'sb-claude-runtime-prefer-fallback-'));
    const tempRepo = join(tempRoot, 'repo');
    mkdirSync(tempRepo, { recursive: true });

    try {
      upsertRuntimeSession(tempRepo, {
        pcpSessionId: 'pcp-session-1',
        backend: 'claude',
        agentId: 'wren',
        backendSessionId: 'runtime-mismatched-id',
      });

      const resolved = resolveCapturedBackendSessionIdFromRuntime({
        cwd: tempRepo,
        backend: 'claude',
        pcpSessionId: 'pcp-session-1',
        agentId: 'wren',
        fallbackBackendSessionId: 'resume-explicit-id',
      });

      expect(resolved).toBe('resume-explicit-id');
    } finally {
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
