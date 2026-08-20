import { describe, expect, it } from 'vitest';
import { parseThreadKey } from './parser';

const SLUGS = new Set(['pcp', 'inkread', 'inktrade']);

describe('parseThreadKey', () => {
  it('parses an unprefixed key as (null, type, id)', () => {
    expect(parseThreadKey('pr:999', SLUGS)).toEqual({
      project: null,
      type: 'pr',
      id: '999',
      raw: 'pr:999',
    });
  });

  it('recognizes a registered project prefix', () => {
    expect(parseThreadKey('inkread:pr:42', SLUGS)).toEqual({
      project: 'inkread',
      type: 'pr',
      id: '42',
      raw: 'inkread:pr:42',
    });
  });

  it('does NOT treat an unregistered first segment as a project', () => {
    // 'openclaw' is not a registered slug here, so it is the TYPE — parse is
    // registry-driven, never positional (grammar rule 3).
    expect(parseThreadKey('openclaw:issue:15', SLUGS)).toEqual({
      project: null,
      type: 'openclaw',
      id: 'issue:15',
      raw: 'openclaw:issue:15',
    });
  });

  it('a registered slug with only two segments is a TYPE, not a project', () => {
    // Rule 1 requires at least two segments AFTER the project. 'inkread:foo'
    // has one, so 'inkread' is the type.
    expect(parseThreadKey('inkread:foo', SLUGS)).toEqual({
      project: null,
      type: 'inkread',
      id: 'foo',
      raw: 'inkread:foo',
    });
  });

  it('keeps colons in the id', () => {
    expect(parseThreadKey('thread:review-queue:aug', SLUGS)?.id).toBe('review-queue:aug');
    expect(parseThreadKey('pcp:debug:inbox:latency', SLUGS)).toEqual({
      project: 'pcp',
      type: 'debug',
      id: 'inbox:latency',
      raw: 'pcp:debug:inbox:latency',
    });
  });

  it('unregistered types parse fine — they are legal, just untyped behavior', () => {
    expect(parseThreadKey('standup:2026-08-18', SLUGS)).toEqual({
      project: null,
      type: 'standup',
      id: '2026-08-18',
      raw: 'standup:2026-08-18',
    });
  });

  it('rejects non-keys', () => {
    expect(parseThreadKey('', SLUGS)).toBeNull();
    expect(parseThreadKey('justastring', SLUGS)).toBeNull();
    expect(parseThreadKey(':42', SLUGS)).toBeNull();
    expect(parseThreadKey('pr:', SLUGS)).toBeNull();
    expect(parseThreadKey('pcp:pr:', SLUGS)).toBeNull();
  });

  it('never rewrites the key — raw is verbatim (invariant 1)', () => {
    const raw = 'inktrade:spec:valuation';
    expect(parseThreadKey(raw, SLUGS)?.raw).toBe(raw);
  });

  it('works with an empty slug set — everything is unprefixed', () => {
    expect(parseThreadKey('inkread:pr:42', new Set())).toEqual({
      project: null,
      type: 'inkread',
      id: 'pr:42',
      raw: 'inkread:pr:42',
    });
  });
});
