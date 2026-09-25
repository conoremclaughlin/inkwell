import { describe, expect, it } from 'vitest';
import { hasUnread, isUnread } from './unread.js';

const T0 = '2026-09-23T10:00:00.000Z';
const T2 = '2026-09-23T12:00:00.000Z';

describe('hasUnread', () => {
  it('counts another person’s message, and never a system event', () => {
    expect(hasUnread({ createdAt: T2, isOwn: false, senderKind: 'user' }, T0)).toBe(true);
    expect(hasUnread({ createdAt: T2, isOwn: false, senderKind: 'system' }, T0)).toBe(false);
  });

  it('never counts the viewer’s own message, or a thread with no messages', () => {
    expect(hasUnread({ createdAt: T2, isOwn: true, senderKind: 'sb' }, T0)).toBe(false);
    expect(hasUnread(null, T0)).toBe(false);
    expect(hasUnread(undefined, T0)).toBe(false);
  });
});

describe('isUnread', () => {
  const at = (createdAt: string, author: { isOwn: boolean; kind: string }) => ({
    createdAt,
    author,
  });

  it('is a message after the cursor from someone else', () => {
    expect(isUnread(at(T2, { isOwn: false, kind: 'sb' }), T0)).toBe(true);
    expect(isUnread(at(T2, { isOwn: false, kind: 'user' }), T0)).toBe(true);
  });

  it('is never the viewer’s own message, a system event, or one at the cursor', () => {
    expect(isUnread(at(T2, { isOwn: true, kind: 'user' }), T0)).toBe(false);
    expect(isUnread(at(T2, { isOwn: false, kind: 'system' }), T0)).toBe(false);
    expect(isUnread(at(T0, { isOwn: false, kind: 'sb' }), T0)).toBe(false);
  });

  it('compares at the precision the server wrote', () => {
    // 0.8ms apart: equal to Date.parse, ordered here.
    expect(
      isUnread(
        at('2026-09-22T00:00:00.123900+00:00', { isOwn: false, kind: 'sb' }),
        '2026-09-22T00:00:00.123100+00:00'
      )
    ).toBe(true);
  });
});
