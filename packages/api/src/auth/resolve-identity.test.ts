import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveIdentityId,
  resolveIdentityResult,
  resolveOwnerSbId,
  resolveAgentSlug,
} from './resolve-identity';
import { runWithRequestContext } from '../utils/request-context';

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
import { logger } from '../utils/logger';

const USER = '11111111-1111-4111-8111-111111111111';
const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SB_IN_A = '1111aaaa-1111-4111-8111-111111111111';
const SB_IN_B = '2222bbbb-2222-4222-8222-222222222222';
const SB_LEGACY = '3333cccc-3333-4333-8333-333333333333';

type Row = { id: string; workspace_id: string | null };

/**
 * Minimal PostgREST double: records the filters applied so a test can assert
 * the resolver narrowed the query the way it claims to, and resolves to the
 * rows it was seeded with.
 */
function fakeSupabase(result: { data?: unknown; error?: { message: string } | null }) {
  const filters: Array<[string, unknown]> = [];
  const selected: string[] = [];
  const payload = { data: result.data ?? null, error: result.error ?? null };
  const builder: Record<string, unknown> = {
    select: (cols: string) => {
      selected.push(cols);
      return builder;
    },
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return builder;
    },
    single: () => Promise.resolve(payload),
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(payload).then(onFulfilled, onRejected),
  };
  const tables: string[] = [];
  const client = {
    from: (table: string) => {
      tables.push(table);
      return builder;
    },
  };
  return { client: client as never, filters, selected, tables };
}

const rows = (...items: Row[]) => ({ data: items });

beforeEach(() => vi.clearAllMocks());

