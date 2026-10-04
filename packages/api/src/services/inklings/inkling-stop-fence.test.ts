/**
 * The stop fence releases an entry on one observation only, that entry's own
 * group probing ESRCH, and holds on anything else. The probe is scripted here
 * per group; inkling-stop-fence.processes.test.ts measures it against real
 * processes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({
  groups: new Map<number, 'empty' | 'alive' | 'unknown'>(),
  probed: [] as number[],
}));

vi.mock('../sessions/stop-process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sessions/stop-process')>();
  return {
    isGroupId: actual.isGroupId,
    probeGroup: vi.fn((pgid: number) => {
      observed.probed.push(pgid);
      return observed.groups.get(pgid) ?? 'alive';
    }),
  };
});

import { clearInklingFences, fenceInkling, inklingFenceHolds } from './inkling-stop-fence';

const SB = 'sb-fenced';

afterEach(() => {
  clearInklingFences();
  observed.groups.clear();
  observed.probed = [];
});

describe('the inkling stop fence', () => {
  it('holds nothing for an inkling that was never fenced', () => {
    expect(inklingFenceHolds(SB)).toBe(false);
  });

  it('releases when the group probes empty (ESRCH), and stays released', () => {
    fenceInkling(SB, { leaderExited: true, pgid: 4242, group: 'alive' });
    observed.groups.set(4242, 'empty');
    expect(inklingFenceHolds(SB)).toBe(false);
    observed.groups.set(4242, 'alive');
    expect(inklingFenceHolds(SB)).toBe(false);
  });

  it('holds while the group probes alive', () => {
    fenceInkling(SB, { leaderExited: true, pgid: 4242, group: 'alive' });
    expect(inklingFenceHolds(SB)).toBe(true);
    expect(inklingFenceHolds(SB)).toBe(true);
  });

  it('holds when the group cannot be observed (EPERM or any other error)', () => {
    fenceInkling(SB, { leaderExited: true, pgid: 4242, group: 'unknown' });
    observed.groups.set(4242, 'unknown');
    expect(inklingFenceHolds(SB)).toBe(true);
  });

  it('two unconfirmed stops for one inkling: each is released only by its own group, and the inkling stays fenced while either remains', () => {
    fenceInkling(SB, { leaderExited: true, pgid: 4242, group: 'alive' });
    fenceInkling(SB, { leaderExited: true, pgid: 4343, group: 'alive' });
    // The older stop's group is gone: that entry alone is released.
    observed.groups.set(4242, 'empty');
    expect(inklingFenceHolds(SB)).toBe(true);
    // The newer one's group goes later; only then is the inkling free.
    observed.groups.set(4343, 'empty');
    expect(inklingFenceHolds(SB)).toBe(false);
  });

  it('the newer stop releasing first leaves the older one holding: a later stop never replaces an earlier one', () => {
    fenceInkling(SB, { leaderExited: true, pgid: 4242, group: 'alive' });
    fenceInkling(SB, { leaderExited: true, pgid: 4343, group: 'alive' });
    observed.groups.set(4343, 'empty');
    expect(inklingFenceHolds(SB)).toBe(true);
    observed.groups.set(4242, 'empty');
    expect(inklingFenceHolds(SB)).toBe(false);
  });

  it('an entry with no valid group id is never probed and never released on its own', () => {
    for (const pgid of [undefined, 0, 1, -7]) {
      fenceInkling(SB, { leaderExited: false, ...(pgid === undefined ? {} : { pgid }) });
    }
    expect(inklingFenceHolds(SB)).toBe(true);
    expect(observed.probed).toEqual([]);
  });

  it('is per inkling', () => {
    fenceInkling(SB, { leaderExited: true, pgid: 4242, group: 'alive' });
    expect(inklingFenceHolds('sb-other')).toBe(false);
    expect(inklingFenceHolds(SB)).toBe(true);
  });
});
