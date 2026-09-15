import { describe, it, expect } from 'vitest';
import { artifactNamespace, groupByNamespace } from './namespace';

describe('artifactNamespace', () => {
  it('extracts the first path segment of an ink:// URI', () => {
    expect(artifactNamespace('ink://specs/library')).toBe('specs');
    expect(artifactNamespace('ink://ideas/future-vision')).toBe('ideas');
    expect(artifactNamespace('ink://docs/ephemeral-studio-equivalence')).toBe('docs');
  });

  it('handles deeper paths — the folder is only the first segment', () => {
    expect(artifactNamespace('ink://specs/studio/materialization')).toBe('specs');
  });

  it('buckets unparsable URIs into unfiled instead of dropping them', () => {
    expect(artifactNamespace('not-a-uri')).toBe('unfiled');
    expect(artifactNamespace('ink://no-trailing-path')).toBe('unfiled');
    expect(artifactNamespace('')).toBe('unfiled');
    expect(artifactNamespace('http://specs/foo')).toBe('unfiled');
  });
});

describe('groupByNamespace', () => {
  const a = (uri: string) => ({ uri });

  it('groups into shelves sorted by size then name, preserving item order within a shelf', () => {
    const shelves = groupByNamespace([
      a('ink://ideas/one'),
      a('ink://specs/first'),
      a('ink://specs/second'),
      a('ink://notes/only'),
      a('ink://ideas/two'),
      a('ink://specs/third'),
    ]);
    expect(shelves.map((s) => s.namespace)).toEqual(['specs', 'ideas', 'notes']);
    expect(shelves[0].items.map((i) => i.uri)).toEqual([
      'ink://specs/first',
      'ink://specs/second',
      'ink://specs/third',
    ]);
  });

  it('breaks size ties alphabetically', () => {
    const shelves = groupByNamespace([a('ink://notes/x'), a('ink://docs/y'), a('ink://ideas/z')]);
    expect(shelves.map((s) => s.namespace)).toEqual(['docs', 'ideas', 'notes']);
  });

  it('collects malformed URIs on an unfiled shelf', () => {
    const shelves = groupByNamespace([a('garbage'), a('ink://specs/ok')]);
    expect(shelves.find((s) => s.namespace === 'unfiled')?.items).toHaveLength(1);
  });

  it('returns an empty list for no artifacts', () => {
    expect(groupByNamespace([])).toEqual([]);
  });
});
