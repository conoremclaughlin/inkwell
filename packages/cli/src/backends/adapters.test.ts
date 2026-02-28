import { describe, expect, it } from 'vitest';
import { CodexAdapter } from './codex.js';
import { GeminiAdapter } from './gemini.js';

describe('backend adapters session resume wiring', () => {
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
