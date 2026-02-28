import { describe, expect, it } from 'vitest';
import {
  extractClaudeHistorySessionsForProject,
  filterPcpSessionsForContext,
  filterUntrackedLocalClaudeSessions,
  hasBackendSessionOverride,
  sanitizeBackendExecutionArgs,
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
