import { describe, expect, it } from 'vitest';
import { parseSlashCommand } from './slash.js';

describe('parseSlashCommand', () => {
  it('parses slash commands with args', () => {
    const command = parseSlashCommand('/backend codex');
    expect(command).toEqual({
      name: 'backend',
      args: ['codex'],
      raw: 'backend codex',
    });
  });

  it('returns null for regular input', () => {
    expect(parseSlashCommand('hello world')).toBeNull();
  });

  it('normalizes spacing and casing', () => {
    const command = parseSlashCommand(' /BOOKMARK   recap   ');
    expect(command?.name).toBe('bookmark');
    expect(command?.args).toEqual(['recap']);
  });
});

