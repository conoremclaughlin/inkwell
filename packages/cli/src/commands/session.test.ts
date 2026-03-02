import { describe, expect, it } from 'vitest';
import { renderSessionsByAgent, type Session } from './session.js';

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('renderSessionsByAgent', () => {
  it('groups sessions by SB with attach hints', () => {
    const sessions: Session[] = [
      {
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        agentId: 'lumen',
        status: 'active',
        currentPhase: 'implementing',
        threadKey: 'pr:61',
        startedAt: new Date('2026-02-18T20:00:00.000Z').toISOString(),
        studioId: '2b086159-3bad-4cee-ad85-30fbc5d3206f',
        studio: {
          id: '2b086159-3bad-4cee-ad85-30fbc5d3206f',
          worktreePath: '/Users/conormclaughlin/ws/pcp/personal-context-protocol--lumen',
          worktreeFolder: 'personal-context-protocol--lumen',
          branch: 'lumen/feat/pcp-first-class-repl-remote',
        },
      },
      {
        id: 'ffffffff-1111-2222-3333-444444444444',
        agentId: 'wren',
        status: 'completed',
        startedAt: new Date('2026-02-17T18:00:00.000Z').toISOString(),
        endedAt: new Date('2026-02-17T19:00:00.000Z').toISOString(),
      },
    ];

    const output = stripAnsi(renderSessionsByAgent(sessions).join('\n'));
    expect(output).toContain('lumen (1 session, 1 active)');
    expect(output).toContain('wren (1 session, 0 active)');
    expect(output).toContain('Attach:  sb chat -a lumen --attach aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(output).toContain('Thread:  pr:61');
    expect(output).toContain('Path:    /Users/conormclaughlin/ws/pcp/personal-context-protocol--lumen');
    expect(output).toContain('Branch:  lumen/feat/pcp-first-class-repl-remote');
  });

  it('renders empty state and flat mode', () => {
    expect(stripAnsi(renderSessionsByAgent([]).join('\n'))).toContain('No sessions found');

    const flatOutput = stripAnsi(
      renderSessionsByAgent(
        [
          {
            id: '11111111-2222-3333-4444-555555555555',
            agentId: 'aster',
            status: 'active',
            startedAt: new Date('2026-02-18T19:00:00.000Z').toISOString(),
          },
        ],
        true
      ).join('\n')
    );
    expect(flatOutput).toContain('Attach:  sb chat -a aster --attach 11111111-2222-3333-4444-555555555555');
    expect(flatOutput).not.toContain('(1 session,');
  });
});
