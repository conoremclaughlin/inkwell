import { describe, expect, it } from 'vitest';
import { parseThreadKey } from './parser';

// Canonical slugs map to themselves; aliases map to the canonical slug they
// pin — 'pcp' → 'inkwell' is the live production alias (migration
// 20260820183006).
const LOOKUP = new Map([
  ['inkwell', 'inkwell'],
  ['pcp', 'inkwell'],
  ['inkread', 'inkread'],
  ['inktrade', 'inktrade'],
]);

describe('parseThreadKey', () => {
  it('parses an unprefixed key as (null, type, id)', () => {
    expect(parseThreadKey('pr:999', LOOKUP)).toEqual({
      project: null,
      type: 'pr',
      id: '999',
      raw: 'pr:999',
    });
  });

  it('recognizes a registered project prefix', () => {
    expect(parseThreadKey('inkread:pr:42', LOOKUP)).toEqual({
      project: 'inkread',
      type: 'pr',
      id: '42',
      raw: 'inkread:pr:42',
    });
  });

  it('resolves an alias prefix to the CANONICAL slug', () => {
    expect(parseThreadKey('pcp:issue:tool-schema-discovery', LOOKUP)).toEqual({
      project: 'inkwell',
      type: 'issue',
      id: 'tool-schema-discovery',
      raw: 'pcp:issue:tool-schema-discovery',
    });
  });

  it('does NOT treat an unregistered first segment as a project', () => {
    // 'openclaw' is not a registered slug here, so it is the TYPE — parse is
    // registry-driven, never positional (grammar rule 3).
    expect(parseThreadKey('openclaw:issue:15', LOOKUP)).toEqual({
      project: null,
      type: 'openclaw',
      id: 'issue:15',
      raw: 'openclaw:issue:15',
    });
  });

  it('a registered slug with only two segments is a TYPE, not a project', () => {
    // Rule 1 requires at least two segments AFTER the project. 'inkread:foo'
    // has one, so 'inkread' is the type.
    expect(parseThreadKey('inkread:foo', LOOKUP)).toEqual({
      project: null,
      type: 'inkread',
      id: 'foo',
      raw: 'inkread:foo',
    });
  });

  it('an ALIAS with only two segments is likewise a TYPE, not a project', () => {
    expect(parseThreadKey('pcp:foo', LOOKUP)).toEqual({
      project: null,
      type: 'pcp',
      id: 'foo',
      raw: 'pcp:foo',
    });
  });

  it('keeps colons in the id', () => {
    expect(parseThreadKey('thread:review-queue:aug', LOOKUP)?.id).toBe('review-queue:aug');
    expect(parseThreadKey('pcp:debug:inbox:latency', LOOKUP)).toEqual({
      project: 'inkwell',
      type: 'debug',
      id: 'inbox:latency',
      raw: 'pcp:debug:inbox:latency',
    });
  });

  it('unregistered types parse fine — they are legal, just untyped behavior', () => {
    expect(parseThreadKey('standup:2026-08-18', LOOKUP)).toEqual({
      project: null,
      type: 'standup',
      id: '2026-08-18',
      raw: 'standup:2026-08-18',
    });
  });

  it('rejects non-keys', () => {
    expect(parseThreadKey('', LOOKUP)).toBeNull();
    expect(parseThreadKey('justastring', LOOKUP)).toBeNull();
    expect(parseThreadKey(':42', LOOKUP)).toBeNull();
    expect(parseThreadKey('pr:', LOOKUP)).toBeNull();
    expect(parseThreadKey('pcp:pr:', LOOKUP)).toBeNull();
  });

  it('never rewrites the key — raw is verbatim (invariant 1)', () => {
    const raw = 'inktrade:spec:valuation';
    expect(parseThreadKey(raw, LOOKUP)?.raw).toBe(raw);
    // Alias keys too: raw keeps the alias spelling even though project is
    // canonical.
    const aliased = parseThreadKey('pcp:pr:42', LOOKUP);
    expect(aliased?.raw).toBe('pcp:pr:42');
    expect(aliased?.project).toBe('inkwell');
  });

  it('works with an empty lookup — everything is unprefixed', () => {
    expect(parseThreadKey('inkread:pr:42', new Map())).toEqual({
      project: null,
      type: 'inkread',
      id: 'pr:42',
      raw: 'inkread:pr:42',
    });
  });
});
