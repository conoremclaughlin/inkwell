import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  extractClaudeHistorySessionsForProject,
  extractBackendSessionOverrideId,
  extractLatestPreviewFromClaudeSessionJsonl,
  extractLatestPreviewFromPcpTranscriptJsonl,
  extractSessionFromStartSessionResponse,
  filterUntrackedLocalBackendSessions,
  filterPcpSessionsForContext,
  filterUntrackedLocalClaudeSessions,
  buildSessionPickerLabel,
  getBackendLocalSessionsForProject,
  getClaudeLocalSessionsForProject,
  getKnownClaudeSessionIds,
  getCodexLocalSessionsForProject,
  getGeminiLocalSessionsForProject,
  hasBackendSessionOverride,
  renderSessionCandidatesTable,
  resolveCapturedBackendSessionIdFromRuntime,
  resolveCapturedBackendSessionIdWithRetry,
  resolveAdoptableLocalBackendSessionId,
  resolveBackendSessionIdForResume,
  resolveBackendSessionSeedId,
  resolveStartedSessionFromList,
  sanitizeBackendExecutionArgs,
  sortSessionEntriesByRecency,
  shouldRetryWithFreshBackendSession,
  shouldAutoResumeRuntimeSession,
  withSessionFileSize,
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
    expect(hasBackendSessionOverride('codex', [], ['summarize', 'resume'])).toBe(false);
  });

  it('treats codex resume prompt without explicit session id as override', () => {
    expect(hasBackendSessionOverride('codex', [], ['resume'])).toBe(true);
  });

  it('treats codex resume passthrough args as override', () => {
    expect(hasBackendSessionOverride('codex', ['resume'])).toBe(true);
    expect(hasBackendSessionOverride('codex', ['resume', '--latest'])).toBe(true);
    expect(hasBackendSessionOverride('codex', ['--full-auto', 'resume', '019c1234'])).toBe(true);
    expect(hasBackendSessionOverride('codex', ['foo', 'resume'])).toBe(false);
  });

  it('still respects flag-based resume overrides', () => {
    expect(hasBackendSessionOverride('codex', ['--resume', 'abc123'])).toBe(true);
    expect(hasBackendSessionOverride('claude', ['--resume', 'abc123'])).toBe(true);
    expect(hasBackendSessionOverride('gemini', ['--session-id', 'abc123'])).toBe(true);
  });

  it('treats backend resume flags as overrides even without explicit ids', () => {
    expect(hasBackendSessionOverride('claude', ['--resume'])).toBe(true);
    expect(hasBackendSessionOverride('claude', ['-r'])).toBe(true);
    expect(hasBackendSessionOverride('gemini', ['--resume'])).toBe(true);
    expect(hasBackendSessionOverride('gemini', ['-r'])).toBe(true);
  });
});

describe('extractBackendSessionOverrideId', () => {
  it('extracts codex resume id from positional subcommand', () => {
    expect(
      extractBackendSessionOverrideId(
        'codex',
        [],
        ['resume', '019c44fd-68f6-7332-9eda-2dc7c8afcedf']
      )
    ).toBe('019c44fd-68f6-7332-9eda-2dc7c8afcedf');
  });

  it('extracts codex resume id from passthrough subcommand', () => {
    expect(extractBackendSessionOverrideId('codex', ['--full-auto', 'resume', '019c1234'])).toBe(
      '019c1234'
    );
  });

  it('extracts claude --resume id', () => {
    expect(extractBackendSessionOverrideId('claude', ['--resume', 'ba549776-aaaa'])).toBe(
      'ba549776-aaaa'
    );
  });

  it('returns undefined when no explicit override id is present', () => {
    expect(extractBackendSessionOverrideId('claude', ['--resume'])).toBeUndefined();
    expect(extractBackendSessionOverrideId('codex', ['resume'])).toBeUndefined();
  });
});

describe('renderSessionCandidatesTable', () => {
  it('renders headers and aligned rows with truncation', () => {
    const lines = renderSessionCandidatesTable([
      {
        type: 'new',
        choice: 'new',
        updated: '-',
        phase: '-',
        thread: '-',
        link: '-',
        preview: 'Start new session',
      },
      {
        type: 'pcp',
        choice: 'pcp:12345678',
        updated: '3/7/2026, 1:23:45 PM',
        phase: 'runtime:idle',
        thread: 'pr:182',
        link: 'Claude 48650142',
        preview:
          'lumen: Resumed ✅ Quick checkpoint: Open PRs #149, #147, #126 and more detail that should be truncated in the table row output.',
      },
    ]);

    expect(lines[0]).toContain('TYPE');
    expect(lines[0]).toContain('CHOICE');
    expect(lines[0]).toContain('PREVIEW');
    expect(lines[2]).toContain('new');
    expect(lines[3]).toContain('pcp:12345678');
    expect(lines[3].length).toBe(lines[2].length);
  });
});

