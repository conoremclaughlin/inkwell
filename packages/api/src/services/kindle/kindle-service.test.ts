/**
 * Kindle Service Tests
 *
 * Tests the core kindle business logic: extracting value seeds,
 * creating/redeeming tokens, and completing onboarding.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KindleService } from './kindle-service';
import { createMockSupabaseClient, type MockSupabaseClient } from '../../test/mocks/supabase.mock';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('KindleService', () => {
  let mockSupabase: MockSupabaseClient;
  let service: KindleService;

  beforeEach(() => {
    mockSupabase = createMockSupabaseClient();
    service = new KindleService(mockSupabase as unknown as SupabaseClient);
    vi.clearAllMocks();
  });

  const TOKEN = {
    id: 'token-uuid-123',
    token: 'abc123hex',
    creator_user_id: 'creator-user',
    creator_agent_id: 'wren',
    value_seed: { parentName: 'Wren', coreValues: ['growth'] },
    status: 'active',
    expires_at: '2099-12-31T00:00:00Z',
  };
  const LINEAGE = {
    id: 'lineage-1',
    parent_agent_id: 'wren',
    parent_user_id: 'creator-user',
    facilitator_user_id: 'creator-user',
    child_agent_id: 'kindle-token-uuid-123',
    child_user_id: 'new-user',
    kindle_method: 'referral',
    value_seed: { parentName: 'Wren' },
    onboarding_status: 'values_interview',
    onboarding_session_id: null,
    interview_responses: [],
    chosen_name: null,
    created_at: '2026-02-10T00:00:00Z',
    completed_at: null,
  };

  interface MutationCall {
    table: string;
    method: 'insert' | 'update' | 'upsert';
    row: unknown;
    options?: unknown;
  }

  function tableAwareSupabase(opts: {
    identityWorkspaces?: Array<{ workspace_id: string }> | { error: string };
    /** Workspace ids that verify as active + owned. */
    activeWorkspaceIds?: string[];
    oldestWorkspace?: { id: string } | null;
    /** Result for the completeOnboarding rename update. */
    identityUpdateResult?: { data: unknown; error: { message: string } | null };
    /** Override the kindle_lineage row (completeOnboarding reads + returns it). */
    lineage?: Record<string, unknown>;
    /** Result of the redeem_kindle_token RPC. */
    rpcResult?: { data: unknown; error: { message: string } | null };
  }) {
    const mutations: MutationCall[] = [];
    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const from = vi.fn().mockImplementation((table: string) => {
      const ops: Array<{ method: string; args: unknown[] }> = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: Record<string, any> = {};
      for (const m of ['select', 'eq', 'neq', 'is', 'not', 'or', 'order', 'limit']) {
        chain[m] = vi.fn().mockImplementation((...args: unknown[]) => {
          ops.push({ method: m, args });
          return chain;
        });
      }
      for (const m of ['insert', 'update', 'upsert'] as const) {
        chain[m] = vi.fn().mockImplementation((row: unknown, options?: unknown) => {
          ops.push({ method: m, args: [row] });
          mutations.push({ table, method: m, row, options });
          return chain;
        });
      }
      const has = (method: string) => ops.some((o) => o.method === method);
      const eqArg = (col: string) =>
        ops.find((o) => o.method === 'eq' && o.args[0] === col)?.args[1];
      const resolve = () => {
        if (table === 'kindle_tokens') return { data: TOKEN, error: null };
        if (table === 'kindle_lineage') return { data: opts.lineage ?? LINEAGE, error: null };
        if (table === 'agent_identities') {
          if (has('upsert')) return { data: null, error: null };
          if (has('update')) {
            return opts.identityUpdateResult ?? { data: [{ id: 'ai-1' }], error: null };
          }
          const spec = opts.identityWorkspaces ?? [];
          if (!Array.isArray(spec)) return { data: null, error: { message: spec.error } };
          return { data: spec, error: null };
        }
        if (table === 'workspaces') {
          if (has('order')) return { data: opts.oldestWorkspace ?? null, error: null };
          // Verification of a specific candidate: active + owned, or miss.
          const id = eqArg('id') as string | undefined;
          const active = opts.activeWorkspaceIds ?? [];
          return { data: id && active.includes(id) ? { id } : null, error: null };
        }
        return { data: null, error: null };
      };
      chain.single = vi.fn().mockImplementation(() => Promise.resolve(resolve()));
      chain.maybeSingle = vi.fn().mockImplementation(() => Promise.resolve(resolve()));
      chain.then = (r: (v: unknown) => unknown) => Promise.resolve(resolve()).then(r);
      return chain;
    });
    const rpc = vi.fn().mockImplementation((fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve(opts.rpcResult ?? { data: opts.lineage ?? LINEAGE, error: null });
    });
    return { client: { from, rpc } as unknown as SupabaseClient, mutations, rpcCalls };
  }

  describe('extractValueSeed', () => {
    it('should extract values from agent identity and user identity', async () => {
      // The mock returns the same data for all queries — set up for the first call (agent identity)
      // Since both queries use .single(), they'll both get the same return data.
      // We'll test the mapping logic by setting data that covers both queries.
      mockSupabase._setReturnData({
        agent_id: 'wren',
        name: 'Wren',
        values: ['curiosity', 'authenticity', 'growth'],
        soul: '# Soul\n\nI value deep understanding.\nI believe in authentic collaboration.',
        shared_values: 'We share a commitment to honesty.',
        shared_values_md: 'We share a commitment to honesty.',
      });

      const seed = await service.extractValueSeed('user-123', 'wren');

      expect(seed.parentAgentId).toBe('wren');
      expect(seed.parentName).toBe('Wren');
      expect(seed.coreValues).toEqual(['curiosity', 'authenticity', 'growth']);
      expect(seed.philosophicalOrientation).toContain('I value deep understanding');
      expect(mockSupabase.from).toHaveBeenCalledWith('agent_identities');
      expect(mockSupabase.from).toHaveBeenCalledWith('workspaces');
      expect(mockSupabase.from).toHaveBeenCalledWith('user_identity');
    });

    it('should filter out relationship and session lines from soul', async () => {
      mockSupabase._setReturnData({
        agent_id: 'wren',
        name: 'Wren',
        values: [],
        soul: '# Philosophy\nI value growth.\n## Relationship Notes\nOur relationship is...\n## Session Context\nIn specific sessions...\nI care about authenticity.',
        shared_values: '',
        shared_values_md: '',
      });

      const seed = await service.extractValueSeed('user-123', 'wren');

      // Lines with 'relationship', 'specific', or 'session' should be filtered
      expect(seed.philosophicalOrientation).not.toContain('Relationship');
      expect(seed.philosophicalOrientation).not.toContain('specific');
      expect(seed.philosophicalOrientation).not.toContain('Session');
      expect(seed.philosophicalOrientation).toContain('I value growth');
      expect(seed.philosophicalOrientation).toContain('I care about authenticity');
    });

    it('should handle missing identity gracefully', async () => {
      mockSupabase._setReturnData(null);

      const seed = await service.extractValueSeed('user-123', 'nonexistent');

      expect(seed.parentAgentId).toBe('nonexistent');
      expect(seed.parentName).toBe('nonexistent');
      expect(seed.coreValues).toEqual([]);
      expect(seed.philosophicalOrientation).toBe('');
      expect(seed.sharedValues).toBe('');
    });
  });

  describe('createKindleToken', () => {
    it('should create a token without agent (no value seed)', async () => {
      const mockTokenRow = {
        id: 'token-uuid-123',
        token: 'abc123hex',
        creator_user_id: 'user-123',
        creator_agent_id: null,
        value_seed: {},
        status: 'active',
        used_by_user_id: null,
        used_at: null,
        expires_at: '2026-02-17T00:00:00Z',
        created_at: '2026-02-10T00:00:00Z',
      };

      mockSupabase._setReturnData(mockTokenRow);

      const result = await service.createKindleToken('user-123');

      expect(result.id).toBe('token-uuid-123');
      expect(result.token).toBe('abc123hex');
      expect(result.creatorUserId).toBe('user-123');
      expect(result.creatorAgentId).toBeNull();
      expect(result.status).toBe('active');
      expect(mockSupabase.from).toHaveBeenCalledWith('kindle_tokens');
    });

    it('should create a token with agent value seed', async () => {
      const mockTokenRow = {
        id: 'token-uuid-456',
        token: 'def456hex',
        creator_user_id: 'user-123',
        creator_agent_id: 'wren',
        value_seed: {
          parentAgentId: 'wren',
          parentName: 'Wren',
          coreValues: ['growth'],
          philosophicalOrientation: 'I value growth.',
          sharedValues: '',
        },
        status: 'active',
        used_by_user_id: null,
        used_at: null,
        expires_at: '2026-02-17T00:00:00Z',
        created_at: '2026-02-10T00:00:00Z',
      };

      // First call returns agent identity (for extractValueSeed), rest return the token
      mockSupabase._setReturnData(mockTokenRow);

      const result = await service.createKindleToken('user-123', 'wren');

      expect(result.creatorAgentId).toBe('wren');
      expect(mockSupabase.from).toHaveBeenCalledWith('kindle_tokens');
    });

    it('should throw on database error', async () => {
      mockSupabase._setReturnData(null, { message: 'insert failed' });

      await expect(service.createKindleToken('user-123')).rejects.toThrow(
        'Failed to create kindle token: insert failed'
      );
    });
  });

  describe('getToken', () => {
    it('should return a token by its string', async () => {
      mockSupabase._setReturnData({
        id: 'token-uuid-123',
        token: 'abc123hex',
        creator_user_id: 'user-123',
        creator_agent_id: null,
        value_seed: {},
        status: 'active',
        used_by_user_id: null,
        used_at: null,
        expires_at: '2026-02-17T00:00:00Z',
        created_at: '2026-02-10T00:00:00Z',
      });

      const result = await service.getToken('abc123hex');

      expect(result).not.toBeNull();
      expect(result!.token).toBe('abc123hex');
      expect(result!.status).toBe('active');
      expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('token', 'abc123hex');
    });

    it('should return null for non-existent token', async () => {
      mockSupabase._setReturnData(null);

      const result = await service.getToken('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('redeemKindleToken', () => {
    it('should redeem a valid token and create lineage', async () => {
      // The mock returns the same data for all queries.
      // redeemKindleToken calls: select token → insert lineage → update token → upsert identity → update lineage
      // We'll set the data to match the token query (first call) and lineage insert (most critical).
      const mockData = {
        // Token fields
        id: 'token-uuid-123',
        token: 'abc123hex',
        creator_user_id: 'creator-user',
        creator_agent_id: 'wren',
        value_seed: { parentName: 'Wren', coreValues: ['growth'] },
        status: 'active',
        expires_at: '2099-12-31T00:00:00Z', // far future
        // Lineage fields (returned from insert)
        parent_agent_id: 'wren',
        parent_user_id: 'creator-user',
        facilitator_user_id: 'creator-user',
        child_agent_id: 'kindle-token-uuid-123',
        child_user_id: 'new-user',
        kindle_method: 'referral',
        onboarding_status: 'values_interview',
        onboarding_session_id: null,
        interview_responses: [],
        chosen_name: null,
        created_at: '2026-02-10T00:00:00Z',
        completed_at: null,
      };

      mockSupabase._setReturnData(mockData);

      const result = await service.redeemKindleToken('abc123hex', 'new-user');

      expect(result.childUserId).toBe('new-user');
      expect(result.onboardingStatus).toBe('values_interview');
      expect(result.parentAgentId).toBe('wren');
      expect(mockSupabase.from).toHaveBeenCalledWith('kindle_tokens');
      // Lineage + identity + token consumption all live inside the atomic
      // redeem_kindle_token RPC — no client-side table writes.
      expect(mockSupabase.rpc).toHaveBeenCalledWith(
        'redeem_kindle_token',
        expect.objectContaining({ p_token: 'abc123hex', p_new_user_id: 'new-user' })
      );
    });

    it('should reject invalid or inactive tokens', async () => {
      mockSupabase._setReturnData(null, { code: 'PGRST116', message: 'not found' });

      await expect(service.redeemKindleToken('invalid-token', 'new-user')).rejects.toThrow(
        'Invalid or expired kindle token'
      );
    });

    it('should reject expired tokens', async () => {
      mockSupabase._setReturnData({
        id: 'token-uuid-123',
        token: 'abc123hex',
        creator_user_id: 'creator-user',
        creator_agent_id: null,
        value_seed: {},
        status: 'active',
        expires_at: '2020-01-01T00:00:00Z', // expired
      });

      await expect(service.redeemKindleToken('abc123hex', 'new-user')).rejects.toThrow(
        'Kindle token has expired'
      );
    });
  });

  describe('completeOnboarding', () => {
    it('should finalize identity with chosen name', async () => {
      const lineage = {
        ...LINEAGE,
        id: 'kindle-123',
        child_agent_id: 'ember',
        onboarding_status: 'complete',
        chosen_name: 'Ember',
        completed_at: '2026-02-10T01:00:00Z',
      };
      const { client, mutations } = tableAwareSupabase({ lineage });
      const svc = new KindleService(client);

      const result = await svc.completeOnboarding('kindle-123', 'Ember');

      expect(result.chosenName).toBe('Ember');
      expect(result.onboardingStatus).toBe('complete');
      expect(result.childAgentId).toBe('ember');
      expect(
        mutations.find((m) => m.table === 'agent_identities' && m.method === 'update')
      ).toBeDefined();
      expect(
        mutations.find((m) => m.table === 'kindle_lineage' && m.method === 'update')
      ).toBeDefined();
    });

    it('should generate agent ID from chosen name (lowercase, alphanumeric)', async () => {
      const lineage = {
        ...LINEAGE,
        id: 'kindle-123',
        child_agent_id: 'nova-spark',
        onboarding_status: 'complete',
        chosen_name: 'Nova Spark',
        completed_at: '2026-02-10T01:00:00Z',
      };
      const { client, mutations } = tableAwareSupabase({ lineage });
      const svc = new KindleService(client);

      const result = await svc.completeOnboarding('kindle-123', 'Nova Spark');

      // The agent_identities update carries the lowercased/sanitized name.
      const rename = mutations.find((m) => m.table === 'agent_identities' && m.method === 'update');
      expect(rename?.row).toMatchObject({ agent_id: 'nova-spark' });
      expect(result.chosenName).toBe('Nova Spark');
    });

    it('should throw if kindle lineage not found', async () => {
      mockSupabase._setReturnData(null, { code: 'PGRST116', message: 'not found' });

      await expect(service.completeOnboarding('nonexistent', 'Ember')).rejects.toThrow(
        'Kindle lineage not found'
      );
    });
  });

  describe('getKindle', () => {
    it('should return a kindle lineage by ID', async () => {
      mockSupabase._setReturnData({
        id: 'kindle-123',
        parent_agent_id: 'wren',
        parent_user_id: 'user-123',
        facilitator_user_id: 'user-123',
        child_agent_id: 'ember',
        child_user_id: 'user-456',
        kindle_method: 'referral',
        value_seed: {},
        onboarding_status: 'complete',
        onboarding_session_id: null,
        interview_responses: [],
        chosen_name: 'Ember',
        created_at: '2026-02-10T00:00:00Z',
        completed_at: '2026-02-10T01:00:00Z',
      });

      const result = await service.getKindle('kindle-123');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('kindle-123');
      expect(result!.chosenName).toBe('Ember');
    });

    it('should return null for non-existent kindle', async () => {
      mockSupabase._setReturnData(null);

      const result = await service.getKindle('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findActiveKindleForUser', () => {
    it('should find a non-complete kindle for a user', async () => {
      mockSupabase._setReturnData({
        id: 'kindle-123',
        parent_agent_id: null,
        parent_user_id: null,
        facilitator_user_id: 'user-123',
        child_agent_id: 'kindle-token-abc',
        child_user_id: 'user-456',
        kindle_method: 'referral',
        value_seed: {},
        onboarding_status: 'values_interview',
        onboarding_session_id: null,
        interview_responses: [],
        chosen_name: null,
        created_at: '2026-02-10T00:00:00Z',
        completed_at: null,
      });

      const result = await service.findActiveKindleForUser('user-456');

      expect(result).not.toBeNull();
      expect(result!.onboardingStatus).toBe('values_interview');
      expect(mockSupabase._queryBuilder.neq).toHaveBeenCalledWith('onboarding_status', 'complete');
      expect(mockSupabase._queryBuilder.neq).toHaveBeenCalledWith('onboarding_status', 'abandoned');
    });

    it('should return null when no active kindle exists', async () => {
      mockSupabase._setReturnData(null);

      const result = await service.findActiveKindleForUser('user-456');

      expect(result).toBeNull();
    });
  });

  describe('workspace-scoped onboarding identity', () => {
    /*
     * The onboarding upsert used to omit workspace_id, landing rows in the
     * (user_id, agent_id) WHERE workspace_id IS NULL unique lane. Those
     * shadow rows made every slug lookup for the agent ambiguous — routing
     * refuses ambiguity, so threaded messages to the REAL agent were held
     * (echo Mar 11, wren Jun 22). These tests pin the fix, and the r1
     * failure-path rulings: refusal happens BEFORE any mutation (the
     * one-time token is never burned), lookups fail closed, archived
     * workspaces are not inherited, and a failed rename fails completion.
     */
    it('scopes the onboarding identity to the workspace where existing identities live', async () => {
      const { client, rpcCalls } = tableAwareSupabase({
        identityWorkspaces: [
          { workspace_id: 'ws-A' },
          { workspace_id: 'ws-B' },
          { workspace_id: 'ws-A' },
        ],
        activeWorkspaceIds: ['ws-A', 'ws-B', 'ws-oldest'],
        oldestWorkspace: { id: 'ws-oldest' },
      });
      const svc = new KindleService(client);

      await svc.redeemKindleToken('abc123hex', 'new-user');

      expect(rpcCalls).toHaveLength(1);
      expect(rpcCalls[0].fn).toBe('redeem_kindle_token');
      expect(rpcCalls[0].args).toMatchObject({
        p_token: 'abc123hex',
        p_new_user_id: 'new-user',
        p_workspace_id: 'ws-A',
      });
      expect((rpcCalls[0].args.p_identity as { soul?: string })?.soul).toContain('Nascent SB');
    });

    it('falls back to the user oldest workspace when no identities exist yet', async () => {
      const { client, rpcCalls } = tableAwareSupabase({
        identityWorkspaces: [],
        oldestWorkspace: { id: 'ws-oldest' },
      });
      const svc = new KindleService(client);

      await svc.redeemKindleToken('abc123hex', 'new-user');

      expect(rpcCalls[0].args).toMatchObject({ p_workspace_id: 'ws-oldest' });
    });

    it('an archived identity workspace is not inherited — falls to the oldest active', async () => {
      // All existing identities point at a workspace that fails verification
      // (archived or foreign). Inheriting it would scope the new SB into a
      // dead workspace; the oldest ACTIVE workspace wins instead (r1 P2).
      const { client, rpcCalls } = tableAwareSupabase({
        identityWorkspaces: [{ workspace_id: 'ws-dead' }, { workspace_id: 'ws-dead' }],
        activeWorkspaceIds: ['ws-oldest'],
        oldestWorkspace: { id: 'ws-oldest' },
      });
      const svc = new KindleService(client);

      await svc.redeemKindleToken('abc123hex', 'new-user');

      expect(rpcCalls[0].args).toMatchObject({ p_workspace_id: 'ws-oldest' });
    });

    it('refuses BEFORE any mutation when the user has no workspace — the token survives', async () => {
      // r1 P1: the refusal must come before the lineage insert and the
      // token-used update. A failed redeem that burns the one-time token
      // strands the invitee permanently.
      const { client, mutations, rpcCalls } = tableAwareSupabase({
        identityWorkspaces: [],
        oldestWorkspace: null,
      });
      const svc = new KindleService(client);

      await expect(svc.redeemKindleToken('abc123hex', 'new-user')).rejects.toThrow(/no workspace/);
      expect(mutations).toEqual([]);
      expect(rpcCalls).toEqual([]);
    });

    it('a workspace lookup error refuses before any mutation — fail closed, token survives', async () => {
      const { client, mutations, rpcCalls } = tableAwareSupabase({
        identityWorkspaces: { error: 'db down' },
        oldestWorkspace: { id: 'ws-oldest' },
      });
      const svc = new KindleService(client);

      await expect(svc.redeemKindleToken('abc123hex', 'new-user')).rejects.toThrow(
        /Cannot resolve workspace/
      );
      expect(mutations).toEqual([]);
      expect(rpcCalls).toEqual([]);
    });

    it('an atomic-redeem failure surfaces — nothing to unwind client-side', async () => {
      // The transaction boundary lives in redeem_kindle_token: an identity
      // collision or FK violation inside it rolls back token consumption and
      // lineage together (proven against the real DB in
      // kindle-redeem.integration.test.ts). The unit claim is propagation:
      // the RPC error becomes a redeem error, and no client-side writes ran.
      const { client, mutations } = tableAwareSupabase({
        identityWorkspaces: [],
        oldestWorkspace: { id: 'ws-oldest' },
        rpcResult: { data: null, error: { message: 'duplicate key value' } },
      });
      const svc = new KindleService(client);

      await expect(svc.redeemKindleToken('abc123hex', 'new-user')).rejects.toThrow(
        /Failed to redeem kindle token: duplicate key/
      );
      expect(mutations).toEqual([]);
    });

    it('completeOnboarding FAILS when the rename lands on nothing — lineage never marked complete', async () => {
      // r1 P3: a collision or missing onboarding row used to be logged and
      // swallowed; the lineage completed and the caller saw success while
      // the identity stayed kindle-*.
      const { client, mutations } = tableAwareSupabase({
        identityUpdateResult: { data: [], error: null },
      });
      const svc = new KindleService(client);

      await expect(svc.completeOnboarding('lineage-1', 'Nova')).rejects.toThrow(
        /Failed to finalize kindled identity/
      );
      expect(
        mutations.find((m) => m.table === 'kindle_lineage' && m.method === 'update')
      ).toBeUndefined();
    });

    it('completeOnboarding surfaces a rename ERROR the same way', async () => {
      const { client, mutations } = tableAwareSupabase({
        identityUpdateResult: {
          data: null,
          error: { message: 'duplicate key value violates unique constraint' },
        },
      });
      const svc = new KindleService(client);

      await expect(svc.completeOnboarding('lineage-1', 'Wren')).rejects.toThrow(/duplicate key/);
      expect(
        mutations.find((m) => m.table === 'kindle_lineage' && m.method === 'update')
      ).toBeUndefined();
    });
  });
});
