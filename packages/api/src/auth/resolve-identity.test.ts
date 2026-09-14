import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveIdentityId, resolveAgentSlug } from './resolve-identity';
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

  it('takes the workspace from the ambient request context when not passed one', async () => {
    const shared = () =>
      fakeSupabase(rows({ id: SB_IN_A, workspace_id: WS_A }, { id: SB_IN_B, workspace_id: WS_B }));

    const inB = await runWithRequestContext({ userId: USER, workspaceId: WS_B }, () =>
      resolveIdentityId(shared().client, USER, 'wren')
    );

    expect(inB).toBe(SB_IN_B);

    // Control: the same call outside a request context cannot narrow, and refuses.
    expect(await resolveIdentityId(shared().client, USER, 'wren')).toBeNull();
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
