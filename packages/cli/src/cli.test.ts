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

  it('does not match non-codex backends', () => {
    expect(isBackendInteractiveSubcommand('claude', ['resume', 'abc123'])).toBe(false);
    expect(isBackendInteractiveSubcommand('gemini', ['resume', 'abc123'])).toBe(false);
  });

  it('does not match prompt text starting with resume on default backend', () => {
    expect(isBackendInteractiveSubcommand('claude', ['resume', 'this', 'bug'])).toBe(false);
  });

  it('does not match empty prompt parts', () => {
    expect(isBackendInteractiveSubcommand('codex', [])).toBe(false);
  });
});

describe('extractArgs', () => {
  it('parses prompt parts as positional args', () => {
    const result = extractArgs(['resume', 'this', 'bug']);
    expect(result.promptParts).toEqual(['resume', 'this', 'bug']);
    expect(result.prompt).toBe('resume this bug');
  });

  it('separates sb flags from prompt', () => {
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
});
