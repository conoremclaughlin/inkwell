/**
 * Whose memories a call acts for (ink://specs/remove-shared-memories §3.1).
 *
 * Run through the real request context and the real identity resolver; only
 * the agent_identities table is faked, so these cases exercise the same
 * precedence a live call does.
 */

import { describe, it, expect, vi } from 'vitest';
import { runWithRequestContext, type RequestContextData } from '../../utils/request-context';
import { resolveMemoryActor, resolveMemoryOwner, sessionMemoryOwner } from './memory-owner';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const WS_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const WS_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const WREN_A = 'a1a1a1a1-0000-4000-8000-0000000000a1';
const WREN_B = 'b1b1b1b1-0000-4000-8000-0000000000b1';
const MYRA = 'c1c1c1c1-0000-4000-8000-0000000000c1';

type IdentityRow = { id: string; agent_id: string; workspace_id: string | null };

function identities(rows: IdentityRow[], opts: { fail?: boolean } = {}) {
  const lookups: Array<Record<string, unknown>> = [];
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (key: string, value: unknown) => {
          filters[key] = value;
          return q;
        },
        single: () => q,
        then: (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) => {
          if (table !== 'agent_identities') throw new Error('Unexpected table: ' + table);
          lookups.push({ ...filters });
          if (opts.fail) {
            return Promise.resolve({ data: null, error: { message: 'down' } }).then(
              resolve,
              reject
            );
          }
          const matched = rows.filter(
            (row) =>
              (filters.agent_id === undefined || row.agent_id === filters.agent_id) &&
              (filters.id === undefined || row.id === filters.id)
          );
          const data = filters.id !== undefined ? (matched[0] ?? null) : matched;
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return { client: client as never, lookups };
}

const asCaller = <T>(ctx: Partial<RequestContextData>, fn: () => Promise<T>) =>
  runWithRequestContext({ userId: 'owner', ...ctx } as RequestContextData, fn);

describe('resolveMemoryOwner', () => {
  it("takes a bound token's signed identity, with no lookup", async () => {
    const db = identities([]);
    const result = await asCaller(
      { agentTokenBound: true, tokenSlug: 'myra', tokenSbId: MYRA },
      () => resolveMemoryOwner(db.client, 'owner')
    );
    expect(result).toEqual({
      ok: true,
      owner: { sbSlug: 'myra', sbId: MYRA },
      agentBound: true,
    });
    expect(db.lookups).toEqual([]);
  });

  it("refuses a bound token naming another SB's slug, rather than overriding it", async () => {
    const db = identities([{ id: WREN_A, agent_id: 'wren', workspace_id: WS_A }]);
    const result = await asCaller(
      { agentTokenBound: true, tokenSlug: 'myra', tokenSbId: MYRA },
      () => resolveMemoryOwner(db.client, 'owner', 'wren')
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('belongs to myra') });
  });

  it('keeps the bound token as the owner when the unsigned context names someone else', async () => {
    const db = identities([{ id: WREN_A, agent_id: 'wren', workspace_id: WS_A }]);
    const result = await asCaller(
      { sbSlug: 'wren', sbId: WREN_A, agentTokenBound: true, tokenSlug: 'myra', tokenSbId: MYRA },
      () => resolveMemoryOwner(db.client, 'owner')
    );
    expect(result).toMatchObject({ ok: true, owner: { sbSlug: 'myra', sbId: MYRA } });
  });

  it("resolves a legacy bound token's slug in its derived workspace", async () => {
    const db = identities([
      { id: WREN_A, agent_id: 'wren', workspace_id: WS_A },
      { id: WREN_B, agent_id: 'wren', workspace_id: WS_B },
    ]);
    const result = await asCaller(
      {
        agentTokenBound: true,
        tokenSlug: 'wren',
        workspaceId: WS_A,
        workspaceSource: 'derived',
      },
      () => resolveMemoryOwner(db.client, 'owner')
    );
    expect(result).toMatchObject({ ok: true, owner: { sbSlug: 'wren', sbId: WREN_A } });
  });

  it("never lets a header-selected workspace pick a legacy token's owner", async () => {
    // Lumen's spec v2 re-review: same slug in two workspaces, a legacy token
    // with no signed id, and an x-ink-workspace-id selecting B. The header is
    // a resource scope, never the actor's, so the slug stays ambiguous and
    // the call is refused rather than stamped with B's identity.
    const db = identities([
      { id: WREN_A, agent_id: 'wren', workspace_id: WS_A },
      { id: WREN_B, agent_id: 'wren', workspace_id: WS_B },
    ]);
    const result = await asCaller(
      {
        agentTokenBound: true,
        tokenSlug: 'wren',
        workspaceId: WS_B,
        workspaceSource: 'header',
      },
      () => resolveMemoryOwner(db.client, 'owner')
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('ambiguous') });
  });

  it("resolves a person's explicit slug to exactly one identity", async () => {
    const db = identities([{ id: WREN_A, agent_id: 'wren', workspace_id: null }]);
    const result = await asCaller({}, () => resolveMemoryOwner(db.client, 'owner', 'wren'));
    expect(result).toEqual({
      ok: true,
      owner: { sbSlug: 'wren', sbId: WREN_A },
      agentBound: false,
    });
  });

  it("falls back to the person's context slug when none is passed", async () => {
    const db = identities([{ id: WREN_A, agent_id: 'wren', workspace_id: null }]);
    const result = await asCaller({ sbSlug: 'wren' }, () => resolveMemoryOwner(db.client, 'owner'));
    expect(result).toMatchObject({ ok: true, owner: { sbId: WREN_A } });
  });

  it('refuses a slug that names two identities with nothing to choose between them', async () => {
    const db = identities([
      { id: WREN_A, agent_id: 'wren', workspace_id: WS_A },
      { id: WREN_B, agent_id: 'wren', workspace_id: WS_B },
    ]);
    const result = await asCaller({}, () => resolveMemoryOwner(db.client, 'owner', 'wren'));
    expect(result.ok).toBe(false);
  });

  it('refuses when the identity lookup fails, rather than reading unfiltered', async () => {
    const db = identities([], { fail: true });
    const result = await asCaller({}, () => resolveMemoryOwner(db.client, 'owner', 'wren'));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Try again') });
  });

  it('refuses a call with no identity at all', async () => {
    const db = identities([{ id: WREN_A, agent_id: 'wren', workspace_id: null }]);
    const result = await asCaller({}, () => resolveMemoryOwner(db.client, 'owner'));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Pass sbSlug') });
    expect(db.lookups).toEqual([]);
  });
});

