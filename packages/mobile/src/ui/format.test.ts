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
  // Two people on one thread, as each of them sees it: "You" is the
  // viewer's own message only, and the other person keeps their name.
  const fromA = { senderKind: 'user', senderSlug: null, senderName: 'Conor', isOwn: true };
  const fromB = { senderKind: 'user', senderSlug: null, senderName: 'second', isOwn: false };

  it('the viewer reads their own message as "You" and the other person by name', () => {
    expect(senderName(fromA)).toEqual({ name: 'You', isOwn: true });
    expect(senderName(fromB)).toEqual({ name: 'second', isOwn: false });
  });

  it('the same two messages read the other way round to the other person', () => {
    expect(senderName({ ...fromA, isOwn: false })).toEqual({ name: 'Conor', isOwn: false });
    expect(senderName({ ...fromB, isOwn: true })).toEqual({ name: 'You', isOwn: true });
  });

  it('names an SB by its slug and the system as system, neither ever own', () => {
    expect(
      senderName({ senderKind: 'sb', senderSlug: 'wren', senderName: 'wren', isOwn: false })
    ).toEqual({
      name: 'wren',
      isOwn: false,
    });
    expect(
      senderName({ senderKind: 'system', senderSlug: null, senderName: 'system', isOwn: false })
    ).toEqual({
      name: 'system',
      isOwn: false,
    });
  });

  it('a person the server could not name is still a person, never "You" to a stranger', () => {
    expect(
      senderName({
        senderKind: 'user',
        senderSlug: null,
        senderName: 'a workspace member',
        isOwn: false,
      })
    ).toEqual({
      name: 'a workspace member',
      isOwn: false,
    });
    // An unnamed payload (no senderName at all) falls back to the kind.
    expect(senderName({ senderKind: 'user', senderSlug: null })).toEqual({
      name: 'a workspace member',
      isOwn: false,
    });
  });

  it('ignores the retired metadata hint even when it is supplied', () => {
    const withHint = {
      senderKind: 'sb',
      senderSlug: 'wren',
      senderName: 'wren',
      isOwn: false,
      metadata: { sentBy: 'user' },
    };
    expect(senderName(withHint)).toEqual({ name: 'wren', isOwn: false });
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
