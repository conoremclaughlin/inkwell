import { describe, it, expect } from 'vitest';
import { relativeTime, senderName, shortPhase } from './format';

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