describe('resolveMemoryActor', () => {
  it('lets a person act by memory id without naming an SB', async () => {
    const db = identities([]);
    const result = await asCaller({}, () => resolveMemoryActor(db.client, 'owner'));
    expect(result).toEqual({ ok: true, actor: { kind: 'person' } });
    expect(db.lookups).toEqual([]);
  });

  it('confines an SB token to its own identity', async () => {
    const db = identities([]);
    const result = await asCaller(
      { agentTokenBound: true, tokenSlug: 'myra', tokenSbId: MYRA },
      () => resolveMemoryActor(db.client, 'owner')
    );
    expect(result).toEqual({
      ok: true,
      actor: { kind: 'agent', owner: { sbSlug: 'myra', sbId: MYRA } },
    });
  });
});

describe('sessionMemoryOwner', () => {
  it("takes the session's canonical owner as it is", async () => {
    const db = identities([]);
    await expect(
      sessionMemoryOwner(db.client, { userId: 'owner', sbSlug: 'myra', sbId: MYRA })
    ).resolves.toEqual({ sbSlug: 'myra', sbId: MYRA });
    expect(db.lookups).toEqual([]);
  });

  it('gives a session with no SB no owner', async () => {
    const db = identities([]);
    await expect(sessionMemoryOwner(db.client, { userId: 'owner' })).resolves.toBeNull();
  });

  it("gives no owner when the session's slug no longer names exactly one identity", async () => {
    const db = identities([
      { id: WREN_A, agent_id: 'wren', workspace_id: WS_A },
      { id: WREN_B, agent_id: 'wren', workspace_id: WS_B },
    ]);
    await expect(
      sessionMemoryOwner(db.client, { userId: 'owner', sbSlug: 'wren' })
    ).resolves.toBeNull();
  });
});