describe('resolveIdentityId', () => {
  it('returns null when the slug has no identity at all', async () => {
    const f = fakeSupabase(rows());
    expect(await resolveIdentityId(f.client, USER, 'nobody')).toBeNull();
  });

  it('resolves a lone identity when no workspace is in play', async () => {
    const f = fakeSupabase(rows({ id: SB_IN_A, workspace_id: WS_A }));
    expect(await resolveIdentityId(f.client, USER, 'wren')).toBe(SB_IN_A);
    expect(f.tables).toEqual(['agent_identities']);
    expect(f.filters).toEqual([
      ['user_id', USER],
      ['agent_id', 'wren'],
    ]);
  });

  it('picks the identity belonging to the given workspace when a slug is shared', async () => {
    const shared = rows({ id: SB_IN_A, workspace_id: WS_A }, { id: SB_IN_B, workspace_id: WS_B });
    expect(await resolveIdentityId(fakeSupabase(shared).client, USER, 'wren', WS_A)).toBe(SB_IN_A);
    expect(await resolveIdentityId(fakeSupabase(shared).client, USER, 'wren', WS_B)).toBe(SB_IN_B);
  });

  it('refuses a shared slug when there is no workspace to resolve inside', async () => {
    const f = fakeSupabase(
      rows({ id: SB_IN_A, workspace_id: WS_A }, { id: SB_IN_B, workspace_id: WS_B })
    );

    const resolved = await resolveIdentityId(f.client, USER, 'wren');

    // The point of the refusal: it returns neither candidate, rather than the
    // first/newest row. Assert against both so a "pick one" regression fails.
    expect(resolved).toBeNull();
    expect(resolved).not.toBe(SB_IN_A);
    expect(resolved).not.toBe(SB_IN_B);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('ambiguous'),
      expect.objectContaining({ agentId: 'wren', candidateCount: 2 })
    );
  });

  it('does not resolve a slug that exists only in another workspace', async () => {
    const f = fakeSupabase(rows({ id: SB_IN_B, workspace_id: WS_B }));

    const resolved = await resolveIdentityId(f.client, USER, 'wren', WS_A);

    expect(resolved).toBeNull();
    expect(resolved).not.toBe(SB_IN_B);
  });

  it('falls back to a legacy identity that has no workspace yet', async () => {
    const f = fakeSupabase(rows({ id: SB_LEGACY, workspace_id: null }));

    expect(await resolveIdentityId(f.client, USER, 'echo', WS_A)).toBe(SB_LEGACY);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('legacy identity'),
      expect.objectContaining({ identityId: SB_LEGACY })
    );
  });

  it('prefers the workspace-scoped identity over a legacy null-workspace one', async () => {
    const f = fakeSupabase(
      rows({ id: SB_LEGACY, workspace_id: null }, { id: SB_IN_A, workspace_id: WS_A })
    );

    const resolved = await resolveIdentityId(f.client, USER, 'echo', WS_A);

    expect(resolved).toBe(SB_IN_A);
    expect(resolved).not.toBe(SB_LEGACY);
  });

  it('takes the workspace the server DERIVED from the caller when not passed one', async () => {
    const shared = () =>
      fakeSupabase(rows({ id: SB_IN_A, workspace_id: WS_A }, { id: SB_IN_B, workspace_id: WS_B }));

    const inB = await runWithRequestContext(
      { userId: USER, workspaceId: WS_B, workspaceSource: 'derived' },
      () => resolveIdentityId(shared().client, USER, 'wren')
    );

    expect(inB).toBe(SB_IN_B);

    // Control: the same call outside a request context cannot narrow, and refuses.
    expect(await resolveIdentityId(shared().client, USER, 'wren')).toBeNull();
  });

  it('does NOT let a header-selected workspace rename the authenticated writer', async () => {
    const shared = () =>
      fakeSupabase(rows({ id: SB_IN_A, workspace_id: WS_A }, { id: SB_IN_B, workspace_id: WS_B }));

    // x-ink-workspace-id is a resource-selection scope, accepted whenever the
    // USER has access. Honouring it here stamped B's UUID on A's writes.
    const viaHeader = await runWithRequestContext(
      { userId: USER, workspaceId: WS_B, workspaceSource: 'header' },
      () => resolveIdentityId(shared().client, USER, 'wren')
    );

    expect(viaHeader).toBeNull();
    expect(viaHeader).not.toBe(SB_IN_B);
  });

  it.each(['session', 'default'] as const)(
    'ignores a %s workspace as the actor scope too',
    async (source) => {
      const f = fakeSupabase(
        rows({ id: SB_IN_A, workspace_id: WS_A }, { id: SB_IN_B, workspace_id: WS_B })
      );

      const resolved = await runWithRequestContext(
        { userId: USER, workspaceId: WS_B, workspaceSource: source },
        () => resolveIdentityId(f.client, USER, 'wren')
      );

      expect(resolved).toBeNull();
    }
  );

  it('matches a workspace UUID regardless of case', async () => {
    const f = fakeSupabase(rows({ id: SB_IN_A, workspace_id: WS_A }));

    // Postgres returns uuids lower-cased; a header does not have to be.
    const resolved = await resolveIdentityId(f.client, USER, 'wren', WS_A.toUpperCase());

    expect(resolved).toBe(SB_IN_A);
  });

  it('does not fall through to a legacy row just because the case differed', async () => {
    const f = fakeSupabase(
      rows({ id: SB_LEGACY, workspace_id: null }, { id: SB_IN_A, workspace_id: WS_A })
    );

    const resolved = await resolveIdentityId(f.client, USER, 'wren', WS_A.toUpperCase());

    expect(resolved).toBe(SB_IN_A);
    expect(resolved).not.toBe(SB_LEGACY);
  });

  it('lets an explicit workspace win over the ambient one', async () => {
    const f = fakeSupabase(
      rows({ id: SB_IN_A, workspace_id: WS_A }, { id: SB_IN_B, workspace_id: WS_B })
    );

    const resolved = await runWithRequestContext({ userId: USER, workspaceId: WS_B }, () =>
      resolveIdentityId(f.client, USER, 'wren', WS_A)
    );

    expect(resolved).toBe(SB_IN_A);
  });

  it('returns null when the query fails', async () => {
    const f = fakeSupabase({ error: { message: 'connection reset' } });
    expect(await resolveIdentityId(f.client, USER, 'wren', WS_A)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to resolve'),
      expect.objectContaining({ error: 'connection reset' })
    );
  });
});

