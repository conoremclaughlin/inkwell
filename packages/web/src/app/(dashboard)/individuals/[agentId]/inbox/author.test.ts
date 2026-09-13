import { describe, it, expect } from 'vitest';
import { authorLabel, sameAuthor, senderKey } from './author';

// Alex, then Morgan, then the viewer: three people who all read 'user' by slug.
const alex = {
  senderKind: 'user',
  senderAgentId: 'user',
  senderUserId: 'u-alex',
  senderName: 'Alex',
  isOwn: false,
};
const morgan = {
  senderKind: 'user',
  senderAgentId: 'user',
  senderUserId: 'u-morgan',
  senderName: 'Morgan',
  isOwn: false,
};
const me = {
  senderKind: 'user',
  senderAgentId: 'user',
  senderUserId: 'u-me',
  senderName: 'Me',
  isOwn: true,
};
const wren = {
  senderKind: 'sb',
  senderAgentId: 'wren',
  senderSbId: 'sb-wren',
  senderName: 'wren',
  isOwn: false,
};

describe('inbox authors (Lumen, #622)', () => {
  it('three consecutive people are three authors, not one compacted run', () => {
    const run = [alex, alex, morgan, me, me];
    const compact = run.map((m, i) => sameAuthor(i > 0 ? run[i - 1] : null, m));
    expect(compact).toEqual([false, true, false, false, true]);
  });

  it('identity is the principal: user id, then SB identity, then the legacy slug', () => {
    expect(senderKey(alex)).toBe('user:u-alex');
    expect(senderKey(wren)).toBe('sb:sb-wren');
    expect(senderKey({ senderAgentId: 'legacy' })).toBe('slug:legacy');
    expect(sameAuthor(wren, { ...wren, senderName: 'renamed' })).toBe(true);
  });

  it("labels the viewer as You and everyone else by the server's name, never the kind", () => {
    expect([alex, morgan, me, wren].map(authorLabel)).toEqual(['Alex', 'Morgan', 'You', 'wren']);
    expect(authorLabel({ senderAgentId: 'user', senderName: undefined })).toBe('user');
  });
});
