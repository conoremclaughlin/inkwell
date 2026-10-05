import { describe, expect, it } from 'vitest';
import { inklingRuntime, type InklingRuntimeInput } from './inkling-runtime';

/** A fresh session from an identity that names nothing: the common case. */
const fresh: InklingRuntimeInput = {
  sessionBackend: 'claude-code',
  backendSessionId: null,
  identityBackend: null,
  identityProvider: null,
};

describe('inklingRuntime', () => {
  it('runs every inkling on ink under Claude Code when nothing names a provider (Conor, Oct 4 2026)', () => {
    expect(inklingRuntime(fresh)).toEqual({ ok: true, provider: 'claude' });
  });

  it('takes Claude Code however the identity spells it, and an empty provider as none', () => {
    for (const identityProvider of ['claude', 'claude-code', ' Claude-Code ', '']) {
      expect(inklingRuntime({ ...fresh, identityProvider }), identityProvider).toEqual({
        ok: true,
        provider: 'claude',
      });
    }
  });

  it('moves an inkling to ink whatever runtime its identity stored, a direct Claude one included', () => {
    for (const identityBackend of ['claude-code', 'claude', 'ink', 'direct-api', 'direct', 'api']) {
      expect(inklingRuntime({ ...fresh, identityBackend }), identityBackend).toEqual({
        ok: true,
        provider: 'claude',
      });
    }
  });

  it("refuses a runtime that is not one of an inkling's own, naming it, rather than translating it", () => {
    for (const identityBackend of ['codex-cli', 'codex', 'gemini', 'antigravity', 'something']) {
      const decision = inklingRuntime({ ...fresh, identityBackend });
      expect(decision.ok, identityBackend).toBe(false);
      expect(!decision.ok && decision.reason, identityBackend).toContain(`"${identityBackend}"`);
    }
  });

  it('refuses a Codex provider: never run as Claude, never handed a Codex model', () => {
    for (const identityProvider of ['codex', 'codex-cli', ' Codex-CLI ']) {
      expect(inklingRuntime({ ...fresh, identityProvider }), identityProvider).toEqual({
        ok: false,
        reason: "this inkling's provider is Codex, which ink does not run for inklings yet",
      });
    }
  });

  it('refuses any other provider by name', () => {
    for (const identityProvider of ['gemini', 'ink', 'openai']) {
      const decision = inklingRuntime({ ...fresh, identityProvider });
      expect(decision.ok, identityProvider).toBe(false);
      expect(!decision.ok && decision.reason, identityProvider).toContain(`"${identityProvider}"`);
    }
  });

  it('refuses a conversation that began natively on another runtime: its history would not come with it', () => {
    for (const sessionBackend of ['claude-code', 'codex-cli', 'gemini', null, '']) {
      const decision = inklingRuntime({ ...fresh, sessionBackend, backendSessionId: 'native-1' });
      expect(decision.ok, String(sessionBackend)).toBe(false);
      expect(!decision.ok && decision.reason, String(sessionBackend)).toMatch(
        /would not carry its history/
      );
    }
    // A row naming no runtime began on the schema's default, claude-code.
    const unnamed = inklingRuntime({
      ...fresh,
      sessionBackend: null,
      backendSessionId: 'native-1',
    });
    expect(!unnamed.ok && unnamed.reason).toContain('"claude-code"');
  });

  it('moves a session with no native conversation, whatever runtime it stored, and keeps an ink one', () => {
    for (const sessionBackend of ['claude-code', 'codex-cli', 'gemini', null]) {
      expect(inklingRuntime({ ...fresh, sessionBackend }), String(sessionBackend)).toEqual({
        ok: true,
        provider: 'claude',
      });
    }
    // An ink session's id is ink's own.
    for (const sessionBackend of ['ink', 'direct-api', ' INK ']) {
      expect(
        inklingRuntime({ ...fresh, sessionBackend, backendSessionId: 'session-1' }),
        sessionBackend
      ).toEqual({ ok: true, provider: 'claude' });
    }
  });
});
