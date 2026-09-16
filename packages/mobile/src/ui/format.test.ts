import { describe, it, expect } from 'vitest';
import { durationLabel, relativeTime, senderName, shortPhase, toolCallLabel } from './format';

const NOW = Date.parse('2026-08-31T20:00:00Z');

describe('relativeTime', () => {
  it('collapses under a minute to "now"', () => {
    expect(relativeTime('2026-08-31T19:59:30Z', NOW)).toBe('now');
  });

  it('uses m/h/d as age grows', () => {
    expect(relativeTime('2026-08-31T19:45:00Z', NOW)).toBe('15m');
    expect(relativeTime('2026-08-31T14:00:00Z', NOW)).toBe('6h');
    expect(relativeTime('2026-08-29T20:00:00Z', NOW)).toBe('2d');
  });

  it('returns empty for garbage instead of NaN artifacts', () => {
    expect(relativeTime('not-a-date', NOW)).toBe('');
  });
});

describe('senderName', () => {
  it('recognizes a human reply by metadata, not by the sender slot', () => {
    // The server stores human replies with sender 'unknown' — the metadata
    // flag is the ONLY distinguishing fact. If this stops passing, every
    // reply the user sends renders as "unknown" in their own thread.
    expect(senderName('unknown', { sentBy: 'user' })).toEqual({ name: 'You', isUser: true });
  });

  it('leaves agent senders alone', () => {
    expect(senderName('wren', null)).toEqual({ name: 'wren', isUser: false });
    expect(senderName('unknown', {})).toEqual({ name: 'unknown', isUser: false });
  });
});

describe('shortPhase', () => {
  it('drops the namespace prefix', () => {
    expect(shortPhase('runtime:idle')).toBe('idle');
    expect(shortPhase('active:implementing')).toBe('implementing');
    expect(shortPhase('investigating')).toBe('investigating');
    expect(shortPhase(null)).toBeNull();
  });
});

describe('toolCallLabel', () => {
  it('prefers the argument a reader wants and clips long values', () => {
    expect(toolCallLabel('Read', { file_path: '/repo/a.ts', limit: 10 })).toBe('Read /repo/a.ts');
    expect(toolCallLabel('Bash', { command: 'yarn   test\n--run', description: 'x' })).toBe(
      'Bash yarn test --run'
    );
    expect(toolCallLabel('Grep', { pattern: 'a'.repeat(100) })).toMatch(/^Grep a{79}…$/);
  });

  it('falls back to any string argument, then to the bare name', () => {
    expect(toolCallLabel('Custom', { count: 3, label: 'hello' })).toBe('Custom hello');
    expect(toolCallLabel('Custom', { count: 3 })).toBe('Custom');
    expect(toolCallLabel('Custom', null)).toBe('Custom');
  });
});

describe('durationLabel', () => {
  it('formats with the two most significant units', () => {
    expect(durationLabel('2026-01-01T00:00:00Z', '2026-01-01T00:00:42Z')).toBe('42s');
    expect(durationLabel('2026-01-01T00:00:00Z', '2026-01-01T00:03:20Z')).toBe('3m 20s');
    expect(durationLabel('2026-01-01T00:00:00Z', '2026-01-01T02:05:00Z')).toBe('2h 5m');
    expect(durationLabel('2026-01-01T00:00:00Z', null)).toBe('—');
  });
});
