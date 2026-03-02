import { describe, expect, it } from 'vitest';
import { extractArgs, isBackendInteractiveSubcommand } from './cli.js';

describe('isBackendInteractiveSubcommand', () => {
  it('matches codex resume with session id', () => {
    expect(
      isBackendInteractiveSubcommand('codex', ['resume', '019c44fd-68f6-7332-9eda-2dc7c8afcedf'])
    ).toBe(true);
  });

  it('matches codex resume without session id (list mode)', () => {
    expect(isBackendInteractiveSubcommand('codex', ['resume'])).toBe(true);
  });

  it('matches codex resume behind other positional args', () => {
    expect(
      isBackendInteractiveSubcommand('codex', [
        'mcp',
        'resume',
        '019c44fd-68f6-7332-9eda-2dc7c8afcedf',
      ])
    ).toBe(true);
  });

  it('does not match non-codex backends', () => {
    expect(isBackendInteractiveSubcommand('claude', ['resume', 'abc123'])).toBe(false);
    expect(isBackendInteractiveSubcommand('gemini', ['resume', 'abc123'])).toBe(false);
  });

  it('does not match empty prompt parts', () => {
    expect(isBackendInteractiveSubcommand('codex', [])).toBe(false);
  });
});

describe('extractArgs', () => {
  it('parses prompt parts as positional args', () => {
    const result = extractArgs(['hello', 'world']);
    expect(result.promptParts).toEqual(['hello', 'world']);
    expect(result.prompt).toBe('hello world');
  });

  it('separates sb flags from positional args', () => {
    const result = extractArgs(['-a', 'lumen', '-b', 'codex', 'resume', '019c-abc']);
    expect(result.sbOptions.agent).toBe('lumen');
    expect(result.sbOptions.backend).toBe('codex');
    expect(result.promptParts).toEqual(['resume', '019c-abc']);
  });

  it('treats unknown flags as passthrough', () => {
    const result = extractArgs(['--resume', 'abc123', 'do', 'stuff']);
    expect(result.passthroughArgs).toEqual(['--resume', 'abc123']);
    expect(result.promptParts).toEqual(['do', 'stuff']);
  });

  it('parses session candidate debug flags', () => {
    const result = extractArgs(['--session-candidates', '--session-choice', 'pcp:e03f522a']);
    expect(result.sbOptions.sessionCandidates).toBe(true);
    expect(result.sbOptions.sessionChoice).toBe('pcp:e03f522a');
  });
});
