import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRestoreIdentity, handleSaveIdentity } from './identity-handlers';
import { createMockSupabaseClient } from '../../test/mocks/supabase.mock';

vi.mock('../../services/user-resolver', async () => {
  const { z } = await import('zod');
  return {
    userIdentifierBaseSchema: z.object({ userId: z.string().optional() }),
    resolveUserOrThrow: vi.fn().mockResolvedValue({
      user: { id: 'user-test' },
      resolvedBy: 'userId',
    }),
  };
});
vi.mock('../../services/heartbeat', () => ({
  ensureDefaultReminders: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const metadata = {
  runtimeConfig: { model: 'test-model', effort: 'high', maxTurns: 20 },
  bridge: true,
  annotation: 'before',
  unrelated: { nested: ['retained'] },
};
const row = {
  id: 'identity-test',
  user_id: 'user-test',
  agent_id: 'test-sb',
  workspace_id: null,
  name: 'Test SB',
  role: 'Test role',
  soul: 'Current soul',
  metadata,
  version: 7,
};
const args = { sbSlug: 'test-sb', name: 'Test SB', role: 'Test role' };
const conflict = { code: 'PGRST116', message: 'The result contains 0 rows' };

describe('identity metadata preservation', () => {
  let db: ReturnType<typeof createMockSupabaseClient>;
  const composer = () => ({ getClient: () => db }) as never;
  const written = (index = 0) =>
    vi.mocked(db._queryBuilder.update as ReturnType<typeof vi.fn>).mock.calls[index][0];

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockSupabaseClient();
  });

  it.each([
    ['omitted', undefined],
    ['empty', {}],
    ['unrelated key', { annotation: 'after' }],
  ])('preserves unnamed metadata keys on a save with %s metadata', async (_label, patch) => {
    db._queueReturnData(row);
    db._queueReturnData({ ...row, version: 8 });

    await handleSaveIdentity({ ...args, soul: 'Updated soul', metadata: patch }, composer());

    expect(written().metadata).toEqual({ ...metadata, ...patch });
    expect(written().soul).toBe('Updated soul');
    expect(db._queryBuilder.eq).toHaveBeenCalledWith('id', row.id);
  });

  it.each([
    { runtimeConfig: { model: 'replacement-model' }, bridge: false },
    { runtimeConfig: null, annotation: null },
  ])('replaces explicitly named top-level keys, including false and null', async (patch) => {
    db._queueReturnData(row);
    db._queueReturnData({ ...row, version: 8 });

    await handleSaveIdentity({ ...args, metadata: patch }, composer());

    // Shallow, not recursive: naming runtimeConfig intentionally replaces it.
    expect(written().metadata).toEqual({ ...metadata, ...patch });
  });

  it('treats legacy null metadata as an empty object', async () => {
    db._queueReturnData({ ...row, metadata: null });
    db._queueReturnData({ ...row, version: 8 });
    await handleSaveIdentity({ ...args, metadata: { annotation: 'new' } }, composer());
    expect(written().metadata).toEqual({ annotation: 'new' });
  });

  it('guards a legacy null version with IS NULL rather than an equality comparison', async () => {
    db._queueReturnData({ ...row, version: null });
    db._queueReturnData({ ...row, version: 1 });
    await handleSaveIdentity({ ...args, metadata: { annotation: 'after' } }, composer());
    expect(db._queryBuilder.is).toHaveBeenCalledWith('version', null);
    expect(written().metadata).toEqual({ ...metadata, annotation: 'after' });
  });

  it.each([{ value: 'legacy string' }, { value: ['legacy array'] }, { value: false }])(
    'refuses malformed stored metadata instead of dropping it',
    async ({ value }) => {
      db._queueReturnData({ ...row, metadata: value });
      await expect(handleSaveIdentity({ ...args, metadata: {} }, composer())).rejects.toThrow(
        'refusing to overwrite malformed metadata'
      );
      expect(db._queryBuilder.update).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, { annotation: 'first' }])(
    'initializes metadata on the first save',
    async (patch) => {
      db._queueReturnData(null);
      db._queueReturnData({ ...row, version: 1 });
      await handleSaveIdentity({ ...args, metadata: patch }, composer());
      expect(db._queryBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: patch ?? {} })
      );
      expect(db._queryBuilder.update).not.toHaveBeenCalled();
    }
  );

  it.each([
    null,
    {},
    { annotation: 'historical' },
    { annotation: 'historical', runtimeConfig: { model: 'old-model' }, bridge: false },
  ])(
    'restores document metadata without dropping current keys or restoring old runtime settings',
    async (historicalMetadata) => {
      db._queueReturnData(row);
      db._queueReturnData({ ...row, metadata: historicalMetadata, soul: 'Old soul', version: 1 });
      db._queueReturnData({ ...row, version: 8 });

      await handleRestoreIdentity({ sbSlug: args.sbSlug, version: 1 }, composer());

      expect(written().metadata).toEqual({
        ...metadata,
        ...(historicalMetadata && 'annotation' in historicalMetadata
          ? { annotation: historicalMetadata.annotation }
          : {}),
      });
      expect(written().soul).toBe('Old soul');
    }
  );

  it('does not resurrect historical runtime settings when none are configured now', async () => {
    db._queueReturnData({ ...row, metadata: { annotation: 'current' } });
    db._queueReturnData({ ...row, metadata, version: 1 });
    db._queueReturnData({ ...row, version: 8 });
    await handleRestoreIdentity({ sbSlug: args.sbSlug, version: 1 }, composer());
    expect(written().metadata).toEqual({ annotation: 'before', unrelated: metadata.unrelated });
  });

  it.each([undefined, { annotation: 'after' }])(
    'rebuilds a save after a concurrent metadata edit instead of overwriting it',
    async (patch) => {
      const latest = {
        ...row,
        soul: 'Concurrently edited soul',
        metadata: { ...metadata, runtimeConfig: { model: 'concurrent-model' }, concurrent: true },
        version: 8,
      };
      db._queueReturnData(row);
      db._queueReturnData(null, conflict);
      db._queueReturnData(latest);
      db._queueReturnData({ ...latest, version: 9 });

      await handleSaveIdentity({ ...args, metadata: patch }, composer());

      expect(db._queryBuilder.update).toHaveBeenCalledTimes(2);
      expect(db._queryBuilder.eq).toHaveBeenCalledWith('version', 7);
      expect(db._queryBuilder.eq).toHaveBeenCalledWith('version', 8);
      expect(written(1).metadata).toEqual({ ...latest.metadata, ...patch });
      expect(written(1).soul).toBe(latest.soul);
    }
  );

  it('uses the latest runtime settings when a restore races an operator edit', async () => {
    const latest = {
      ...row,
      metadata: { runtimeConfig: { model: 'concurrent-model' }, bridge: false },
      version: 8,
    };
    db._queueReturnData(row);
    db._queueReturnData({ ...row, metadata, version: 1 });
    db._queueReturnData(null, conflict);
    db._queueReturnData(latest);
    db._queueReturnData({ ...latest, version: 9 });

    await handleRestoreIdentity({ sbSlug: args.sbSlug, version: 1 }, composer());

    expect(db._queryBuilder.eq).toHaveBeenCalledWith('version', 7);
    expect(db._queryBuilder.eq).toHaveBeenCalledWith('version', 8);
    expect(written(1).metadata).toEqual({ ...metadata, ...latest.metadata });
  });

  it('refuses after bounded write conflicts rather than performing an unguarded update', async () => {
    db._queueReturnData(row);
    for (let i = 0; i < 3; i++) {
      db._queueReturnData(null, conflict);
      if (i < 2) db._queueReturnData({ ...row, version: row.version + i + 1 });
    }
    await expect(
      handleSaveIdentity({ ...args, metadata: { annotation: 'after' } }, composer())
    ).rejects.toThrow(/changed concurrently/);
    expect(db._queryBuilder.update).toHaveBeenCalledTimes(3);
    expect(db._queryBuilder.insert).not.toHaveBeenCalled();
  });

  it('does not retry database failures as conflicts', async () => {
    db._queueReturnData(row);
    db._queueReturnData(null, { code: '42501', message: 'permission denied' });
    await expect(handleSaveIdentity({ ...args, metadata: {} }, composer())).rejects.toThrow(
      'permission denied'
    );
    expect(db._queryBuilder.update).toHaveBeenCalledTimes(1);
  });

  it.each([
    { code: '42501', message: 'permission denied' },
    { code: 'PGRST116', message: 'row no longer in scope' },
  ])('refuses when the conflict reload fails; never reinserts a missing row', async (error) => {
    db._queueReturnData(row);
    db._queueReturnData(null, conflict);
    db._queueReturnData(null, error);
    await expect(handleSaveIdentity({ ...args, metadata: {} }, composer())).rejects.toThrow(
      'Failed to reload identity'
    );
    expect(db._queryBuilder.update).toHaveBeenCalledTimes(1);
    expect(db._queryBuilder.insert).not.toHaveBeenCalled();
  });

  it.each([undefined, { annotation: 'after' }])(
    'preserves an interleaved operator edit with predicate-enforcing storage',
    async (patch) => {
      // Unlike the queued conflict probes, this storage fake only refuses when
      // the actual UPDATE predicate mismatches. A plain read/merge/write loses
      // the operator edit and therefore fails the final stored-value assertion.
      let stored: Record<string, unknown> = { ...row };
      let fields: Record<string, unknown> | undefined;
      let filters: Array<[string, unknown]> = [];
      let injected = false;
      const qb = db._queryBuilder as Record<string, ReturnType<typeof vi.fn>>;
      db._setReturnData(row); // initial snapshot
      db.from.mockImplementation(() => {
        fields = undefined;
        filters = [];
        return db._queryBuilder;
      });
      qb.update.mockImplementation((value) => {
        fields = value;
        return qb;
      });
      for (const op of ['eq', 'is']) {
        qb[op].mockImplementation((key, value) => {
          filters.push([key, value]);
          return qb;
        });
      }
      const operatorMetadata = {
        ...metadata,
        runtimeConfig: { model: 'operator-model' },
        concurrent: true,
      };
      qb.single.mockImplementation(async () => {
        if (fields && !injected) {
          stored = { ...stored, metadata: operatorMetadata, version: 8 };
          injected = true;
        }
        if (!filters.every(([key, value]) => stored[key] === value)) {
          return { data: null, error: conflict };
        }
        if (fields) stored = { ...stored, ...fields, version: Number(stored.version) + 1 };
        return { data: stored, error: null };
      });

      await handleSaveIdentity({ ...args, metadata: patch }, composer());

      expect(stored.metadata).toEqual({ ...operatorMetadata, ...patch });
      expect(qb.update).toHaveBeenCalledTimes(2);
    }
  );
});
