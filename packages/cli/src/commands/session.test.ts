import { describe, expect, it } from 'vitest';
import {
  buildTranscriptInstallPlan,
  materializeSyncedTranscriptContent,
  renderSessionsByAgent,
  renderSyncedTranscriptArchives,
  type Session,
} from './session.js';

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('renderSessionsByAgent', () => {
  it('groups sessions by SB with attach hints', () => {
    const sessions: Session[] = [
      {
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        sbSlug: 'lumen',
        status: 'active',
        currentPhase: 'implementing',
        threadKey: 'pr:61',
        startedAt: new Date('2026-02-18T20:00:00.000Z').toISOString(),
        studioId: '2b086159-3bad-4cee-ad85-30fbc5d3206f',
        studio: {
          id: '2b086159-3bad-4cee-ad85-30fbc5d3206f',
          worktreePath: '/Users/conormclaughlin/ws/pcp/personal-context-protocol--lumen',
          worktreeFolder: 'personal-context-protocol--lumen',
          branch: 'lumen/feat/ink-first-class-repl-remote',
        },
      },
      {
        id: 'ffffffff-1111-2222-3333-444444444444',
        sbSlug: 'wren',
        status: 'completed',
        startedAt: new Date('2026-02-17T18:00:00.000Z').toISOString(),
        endedAt: new Date('2026-02-17T19:00:00.000Z').toISOString(),
      },
    ];

    const output = stripAnsi(renderSessionsByAgent(sessions).join('\n'));
    expect(output).toContain('lumen (1 session, 1 active)');
    expect(output).toContain('wren (1 session, 0 active)');
    expect(output).toContain(
      'Attach:  ink chat -a lumen --attach aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    );
    expect(output).toContain('Thread:  pr:61');
    expect(output).toContain(
      'Path:    /Users/conormclaughlin/ws/pcp/personal-context-protocol--lumen'
    );
    expect(output).toContain('Branch:  lumen/feat/ink-first-class-repl-remote');
  });

  it('renders empty state and flat mode', () => {
    expect(stripAnsi(renderSessionsByAgent([]).join('\n'))).toContain('No sessions found');

    const flatOutput = stripAnsi(
      renderSessionsByAgent(
        [
          {
            id: '11111111-2222-3333-4444-555555555555',
            sbSlug: 'aster',
            status: 'active',
            startedAt: new Date('2026-02-18T19:00:00.000Z').toISOString(),
          },
        ],
        true
      ).join('\n')
    );
    expect(flatOutput).toContain(
      'Attach:  ink chat -a aster --attach 11111111-2222-3333-4444-555555555555'
    );
    expect(flatOutput).not.toContain('(1 session,');
  });
});

describe('renderSyncedTranscriptArchives', () => {
  it('renders synced transcript summaries', () => {
    const output = stripAnsi(
      renderSyncedTranscriptArchives([
        {
          archiveId: 'archive-1',
          sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          backend: 'claude',
          backendSessionId: 'backend-1',
          format: 'jsonl',
          lineCount: 321,
          byteCount: 45678,
          sourcePath: '/tmp/backend-1.jsonl',
          syncedAt: new Date('2026-03-11T20:00:00.000Z').toISOString(),
          session: {
            id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            sbSlug: 'lumen',
            agentName: 'Lumen',
            threadKey: 'pr:219',
            startedAt: new Date('2026-03-11T19:00:00.000Z').toISOString(),
            updatedAt: new Date('2026-03-11T20:00:00.000Z').toISOString(),
            workingDir: '/repo',
          },
        },
      ]).join('\n')
    );

    expect(output).toContain('aaaaaaaa (claude)');
    expect(output).toContain('Agent:   Lumen');
    expect(output).toContain('Thread:  pr:219');
    expect(output).toContain('Source:  /tmp/backend-1.jsonl');
    expect(output).toContain('Path:    /repo');
  });
});

describe('materializeSyncedTranscriptContent', () => {
  it('prefers rawContent when present', () => {
    expect(
      materializeSyncedTranscriptContent({
        format: 'jsonl',
        rawContent: '{"type":"user"}\n',
        events: [{ type: 'assistant' }],
      })
    ).toEqual({
      content: '{"type":"user"}\n',
      format: 'jsonl',
      restoredFrom: 'raw',
    });
  });

  it('falls back to event reconstruction', () => {
    expect(
      materializeSyncedTranscriptContent({
        format: 'jsonl',
        events: [{ type: 'user', content: 'hello' }],
      })
    ).toEqual({
      content: '{"type":"user","content":"hello"}\n',
      format: 'jsonl',
      restoredFrom: 'events',
    });
  });
});

describe('buildTranscriptInstallPlan', () => {
  it('uses the current project context for Claude installs', () => {
    const plan = buildTranscriptInstallPlan({
      sessionId: 'session-1',
      backend: 'claude',
      backendSessionId: 'backend-1',
      format: 'jsonl',
      targetCwd: '/Users/conormclaughlin/ws/pcp/personal-context-protocol',
      resolvedBy: 'cwd',
    });

    expect(plan.destinationPath).toContain(
      '/.claude/projects/Users-conormclaughlin-ws-pcp-personal-context-protocol/backend-1.jsonl'
    );
    expect(plan.targetCwd).toBe('/Users/conormclaughlin/ws/pcp/personal-context-protocol');
  });

  it('creates gemini project-root sidecars for cwd installs', () => {
    const plan = buildTranscriptInstallPlan({
      sessionId: 'session-2',
      backend: 'gemini',
      backendSessionId: 'gemini-2',
      format: 'json',
      targetCwd: '/Users/conormclaughlin/ws/pcp/personal-context-protocol',
      resolvedBy: 'implicit-cwd',
    });

    expect(plan.destinationPath).toContain(
      '/.gemini/tmp/Users-conormclaughlin-ws-pcp-personal-context-protocol/chats/session-import-gemini-2.json'
    );
    expect(plan.sidecarFiles).toEqual([
      {
        path: expect.stringContaining(
          '/.gemini/history/Users-conormclaughlin-ws-pcp-personal-context-protocol/.project_root'
        ),
        content: '/Users/conormclaughlin/ws/pcp/personal-context-protocol\n',
      },
    ]);
  });

  // This branch was unreachable until #655: it matched only the pre-rename
  // 'pcp' spelling while sessions store 'ink', so `ink session sync` on an ink
  // session fell past every branch and threw "Cannot infer a backend-native
  // install target". Nothing covered it, which is how it stayed that way.
  it('installs ink-backend transcripts under the studio .ink/runtime/repl', () => {
    const plan = buildTranscriptInstallPlan({
      sessionId: 'session-3',
      backend: 'ink',
      backendSessionId: 'backend-3',
      format: 'jsonl',
      targetCwd: '/tmp/studio',
      resolvedBy: 'cwd',
    });

    expect(plan.destinationPath).toBe(
      '/tmp/studio/.ink/runtime/repl/session-3-synced-backend-3.jsonl'
    );
    expect(plan.sidecarFiles).toEqual([]);
  });

  it('still resolves rows written with the pre-rename backend value', () => {
    const plan = buildTranscriptInstallPlan({
      sessionId: 'session-4',
      backend: 'pcp',
      backendSessionId: 'backend-4',
      format: 'json',
      targetCwd: '/tmp/studio',
      resolvedBy: 'cwd',
    });

    expect(plan.destinationPath).toBe(
      '/tmp/studio/.ink/runtime/repl/session-4-synced-backend-4.json'
    );
  });

  it('supports explicit path installs', () => {
    const plan = buildTranscriptInstallPlan({
      sessionId: 'session-3',
      backend: 'claude',
      backendSessionId: 'backend-3',
      format: 'jsonl',
      targetPath: '/tmp/session-3.jsonl',
      resolvedBy: 'path',
    });

    expect(plan).toEqual({
      destinationPath: '/tmp/session-3.jsonl',
      sidecarFiles: [],
      resolvedBy: 'path',
    });
  });
});
