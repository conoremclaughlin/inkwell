import { describe, it, expect } from 'vitest';
import { senderLabel } from './sender-label';

describe('senderLabel', () => {
  it('names a person "You", the system "system", and an SB by its slug', () => {
    expect(senderLabel({ senderKind: 'user', senderAgentId: null })).toBe('You');
    expect(senderLabel({ senderKind: 'system', senderAgentId: null })).toBe('system');
    expect(senderLabel({ senderKind: 'sb', senderAgentId: 'wren' })).toBe('wren');
  });

  it('does not read the retired metadata hint — the kind is the author', () => {
    // A row whose kind says sb is an SB's, whatever a caller once put in metadata.
    expect(senderLabel({ senderKind: 'sb', senderAgentId: 'lumen' })).toBe('lumen');
    // An SB row without its display slug still shows something, never "null".
    expect(senderLabel({ senderKind: 'sb', senderAgentId: null })).toBe('system');
  });
});
