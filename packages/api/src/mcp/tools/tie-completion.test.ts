import { describe, expect, it } from 'vitest';
import { readTieRemainder } from './tie-completion.js';

/**
 * A tie group of `size` rows past `afterId`, served the way PostgREST serves
 * a select: in id order, and silently capped at `maxRows`.
 */
function tieGroup(size: number, maxRows: number) {
  const rows = Array.from({ length: size }, (_, i) => ({ id: `id-${String(i).padStart(5, '0')}` }));
  const reads: Array<{ afterId: string; withCount: boolean }> = [];
  const read = async (afterId: string, withCount: boolean) => {
    reads.push({ afterId, withCount });
    const past = rows.filter((r) => r.id > afterId);
    return {
      data: past.slice(0, maxRows),
      error: null,
      count: withCount ? past.length : null,
    };
  };
  return { rows, reads, read };
}

describe('readTieRemainder', () => {
  it('reads a group past max_rows whole, paging on the last id read', async () => {
    const group = tieGroup(2500, 1000);
    const rest = await readTieRemainder(group.read, 'id-');
    expect(rest.map((r) => r.id)).toEqual(group.rows.map((r) => r.id));
    expect(group.reads).toEqual([
      { afterId: 'id-', withCount: true },
      { afterId: 'id-00999', withCount: false },
      { afterId: 'id-01999', withCount: false },
    ]);
  });

  it('(control) one capped select would have stopped at max_rows', async () => {
    const group = tieGroup(2500, 1000);
    const { data } = await group.read('id-', true);
    expect(data).toHaveLength(1000);
  });

  it('returns nothing, after one read, when the page already held the whole group', async () => {
    const group = tieGroup(0, 1000);
    expect(await readTieRemainder(group.read, 'id-')).toEqual([]);
    expect(group.reads).toHaveLength(1);
  });

  it('fails rather than return part of a group', async () => {
    // Counted 5, but the rows stop coming after 2.
    const short = async (afterId: string, withCount: boolean) => ({
      data: afterId === 'a' ? [{ id: 'b' }, { id: 'c' }] : [],
      error: null,
      count: withCount ? 5 : null,
    });
    await expect(readTieRemainder(short, 'a')).rejects.toThrow('read 2 of 5 rows');

    const failing = async () => ({ data: null, error: { message: 'boom' }, count: null });
    await expect(readTieRemainder(failing, 'a')).rejects.toThrow('boom');

    const uncounted = async () => ({ data: [], error: null, count: null });
    await expect(readTieRemainder(uncounted, 'a')).rejects.toThrow('could not be counted');
  });
});
