/**
 * Principals resolve inside ONE workspace to exactly one identity, or fail
 * closed (spec inkmail-thread-scope §1c, §3). These pin the resolver's
 * zero/one/several outcomes against the table-backed fake, and the column
 * shapes every writer derives from a principal.
 */

import { describe, it, expect } from 'vitest';
import { makeFakeSupabase } from './sessions/fake-supabase.js';
import {
  SYSTEM_PRINCIPAL,
  principalColumns,
  principalKey,
  resolveSbById,
  resolveSbInWorkspace,
  resolveSbsByIds,
  senderColumns,
  userPrincipal,
  workspaceOfSb,
} from './principals';

const identities = () => [
  { id: 'sb-wren-1', agent_id: 'wren', user_id: 'user-1', workspace_id: 'ws-1' },
  { id: 'sb-wren-2', agent_id: 'wren', user_id: 'user-1', workspace_id: 'ws-2' },
  { id: 'sb-lumen-1', agent_id: 'lumen', user_id: 'user-1', workspace_id: 'ws-1' },
  { id: 'sb-twin', agent_id: 'lumen', user_id: 'user-2', workspace_id: 'ws-1' },
  { id: 'sb-orphan', agent_id: 'aster', user_id: 'user-1', workspace_id: null },
];

describe('resolveSbInWorkspace', () => {
  it('resolves a slug to the one identity in that workspace', async () => {
    const client = makeFakeSupabase({ agent_identities: identities() });
    expect(await resolveSbInWorkspace(client as never, 'ws-2', 'wren')).toEqual({
      kind: 'sb',
      sbId: 'sb-wren-2',
      agentId: 'wren',
      userId: 'user-1',
      workspaceId: 'ws-2',
    });
  });

  it('fails closed on a slug with no identity in the workspace', async () => {
    const client = makeFakeSupabase({ agent_identities: identities() });
    await expect(resolveSbInWorkspace(client as never, 'ws-2', 'lumen')).rejects.toThrow(
      'Unknown recipient: lumen'
    );
  });

  it('fails closed on a slug two users share inside one workspace', async () => {
    // The cutover's UNIQUE (workspace_id, agent_id) forbids this state; if
    // the database and this code ever disagree, the resolver refuses rather
    // than picks.
    const client = makeFakeSupabase({ agent_identities: identities() });
    await expect(resolveSbInWorkspace(client as never, 'ws-1', 'lumen')).rejects.toThrow(
      'Ambiguous recipient: lumen names 2 identities here'
    );
  });
});

describe('resolveSbById / resolveSbsByIds / workspaceOfSb', () => {
  it('resolves an identity id and its workspace', async () => {
    const client = makeFakeSupabase({ agent_identities: identities() });
    expect((await resolveSbById(client as never, 'sb-lumen-1'))?.workspaceId).toBe('ws-1');
    expect(await workspaceOfSb(client as never, 'sb-lumen-1')).toBe('ws-1');
    expect(await resolveSbById(client as never, 'nope')).toBeNull();
    expect(await workspaceOfSb(client as never, 'nope')).toBeNull();
  });

  it('refuses an identity with no workspace — it cannot take part in a thread', async () => {
    const client = makeFakeSupabase({ agent_identities: identities() });
    await expect(resolveSbById(client as never, 'sb-orphan')).rejects.toThrow(
      'has no workspace and cannot take part in a thread'
    );
    // The batch form skips such rows instead of throwing (display lookups).
    const many = await resolveSbsByIds(client as never, ['sb-orphan', 'sb-wren-1']);
    expect(many.map((p) => p.sbId)).toEqual(['sb-wren-1']);
  });
});

describe('column shapes', () => {
  it('derive the sender, participant and key columns from a principal', () => {
    const sb = {
      kind: 'sb',
      sbId: 'sb-1',
      agentId: 'wren',
      userId: 'u',
      workspaceId: 'w',
    } as const;
    expect(senderColumns(sb)).toEqual({
      sender_kind: 'sb',
      sender_sb_id: 'sb-1',
      sender_user_id: null,
      sender_agent_id: 'wren',
    });
    expect(senderColumns(userPrincipal('u-9'))).toEqual({
      sender_kind: 'user',
      sender_sb_id: null,
      sender_user_id: 'u-9',
      sender_agent_id: null,
    });
    // A system message borrows nobody's identity (§3): no ids, no slug.
    expect(senderColumns(SYSTEM_PRINCIPAL)).toEqual({
      sender_kind: 'system',
      sender_sb_id: null,
      sender_user_id: null,
      sender_agent_id: null,
    });
    expect(principalColumns(sb)).toEqual({ sb_id: 'sb-1', user_id: null });
    expect(principalColumns(userPrincipal('u-9'))).toEqual({ sb_id: null, user_id: 'u-9' });
    expect(principalKey(sb)).toBe('sb:sb-1');
    expect(principalKey(userPrincipal('u-9'))).toBe('user:u-9');
  });
});
