import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { GeminiAdapter } from './gemini.js';

describe('backend adapters session resume wiring', () => {
  it('passes claude backendSessionId through --resume', () => {
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      agentId: 'wren',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
      backendSessionId: 'claude-session-789',
    });

    expect(prepared.args).toContain('--resume');
    expect(prepared.args).toContain('claude-session-789');
  });

  it('does not force claude --session-id from pcp session id', () => {
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      agentId: 'wren',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
      pcpSessionId: 'pcp-session-123',
    });

    expect(prepared.args).not.toContain('--session-id');
    expect(prepared.args).not.toContain('pcp-session-123');
  });

  it('passes claude backendSessionSeedId through --session-id', () => {
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      agentId: 'wren',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
      pcpSessionId: 'pcp-session-123',
      backendSessionSeedId: 'pcp-session-123',
    });

    const sessionIdFlagIndex = prepared.args.indexOf('--session-id');
    expect(sessionIdFlagIndex).toBeGreaterThanOrEqual(0);
    expect(prepared.args[sessionIdFlagIndex + 1]).toBe('pcp-session-123');
  });

  it('passes backendSessionId through codex resume subcommand', () => {
    const adapter = new CodexAdapter();
    const prepared = adapter.prepare({
      agentId: 'lumen',
      model: undefined,
      promptParts: ['continue', 'work'],
      passthroughArgs: [],
      backendSessionId: 'codex-session-123',
    });

    try {
      expect(prepared.args).toContain('resume');
      expect(prepared.args).toContain('codex-session-123');
    } finally {
      prepared.cleanup();
    }
  });

  it('passes backendSessionId through gemini --resume flag', () => {
    const adapter = new GeminiAdapter();
    const prepared = adapter.prepare({
      agentId: 'aster',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
      backendSessionId: 'gemini-session-456',
    });

    try {
      const resumeFlagIndex = prepared.args.indexOf('--resume');
      expect(resumeFlagIndex).toBeGreaterThanOrEqual(0);
      expect(prepared.args[resumeFlagIndex + 1]).toBe('gemini-session-456');
    } finally {
      prepared.cleanup();
    }
  });
});
