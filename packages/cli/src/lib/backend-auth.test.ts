import { describe, expect, it } from 'vitest';
import { parseClaudeAuthStatusOutput, parseCodexLoginStatusOutput } from './backend-auth.js';

describe('backend auth parsing', () => {
  it('parses claude logged in json', () => {
    const parsed = parseClaudeAuthStatusOutput(
      JSON.stringify({
        loggedIn: true,
        authMethod: 'oauthAccount',
      })
    );
    expect(parsed.authenticated).toBe(true);
    expect(parsed.detail).toContain('logged in');
  });

  it('parses claude logged out json', () => {
    const parsed = parseClaudeAuthStatusOutput(
      JSON.stringify({
        loggedIn: false,
        authMethod: 'none',
      })
    );
    expect(parsed.authenticated).toBe(false);
    expect(parsed.detail).toContain('not logged in');
  });

  it('parses codex logged in text output', () => {
    const parsed = parseCodexLoginStatusOutput('Logged in using ChatGPT');
    expect(parsed.authenticated).toBe(true);
    expect(parsed.detail).toContain('Logged in');
  });

  it('parses codex logged out text output', () => {
    const parsed = parseCodexLoginStatusOutput('Not logged in');
    expect(parsed.authenticated).toBe(false);
    expect(parsed.detail).toContain('Not logged in');
  });
});
