import { describe, expect, it } from 'vitest';
import { inkProviderFor } from './ink-provider';

describe('inkProviderFor', () => {
  it('names nothing when the identity names no provider: the chat keeps its own default', () => {
    for (const provider of [null, undefined, '', '  ']) {
      expect(inkProviderFor(provider), String(provider)).toEqual({ ok: true });
    }
  });

  it('names Claude for a Claude provider, in any spelling the identity stores', () => {
    for (const provider of ['claude', 'claude-code', ' Claude-Code ']) {
      expect(inkProviderFor(provider), provider).toEqual({ ok: true, provider: 'claude' });
    }
  });

  it('names Codex for a Codex provider, so a Codex SB no longer runs as Claude (task f5acf0f5)', () => {
    for (const provider of ['codex', 'codex-cli', ' Codex-CLI ']) {
      expect(inkProviderFor(provider), provider).toEqual({ ok: true, provider: 'codex' });
    }
  });

  it('refuses any other provider by name, never choosing Claude in its place', () => {
    for (const provider of ['gemini', 'antigravity', 'ink', 'openai']) {
      const decision = inkProviderFor(provider);
      expect(decision.ok, provider).toBe(false);
      expect(!decision.ok && decision.reason, provider).toContain(`"${provider}"`);
    }
  });
});
