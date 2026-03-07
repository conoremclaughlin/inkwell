import { describe, expect, it } from 'vitest';
import {
  buildInteractiveSubcommandArgs,
  extractArgs,
  isBackendInteractiveSubcommand,
} from './cli.js';

describe('isBackendInteractiveSubcommand', () => {
  it('matches codex resume with session id', () => {
    expect(
      isBackendInteractiveSubcommand('codex', ['resume', '019c44fd-68f6-7332-9eda-2dc7c8afcedf'])
    ).toBe(true);
  });

  it('matches codex resume without session id (list mode)', () => {
    expect(isBackendInteractiveSubcommand('codex', ['resume'])).toBe(true);
  });

  it('does not match codex resume when it is not the first positional token', () => {
    expect(isBackendInteractiveSubcommand('codex', ['mcp', 'resume'])).toBe(false);
  });

  it('does not match non-codex backends', () => {
    expect(isBackendInteractiveSubcommand('claude', ['resume', 'abc123'])).toBe(false);
    expect(isBackendInteractiveSubcommand('gemini', ['resume', 'abc123'])).toBe(false);
  });

  it('does not match empty prompt parts', () => {
    expect(isBackendInteractiveSubcommand('codex', [])).toBe(false);
  });
});

describe('buildInteractiveSubcommandArgs', () => {
  it('keeps positional subcommand tokens before passthrough flags', () => {
    expect(buildInteractiveSubcommandArgs(['--full-auto'], ['resume', '019c91d2'])).toEqual([
      'resume',
      '019c91d2',
      '--full-auto',
    ]);
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

  it('parses JSON session candidate flag', () => {
    const result = extractArgs(['--session-candidates-json']);
    expect(result.sbOptions.sessionCandidatesJson).toBe(true);
  });

  it('parses sb-specific verbose flag', () => {
    const result = extractArgs(['--sb-verbose', 'hello']);
    expect(result.sbOptions.verbose).toBe(true);
    expect(result.promptParts).toEqual(['hello']);
  });

  it('parses --dangerous flag', () => {
    const result = extractArgs(['--dangerous', 'hello']);
    expect(result.sbOptions.dangerous).toBe(true);
    expect(result.promptParts).toEqual(['hello']);
  });

  it('defaults dangerous to false', () => {
    const result = extractArgs(['hello']);
    expect(result.sbOptions.dangerous).toBe(false);
  });

  it('forwards -v to backend passthrough', () => {
    const result = extractArgs(['-v', '--resume', 'abc123']);
    expect(result.sbOptions.verbose).toBe(false);
    expect(result.passthroughArgs).toEqual(['-v', '--resume', 'abc123']);
  });
});
