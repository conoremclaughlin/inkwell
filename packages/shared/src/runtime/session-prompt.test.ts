import { describe, expect, it } from 'vitest';
import { ContextLedger } from './context-ledger.js';
import {
  buildSessionPrompt,
  buildMidTurnReseedBody,
  formatBootstrapContext,
  type SessionPromptState,
} from './session-prompt.js';

describe('shared session prompt composition', () => {
  const state: SessionPromptState = {
    backend: 'claude',
    toolMode: 'backend',
    toolRouting: 'local',
    strictTools: true,
    activeSkills: [{ name: 'review', source: 'workspace', content: 'Read the diff first.' }],
    maxContextTokens: 20_000,
    bootstrapContext: 'Echo identity',
    threadKey: 'task:echo-proof',
  };

  it('excludes only the named chronological replay entries without changing the ledger', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('user', 'prior owner correction', 'steering', 1);
    ledger.addEntry('user', 'current owner correction', 'steering', 2);
    ledger.addEntry('system', 'ordinary context', 'bootstrap', 3);
    const text = buildSessionPrompt(
      'echo',
      state,
      ledger,
      'body',
      'tools',
      undefined,
      new Set([2])
    );
    expect(text).toContain('prior owner correction');
    expect(text).toContain('ordinary context');
    expect(text).not.toContain('current owner correction');
    expect(ledger.listEntries()).toHaveLength(3);
  });

  it('preserves user attribution and the complete latest boundary when older dialogue is elided', () => {
    const text = buildMidTurnReseedBody(
      [
        { role: 'user', text: 'earlier owner correction' },
        { role: 'assistant', text: 'discardable'.repeat(4_000) },
        { role: 'runtime', text: 'latest results'.repeat(4_000) },
        { role: 'user', text: 'new owner correction' },
      ],
      { protectedTail: 2, stateless: true }
    );
    expect(text).toContain('USER:\nearlier owner correction');
    expect(text).toContain('latest results'.repeat(4_000));
    expect(text).toContain('USER:\nnew owner correction');
    expect(text).not.toContain('discardable');
    expect(text).toContain('earlier turn dialogue elided: 1 entry');
    expect(text.indexOf('earlier owner correction')).toBeLessThan(text.indexOf('latest results'));
    expect(text.indexOf('latest results')).toBeLessThan(text.indexOf('new owner correction'));
  });

  it('retains identity, skills, history, tool instructions and the fresh stamp in order', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('user', 'earlier message', 'repl');
    const text = buildSessionPrompt(
      'echo',
      state,
      ledger,
      'latest message',
      'host tool catalog',
      'fresh occupancy'
    );
    const fields = [
      'You are echo.',
      'host tool catalog',
      'Echo identity',
      'earlier message',
      'Read the diff first.',
      'fresh occupancy',
      'latest message',
    ];
    let previous = -1;
    for (const field of fields) {
      const at = text.indexOf(field);
      expect(at).toBeGreaterThan(previous);
      previous = at;
    }
    expect(text).toContain('Thread key: task:echo-proof.');
  });

  it('does not assert a placeholder identity over a caller-supplied system prompt', () => {
    const text = buildSessionPrompt(
      'nascent',
      { ...state, systemPromptOverride: 'Not named yet' },
      new ContextLedger(),
      'hello',
      'tools'
    );
    expect(text).not.toContain('You are nascent.');
  });

  it('uses bootstrap constitution, focus, projects, memories and eligible skills unchanged', () => {
    const text = formatBootstrapContext({
      identityFiles: {
        values: ' Values ',
        user: ' User ',
        soul: ' Soul ',
        self: ' Identity ',
        process: ' Process ',
      },
      activeContext: {
        focus: { summary: 'Runtime' },
        projects: [{ name: 'Ink', status: 'active', description: 'Shared loop' }],
      },
      knowledgeSummary: 'Prior context',
      skills: [
        { eligible: true, displayName: 'Review', description: 'Read code' },
        { eligible: false, displayName: 'Unavailable' },
      ],
    });
    expect(text).toContain('--- IDENTITY.md ---\nIdentity');
    expect(text).toContain('--- Current Focus ---\nRuntime');
    expect(text).toContain('- Ink (active): Shared loop');
    expect(text).toContain('--- Recent Memories ---\nPrior context');
    expect(text).toContain('- Review: Read code');
    expect(text).not.toContain('Unavailable');
    expect(formatBootstrapContext({})).toBe('');
  });
});
