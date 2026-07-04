import { describe, it, expect } from 'vitest';
import { groupTimelineEntries } from './group-timeline-entries';

interface Entry {
  id: string;
  parentId?: string | null;
}

const rawId = (id: string) => (id.startsWith('activity:') ? id.slice('activity:'.length) : id);

const entry = (id: string, parentId?: string | null): Entry => ({
  id: `activity:${id}`,
  parentId,
});

describe('groupTimelineEntries', () => {
  it('keeps entries without parents at top level, in order', () => {
    const entries = [entry('c'), entry('b'), entry('a')];
    const { topLevel, childrenByAnchor } = groupTimelineEntries(entries, rawId);
    expect(topLevel.map((e) => e.id)).toEqual(['activity:c', 'activity:b', 'activity:a']);
    expect(childrenByAnchor.size).toBe(0);
  });

  it('nests direct children under their visible parent', () => {
    const entries = [entry('child', 'parent'), entry('parent'), entry('other')];
    const { topLevel, childrenByAnchor } = groupTimelineEntries(entries, rawId);
    expect(topLevel.map((e) => e.id)).toEqual(['activity:parent', 'activity:other']);
    expect(childrenByAnchor.get('parent')?.map((e) => e.id)).toEqual(['activity:child']);
  });

  it('flattens grandchildren under the top-level ancestor instead of dropping them', () => {
    const entries = [entry('grandchild', 'child'), entry('child', 'parent'), entry('parent')];
    const { topLevel, childrenByAnchor } = groupTimelineEntries(entries, rawId);
    expect(topLevel.map((e) => e.id)).toEqual(['activity:parent']);
    expect(childrenByAnchor.get('parent')?.map((e) => e.id)).toEqual([
      'activity:grandchild',
      'activity:child',
    ]);
    // Nothing anchored to the mid-level child — single level of nesting.
    expect(childrenByAnchor.has('child')).toBe(false);
  });

  it('keeps entries with an unmatched parentId visible at top level', () => {
    const entries = [entry('orphan', 'not-visible'), entry('parent')];
    const { topLevel, childrenByAnchor } = groupTimelineEntries(entries, rawId);
    expect(topLevel.map((e) => e.id)).toEqual(['activity:orphan', 'activity:parent']);
    expect(childrenByAnchor.size).toBe(0);
  });

  it('anchors a child of an orphan under the orphan itself', () => {
    // orphan's parent is invisible → orphan is top-level → its child nests under it
    const entries = [entry('leaf', 'orphan'), entry('orphan', 'not-visible')];
    const { topLevel, childrenByAnchor } = groupTimelineEntries(entries, rawId);
    expect(topLevel.map((e) => e.id)).toEqual(['activity:orphan']);
    expect(childrenByAnchor.get('orphan')?.map((e) => e.id)).toEqual(['activity:leaf']);
  });

  it('never drops entries — every entry is top-level or in exactly one group', () => {
    const entries = [
      entry('a'),
      entry('b', 'a'),
      entry('c', 'b'),
      entry('d', 'c'),
      entry('e', 'ghost'),
      entry('f'),
    ];
    const { topLevel, childrenByAnchor } = groupTimelineEntries(entries, rawId);
    const rendered = [
      ...topLevel.map((e) => e.id),
      ...[...childrenByAnchor.values()].flat().map((e) => e.id),
    ];
    expect(rendered.sort()).toEqual(entries.map((e) => e.id).sort());
    expect(childrenByAnchor.get('a')?.map((e) => rawId(e.id))).toEqual(['b', 'c', 'd']);
  });

  it('is safe on parentId cycles and self-references', () => {
    const entries = [entry('x', 'y'), entry('y', 'x'), entry('z', 'z')];
    const { topLevel, childrenByAnchor } = groupTimelineEntries(entries, rawId);
    const rendered = [
      ...topLevel.map((e) => e.id),
      ...[...childrenByAnchor.values()].flat().map((e) => e.id),
    ];
    expect(rendered.sort()).toEqual(['activity:x', 'activity:y', 'activity:z']);
  });
});