describe('resolveIdentityResult — why it failed', () => {
  it('reports no-identity when the slug names nobody', async () => {
    const f = fakeSupabase(rows());
    expect(await resolveIdentityResult(f.client, USER, 'nobody')).toEqual({
      ok: false,
      reason: 'no-identity',
    });
  });

  it('reports ambiguous when a slug has two answers and nothing narrows it', async () => {
    const f = fakeSupabase(
      rows({ id: SB_IN_A, workspace_id: WS_A }, { id: SB_IN_B, workspace_id: WS_B })
    );
    expect(await resolveIdentityResult(f.client, USER, 'wren')).toEqual({
      ok: false,
      reason: 'ambiguous',
    });
  });

  it('reports not-in-workspace when the slug lives somewhere else', async () => {
    const f = fakeSupabase(rows({ id: SB_IN_B, workspace_id: WS_B }));
    expect(await resolveIdentityResult(f.client, USER, 'wren', WS_A)).toEqual({
      ok: false,
      reason: 'not-in-workspace',
    });
  });

  it('separates "nobody claimed it" from "a claim could not be honoured"', async () => {
    const nobody = fakeSupabase(rows());
    const ambiguous = fakeSupabase(
      rows({ id: SB_IN_A, workspace_id: WS_A }, { id: SB_IN_B, workspace_id: WS_B })
    );

    // Both are null through the legacy helper; only the result type tells them
    // apart, and that difference is what owner-bearing writes key off.
    expect(await resolveIdentityId(nobody.client, USER, 'nobody')).toBeNull();
    expect(await resolveIdentityId(ambiguous.client, USER, 'wren')).toBeNull();

    const a = await resolveIdentityResult(nobody.client, USER, 'nobody');
    const b = await resolveIdentityResult(ambiguous.client, USER, 'wren');
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect((a as { reason: string }).reason).not.toBe((b as { reason: string }).reason);
  });
});

describe('resolveOwnerSbId — owner-bearing writes fail closed', () => {
  it('uses a canonical sbId the caller already holds without looking anything up', async () => {
    const f = fakeSupabase(rows());
    expect(await resolveOwnerSbId(f.client, USER, 'wren', SB_IN_A)).toBe(SB_IN_A);
    expect(f.tables).toEqual([]);
  });

  it('allows a genuinely unattributed write when no slug is claimed', async () => {
    const f = fakeSupabase(rows());
    expect(await resolveOwnerSbId(f.client, USER, undefined)).toBeNull();
  });

  it('allows null when the slug simply names nobody', async () => {
    const f = fakeSupabase(rows());
    expect(await resolveOwnerSbId(f.client, USER, 'nobody')).toBeNull();
  });

  it('refuses to write a null owner when a slug is ambiguous', async () => {
    const f = fakeSupabase(
      rows({ id: SB_IN_A, workspace_id: WS_A }, { id: SB_IN_B, workspace_id: WS_B })
    );

    // The whole point: null here is not "unattributed", it is a row that the
    // legacy slug-only authorization path will hand to BOTH same-slug SBs.
    await expect(resolveOwnerSbId(f.client, USER, 'wren')).rejects.toThrow(/ambiguous/);
  });

  it('refuses when the slug belongs to another workspace', async () => {
    const f = fakeSupabase(rows({ id: SB_IN_B, workspace_id: WS_B }));

    // Scoped to A by the caller's own derived workspace; the only wren is in B.
    await expect(
      runWithRequestContext({ userId: USER, workspaceId: WS_A, workspaceSource: 'derived' }, () =>
        resolveOwnerSbId(f.client, USER, 'wren')
      )
    ).rejects.toThrow(/not-in-workspace/);
  });

  it('still refuses an ambiguous slug even though a null return would have "worked"', async () => {
    const f = fakeSupabase(
      rows({ id: SB_IN_A, workspace_id: WS_A }, { id: SB_IN_B, workspace_id: WS_B })
    );

    // Control: the permissive helper returns null for the same input. The
    // difference between the two is the entire fix.
    expect(await resolveIdentityId(f.client, USER, 'wren')).toBeNull();
    await expect(
      resolveOwnerSbId(
        fakeSupabase(rows({ id: SB_IN_A, workspace_id: WS_A }, { id: SB_IN_B, workspace_id: WS_B }))
          .client,
        USER,
        'wren'
      )
    ).rejects.toThrow();
  });
});

describe('resolveAgentSlug', () => {
  it('resolves a slug from a canonical UUID', async () => {
    const f = fakeSupabase({ data: { agent_id: 'wren' } });
    expect(await resolveAgentSlug(f.client, SB_IN_A)).toBe('wren');
    expect(f.filters).toEqual([['id', SB_IN_A]]);
  });

  it('returns null when the UUID names no identity', async () => {
    const f = fakeSupabase({ error: { message: 'no rows' } });
    expect(await resolveAgentSlug(f.client, SB_IN_A)).toBeNull();
  });
});
