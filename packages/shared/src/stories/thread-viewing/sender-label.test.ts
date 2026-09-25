import { describe, it, expect } from 'vitest';
import { senderLabel } from './sender-label.js';

describe('senderLabel', () => {
  // Two people on one thread, as each of them sees it: "You" is the
  // viewer's own message only, and the other person keeps their name.
  const fromA = { senderKind: 'user', senderSlug: null, senderName: 'Conor', isOwn: true };
  const fromB = { senderKind: 'user', senderSlug: null, senderName: 'second', isOwn: false };

  it('the viewer reads their own message as "You" and the other person by name', () => {
    expect(senderLabel(fromA)).toBe('You');
    expect(senderLabel(fromB)).toBe('second');
  });

  it('the same two messages read the other way round to the other person', () => {
    expect(senderLabel({ ...fromA, isOwn: false })).toBe('Conor');
    expect(senderLabel({ ...fromB, isOwn: true })).toBe('You');
  });

  it('names an SB by its slug and the system as system', () => {
    expect(
      senderLabel({ senderKind: 'sb', senderSlug: 'wren', senderName: 'wren', isOwn: false })
    ).toBe('wren');
    expect(
      senderLabel({ senderKind: 'system', senderSlug: null, senderName: 'system', isOwn: false })
    ).toBe('system');
  });

  it('a person the server could not name is still a person, never "You" to a stranger', () => {
    expect(
      senderLabel({
        senderKind: 'user',
        senderSlug: null,
        senderName: 'a workspace member',
        isOwn: false,
      })
    ).toBe('a workspace member');
    // An unnamed payload (no senderName at all) falls back to the kind.
    expect(senderLabel({ senderKind: 'user', senderSlug: null })).toBe('a workspace member');
    // An SB row without its display slug still shows something, never "null".
    expect(senderLabel({ senderKind: 'sb', senderSlug: null })).toBe('system');
  });

  it('ignores the retired metadata hint even when it is supplied', () => {
    const withHint = {
      senderKind: 'sb',
      senderSlug: 'wren',
      senderName: 'wren',
      isOwn: false,
      metadata: { sentBy: 'user' },
    };
    expect(senderLabel(withHint)).toBe('wren');
  });
});
