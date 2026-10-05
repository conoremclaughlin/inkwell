/**
 * The rest of a timestamp tie group, past `afterId` in id order, however many
 * rows it holds.
 *
 * Pages that end on a timestamp must end on the whole of it: every cursor
 * over these tables is a strict `created_at >`, so the unread remainder of a
 * split group is lost behind the next one. A single select is not enough to
 * complete a group: PostgREST stops at `max_rows` (1000 in
 * supabase/config.toml) without saying so. This pages on `id > last id read`
 * until it holds as many rows as the first read counted. A failed read, or
 * one that comes back empty before the count is reached, throws: an
 * incomplete group must fail the page before anything advances past it.
 */
export async function readTieRemainder(
  read: (afterId: string, withCount: boolean) => PromiseLike<TieRead>,
  afterId: string
): Promise<Record<string, unknown>[]> {
  const remainder: Record<string, unknown>[] = [];
  let expected: number | undefined;
  let cursor = afterId;
  for (;;) {
    const { data, error, count } = await read(cursor, expected === undefined);
    if (error) throw new Error(`Failed to complete a timestamp tie group: ${error.message}`);
    if (expected === undefined) {
      if (typeof count !== 'number') throw new Error('Timestamp tie group could not be counted');
      expected = count;
    }
    const rows = (data ?? []) as Record<string, unknown>[];
    remainder.push(...rows);
    if (remainder.length >= expected) return remainder;
    if (rows.length === 0) {
      throw new Error(
        `Timestamp tie group incomplete: read ${remainder.length} of ${expected} rows`
      );
    }
    cursor = String(rows[rows.length - 1].id);
  }
}

interface TieRead {
  data: unknown[] | null;
  error: { message: string } | null;
  count?: number | null;
}