describe('buildSessionPickerLabel', () => {
  it('renders two lines when preview is present', () => {
    const label = buildSessionPickerLabel({
      metaLine: 'PCP        c4ec2f5e   runtime:idle         main         2m ago',
      preview: 'lumen: latest assistant message preview here',
    });

    expect(label).toContain('\n');
    expect(label).toContain('↳');
    expect(label).toContain('PCP');
    expect(label).toContain('c4ec2f5e');
  });
});

describe('withSessionFileSize', () => {
  it('prefixes file size before the preview text', () => {
    expect(withSessionFileSize('you: Nah just run it again as is', 8.55 * 1024 * 1024)).toBe(
      '8.55 MB · you: Nah just run it again as is'
    );
  });

  it('shows file size before the session fallback label', () => {
    expect(withSessionFileSize(undefined, 648)).toBe('648 B · (session)');
  });
});

describe('sortSessionEntriesByRecency', () => {
  it('sorts newest-first regardless of source type', () => {
    const sorted = sortSessionEntriesByRecency([
      { key: 'pcp:old', sortMs: 10 },
      { key: 'local:new', sortMs: 30 },
      { key: 'pcp:mid', sortMs: 20 },
    ]);

    expect(sorted.map((entry) => entry.key)).toEqual(['local:new', 'pcp:mid', 'pcp:old']);
  });

  it('uses key as stable tiebreaker for deterministic ordering', () => {
    const sorted = sortSessionEntriesByRecency([
      { key: 'local:b', sortMs: 10 },
      { key: 'pcp:a', sortMs: 10 },
      { key: 'pcp:c', sortMs: 10 },
    ]);

    expect(sorted.map((entry) => entry.key)).toEqual(['local:b', 'pcp:a', 'pcp:c'].sort());
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

  it('detects a brand-new local backend session even when pre-run snapshot is empty', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'sb-claude-runtime-empty-'));
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
      const newSessionId = '10101010-1010-4010-8010-101010101010';
      writeFileSync(
        join(projectKeyDir, `${newSessionId}.jsonl`),
        JSON.stringify({
          type: 'progress',
          sessionId: newSessionId,
          timestamp: '2026-03-09T00:00:00.000Z',
        }) + '\n'
      );

      const resolved = resolveCapturedBackendSessionIdFromRuntime({
        cwd: tempRepo,
        backend: 'claude',
        pcpSessionId: 'pcp-session-empty-snapshot',
        knownLocalSessionSnapshot: new Map(),
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

  it('retries local session detection to handle delayed transcript flushes', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'sb-claude-runtime-retry-'));
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
      const delayedSessionId = '20202020-2020-4020-8020-202020202020';
      const timer = setTimeout(() => {
        writeFileSync(
          join(projectKeyDir, `${delayedSessionId}.jsonl`),
          JSON.stringify({
            type: 'progress',
            sessionId: delayedSessionId,
            timestamp: '2026-03-09T00:03:00.000Z',
          }) + '\n'
        );
      }, 120);

      const resolved = await resolveCapturedBackendSessionIdWithRetry({
        cwd: tempRepo,
        backend: 'claude',
        pcpSessionId: 'pcp-session-retry',
        knownLocalSessionSnapshot: new Map(),
        attempts: 10,
        intervalMs: 40,
      });

      clearTimeout(timer);
      expect(resolved).toBe(delayedSessionId);
    } finally {
      if (oldHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = oldHome;
      }
      rmSync(tempRoot, { recursive: true, force: true });
    }
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
        knownLocalSessionSnapshot: new Map([[oldSessionId, '2026-03-04T00:00:00.000Z']]),
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

  it('falls back to modified existing local backend session when no new local id appears', () => {
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
      const existingSessionId = '33333333-3333-4333-8333-333333333333';
      const sessionPath = join(projectKeyDir, `${existingSessionId}.jsonl`);
      writeFileSync(
        sessionPath,
        JSON.stringify({
          type: 'progress',
          sessionId: existingSessionId,
          timestamp: '2026-03-04T00:00:00.000Z',
        }) + '\n'
      );

      const beforeModified = '2000-01-01T00:00:00.000Z';
      writeFileSync(
        sessionPath,
        JSON.stringify({
          type: 'progress',
          sessionId: existingSessionId,
          timestamp: '2026-03-04T00:02:00.000Z',
        }) + '\n'
      );

      const resolved = resolveCapturedBackendSessionIdFromRuntime({
        cwd: tempRepo,
        backend: 'claude',
        pcpSessionId: 'pcp-session-1',
        knownLocalSessionSnapshot: new Map([[existingSessionId, beforeModified]]),
      });

      expect(resolved).toBe(existingSessionId);
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

  it('uses size-first fallback labels when no conversational preview is available', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'sb-claude-preview-fallback-'));
    const tempHome = join(tempRoot, 'home');
    const projectPath = join(tempRoot, 'repo');
    mkdirSync(tempHome, { recursive: true });
    mkdirSync(projectPath, { recursive: true });

    const projectDirName = projectPath.replace(/[\\/]/g, '-');
    const projectDir = join(tempHome, '.claude', 'projects', projectDirName);
    mkdirSync(projectDir, { recursive: true });

    const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    writeFileSync(
      join(projectDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: 'progress',
        sessionId,
        timestamp: '2026-03-10T08:00:00.000Z',
      })}\n`
    );

    const originalHome = process.env.HOME;
    process.env.HOME = tempHome;

    try {
      const sessions = getClaudeLocalSessionsForProject(projectPath, 10);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.latestPrompt).toMatch(/ · \(session\)$/);
      expect(sessions[0]?.latestPrompt).not.toContain('(session) ·');
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

describe('extractLatestPreviewFromClaudeSessionJsonl', () => {
  it('ignores claude tool_result chatter and keeps meaningful assistant text', () => {
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const preview = extractLatestPreviewFromClaudeSessionJsonl(
      [
        JSON.stringify({
          type: 'user',
          sessionId,
          timestamp: '2026-03-10T07:57:00.000Z',
          message: { role: 'user', content: 'Hi Wren' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId,
          timestamp: '2026-03-10T07:57:01.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Let me check that for you.' }],
          },
        }),
        JSON.stringify({
          type: 'user',
          sessionId,
          timestamp: '2026-03-10T07:57:02.000Z',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                content:
                  '<local-command-stdout>Authentication successful. Connected to supabase.</local-command-stdout>',
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId,
          timestamp: '2026-03-10T07:57:03.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'All set — authentication worked.' }],
          },
        }),
      ].join('\n')
    );

    expect(preview).toEqual({
      role: 'assistant',
      content: 'All set — authentication worked.',
      ts: '2026-03-10T07:57:03.000Z',
    });
  });

  it('falls back to the last real conversational message when latest entry is tool noise', () => {
    const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const preview = extractLatestPreviewFromClaudeSessionJsonl(
      [
        JSON.stringify({
          type: 'user',
          sessionId,
          timestamp: '2026-03-10T08:00:00.000Z',
          message: { role: 'user', content: 'Can you check auth?' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId,
          timestamp: '2026-03-10T08:00:01.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Running the command now.' }],
          },
        }),
        JSON.stringify({
          type: 'user',
          sessionId,
          timestamp: '2026-03-10T08:00:02.000Z',
          message: {
            role: 'user',
            content:
              '<local-command-stdout>Authentication successful. Connected to supabase.</local-command-stdout>',
          },
        }),
      ].join('\n')
    );

    expect(preview).toEqual({
      role: 'assistant',
      content: 'Running the command now.',
      ts: '2026-03-10T08:00:01.000Z',
    });
  });
});

describe('extractLatestPreviewFromPcpTranscriptJsonl', () => {
  it('ignores local-command wrapper chatter and keeps last meaningful conversational text', () => {
    const preview = extractLatestPreviewFromPcpTranscriptJsonl(
      [
        JSON.stringify({
          type: 'assistant',
          ts: '2026-03-10T08:10:00.000Z',
          content: 'Real assistant reply',
        }),
        JSON.stringify({
          type: 'user',
          ts: '2026-03-10T08:10:01.000Z',
          content:
            '<local-command-stdout>Authentication successful. Connected to supabase.</local-command-stdout>',
        }),
      ].join('\n')
    );

    expect(preview).toEqual({
      role: 'assistant',
      content: 'Real assistant reply',
      ts: '2026-03-10T08:10:00.000Z',
    });
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
    const nonCliSessionId = '019a23ac-e563-7d53-8bf0-5a948546bf99';
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
            originator: 'codex_cli_rs',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-02T11:44:46.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'output_text',
                text: '<local-command-stdout>Authentication successful. Connected to supabase.</local-command-stdout>',
              },
            ],
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
      join(codexSessionsDir, `rollout-2026-03-02T11-45-41-${nonCliSessionId}.jsonl`),
      `${JSON.stringify({
        timestamp: '2026-03-02T11:45:41.000Z',
        type: 'session_meta',
        payload: {
          id: nonCliSessionId,
          cwd: projectPath,
          timestamp: '2026-03-02T11:45:41.000Z',
          originator: 'codex_exec',
        },
      })}\n`
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
      expect(sessions.map((session) => session.sessionId)).toEqual([
        nonCliSessionId,
        matchingSessionId,
      ]);
      expect(sessions[1]?.latestPrompt).toBe('assistant: Most recent assistant reply');
      expect(sessions[1]?.transcriptPath).toContain(matchingSessionId);

      const cliOnlySessions = getCodexLocalSessionsForProject(projectPath, 10, {
        includeExecSources: false,
      });
      expect(cliOnlySessions.map((session) => session.sessionId)).toEqual([matchingSessionId]);

      const defaultBackendSessions = getBackendLocalSessionsForProject('codex', projectPath, 10, {
        includeAllSources: false,
      });
      expect(defaultBackendSessions.map((session) => session.sessionId)).toEqual([
        nonCliSessionId,
        matchingSessionId,
      ]);

      const sessionsIncludingExec = getCodexLocalSessionsForProject(projectPath, 10, {
        includeExecSources: true,
      });
      expect(sessionsIncludingExec.map((session) => session.sessionId)).toEqual([
        nonCliSessionId,
        matchingSessionId,
      ]);
    } finally {
      process.env.HOME = originalHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('uses size-first fallback labels when rollout transcripts have no previewable messages', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'codex-jsonl-fallback-label-'));
    const projectPath = join(tempHome, 'repo');
    mkdirSync(projectPath, { recursive: true });

    const codexSessionsDir = join(tempHome, '.codex', 'sessions', '2026', '03', '02');
    mkdirSync(codexSessionsDir, { recursive: true });

    const sessionId = '019a23ac-e563-7d53-8bf0-5a948546bf88';
    writeFileSync(
      join(codexSessionsDir, `rollout-2026-03-02T11-44-41-${sessionId}.jsonl`),
      `${JSON.stringify({
        timestamp: '2026-03-02T11:44:41.000Z',
        type: 'session_meta',
        payload: {
          id: sessionId,
          cwd: projectPath,
          timestamp: '2026-03-02T11:44:41.000Z',
          originator: 'codex_cli_rs',
        },
      })}\n`
    );

    const originalHome = process.env.HOME;
    process.env.HOME = tempHome;

    try {
      const sessions = getCodexLocalSessionsForProject(projectPath, 10);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.latestPrompt).toMatch(/ · \(session\)$/);
      expect(sessions[0]?.latestPrompt).not.toContain('(session) ·');
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('getGeminiLocalSessionsForProject', () => {
  it('skips noisy auth/tool chatter and falls back to latest meaningful message', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'gemini-preview-filter-'));
    const projectPath = join(tempHome, 'repo');
    mkdirSync(projectPath, { recursive: true });

    const projectKey = projectPath.replace(/[\\/]/g, '-');
    const chatsDir = join(tempHome, '.gemini', 'tmp', projectKey, 'chats');
    const historyDir = join(tempHome, '.gemini', 'history', projectKey);
    mkdirSync(chatsDir, { recursive: true });
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(join(historyDir, '.project_root'), projectPath);

    writeFileSync(
      join(chatsDir, 'session-1.json'),
      JSON.stringify({
        sessionId: 'gemini-session-1',
        startTime: '2026-03-10T08:15:00.000Z',
        lastUpdated: '2026-03-10T08:15:03.000Z',
        messages: [
          { type: 'user', content: 'Hello Gemini' },
          { type: 'assistant', content: 'Here is the real reply' },
          {
            type: 'assistant',
            content:
              '<local-command-stdout>Authentication successful. Connected to supabase.</local-command-stdout>',
          },
        ],
      })
    );

    const originalHome = process.env.HOME;
    process.env.HOME = tempHome;

    try {
      const sessions = getGeminiLocalSessionsForProject(projectPath, 10);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.latestPrompt).toBe('assistant: Here is the real reply');
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('uses size-first fallback labels when gemini chat files have no meaningful preview', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'gemini-preview-fallback-'));
    const projectPath = join(tempHome, 'repo');
    mkdirSync(projectPath, { recursive: true });

    const projectKey = projectPath.replace(/[\\/]/g, '-');
    const chatsDir = join(tempHome, '.gemini', 'tmp', projectKey, 'chats');
    const historyDir = join(tempHome, '.gemini', 'history', projectKey);
    mkdirSync(chatsDir, { recursive: true });
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(join(historyDir, '.project_root'), projectPath);

    writeFileSync(
      join(chatsDir, 'session-2.json'),
      JSON.stringify({
        sessionId: 'gemini-session-2',
        startTime: '2026-03-10T08:15:00.000Z',
        lastUpdated: '2026-03-10T08:15:03.000Z',
        messages: [{ type: 'assistant', content: '   ' }],
      })
    );

    const originalHome = process.env.HOME;
    process.env.HOME = tempHome;

    try {
      const sessions = getGeminiLocalSessionsForProject(projectPath, 10);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.latestPrompt).toMatch(/ · \(session\)$/);
      expect(sessions[0]?.latestPrompt).not.toContain('(session) ·');
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
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
