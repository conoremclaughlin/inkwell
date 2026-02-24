import { describe, expect, it } from 'vitest';
import { hasBackendSessionOverride } from './claude.js';

describe('hasBackendSessionOverride', () => {
  it('detects explicit Codex resume subcommand in positional prompt parts', () => {
    expect(hasBackendSessionOverride('codex', [], ['resume', '019c44fd-68f6-7332-9eda-2dc7c8afcedf'])).toBe(
      true
    );
  });

  it('detects explicit Codex resume subcommand in passthrough args', () => {
    expect(hasBackendSessionOverride('codex', ['resume', '019c44fd-68f6-7332-9eda-2dc7c8afcedf'])).toBe(
      true
    );
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
