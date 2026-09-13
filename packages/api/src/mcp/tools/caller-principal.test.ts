/**
 * The caller of a thread tool is a principal resolved at the boundary
 * (spec inkmail-thread-scope §3): the token's identity when the connection
 * is bound, else the user's single workspace-scoped identity for the slug.
 * Zero or several fails closed — an unresolved caller has no workspace to
 * look in.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeFakeSupabase } from '../../services/sessions/fake-supabase.js';
import * as requestContext from '../../utils/request-context';
import { resolveCallerSb, resolveCallerWorkspace } from './caller-principal';

const identities = () => [
  { id: 'sb-wren-1', agent_id: 'wren', user_id: 'user-1', workspace_id: 'ws-1' },
  { id: 'sb-wren-2', agent_id: 'wren', user_id: 'user-1', workspace_id: 'ws-2' },
  { id: 'sb-lumen-1', agent_id: 'lumen', user_id: 'user-1', workspace_id: 'ws-1' },
  { id: 'sb-legacy', agent_id: 'myra', user_id: 'user-1', workspace_id: null },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveCallerSb', () => {
  it('uses the token-bound identity when the request context carries one', async () => {
    vi.spyOn(requestContext, 'getRequestContext').mockReturnValue({
      sbId: 'sb-wren-2',
      timestamp: 0,
    } as never);
    const client = makeFakeSupabase({ agent_identities: identities() });
    expect((await resolveCallerSb(client as never, 'user-1', 'wren')).workspaceId).toBe('ws-2');
  });

  it('refuses a token bound to one identity naming another slug', async () => {
    vi.spyOn(requestContext, 'getRequestContext').mockReturnValue({
      sbId: 'sb-lumen-1',
      timestamp: 0,
    } as never);
    const client = makeFakeSupabase({ agent_identities: identities() });
    await expect(resolveCallerSb(client as never, 'user-1', 'wren')).rejects.toThrow(
      'Agent identity mismatch: token is lumen, call names wren'
    );
  });

  it("falls back to the user's single workspace-scoped identity for the slug", async () => {
    vi.spyOn(requestContext, 'getRequestContext').mockReturnValue(undefined);
    vi.spyOn(requestContext, 'getSessionContext').mockReturnValue(undefined);
    const client = makeFakeSupabase({ agent_identities: identities() });
    expect((await resolveCallerSb(client as never, 'user-1', 'lumen')).sbId).toBe('sb-lumen-1');
  });

  it("fails closed when the slug lives in two of the user's workspaces and nothing is bound", async () => {
    vi.spyOn(requestContext, 'getRequestContext').mockReturnValue(undefined);
    vi.spyOn(requestContext, 'getSessionContext').mockReturnValue(undefined);
    const client = makeFakeSupabase({ agent_identities: identities() });
    await expect(resolveCallerSb(client as never, 'user-1', 'wren')).rejects.toThrow(
      'exists in 2 of your workspaces'
    );
  });

  it('fails closed on an unknown slug, and on a legacy identity with no workspace', async () => {
    vi.spyOn(requestContext, 'getRequestContext').mockReturnValue(undefined);
    vi.spyOn(requestContext, 'getSessionContext').mockReturnValue(undefined);
    const client = makeFakeSupabase({ agent_identities: identities() });
    await expect(resolveCallerSb(client as never, 'user-1', 'nobody')).rejects.toThrow(
      'Unknown agent for user: nobody'
    );
    await expect(resolveCallerSb(client as never, 'user-1', 'myra')).rejects.toThrow(
      'Unknown agent for user: myra'
    );
  });
});

describe('resolveCallerWorkspace', () => {
  it("is the named SB's workspace, else the bound identity's, else the personal workspace", async () => {
    const ctx = vi.spyOn(requestContext, 'getRequestContext').mockReturnValue(undefined);
    vi.spyOn(requestContext, 'getSessionContext').mockReturnValue(undefined);
    const client = makeFakeSupabase({
      agent_identities: identities(),
      workspaces: [
        {
          id: 'ws-personal',
          user_id: 'user-1',
          type: 'personal',
          slug: 'personal',
          archived_at: null,
        },
      ],
    });
    expect((await resolveCallerWorkspace(client as never, 'user-1', 'lumen')).workspaceId).toBe(
      'ws-1'
    );
    expect((await resolveCallerWorkspace(client as never, 'user-1')).workspaceId).toBe(
      'ws-personal'
    );
    ctx.mockReturnValue({ sbId: 'sb-wren-2', timestamp: 0 } as never);
    expect((await resolveCallerWorkspace(client as never, 'user-1')).workspaceId).toBe('ws-2');
  });
});
