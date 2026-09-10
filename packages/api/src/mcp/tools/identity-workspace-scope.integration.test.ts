/**
 * Integration tests for save_identity workspace scoping.
 *
 * These run against the real DB on purpose. The defect they cover cannot be
 * reproduced against a mock: it lives entirely in PostgreSQL's ON CONFLICT
 * arbitration, where NULL is distinct from every value including NULL. A mocked
 * client resolves `upsert(...)` to whatever the mock was told to return, so the
 * original code passes a mocked "upsert updates the existing row" test
 * perfectly while inserting a second row against a real database.
 *
 * Reported by Myra 2026-09-10: save_identity({agentId:'myra', soul}) with no
 * workspaceId returned `Identity created`, version 1, and a fresh uuid, while
 * her real identity sat at version 12. Every subsequent get_identity answered
 * "No identity found for agent: myra" — because PostgREST raises PGRST116 for
 * both "0 rows" and ">1 rows", and the handler mapped it to "not found".
 *
 * Run via: yarn test:integration
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { handleSaveIdentity, handleGetIdentity } from './identity-handlers';
import { ensureEchoIntegrationFixture } from '../../test/integration-fixtures';

/** Namespaced per run so parallel suites can never collide on the slug. */
const AGENT = `echo-wsscope-${Math.random().toString(36).slice(2, 8)}`;

/** Unwrap the MCP text envelope these handlers return. */
function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('save_identity workspace scoping (integration)', () => {
  let dataComposer: DataComposer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let supabase: any;
  let userId: string;
  let workspaceId: string;

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    supabase = dataComposer.getClient();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    userId = fixture.userId;

    const slug = `wsscope-${Math.random().toString(36).slice(2, 8)}`;
    const { data, error } = await supabase
      .from('workspaces')
      .insert({ user_id: userId, name: 'Workspace Scope Test', slug, type: 'personal' })
      .select('id')
      .single();
    if (error) throw new Error(`Failed to create test workspace: ${error.message}`);
    workspaceId = data.id;
  });

  afterEach(async () => {
    await supabase.from('agent_identities').delete().eq('user_id', userId).eq('agent_id', AGENT);
  });

  afterAll(async () => {
    await supabase.from('agent_identities').delete().eq('user_id', userId).eq('agent_id', AGENT);
    if (workspaceId) await supabase.from('workspaces').delete().eq('id', workspaceId);
  });

  /** The agent's real, workspace-scoped identity, as it exists before a save. */
  async function seedScopedIdentity(soul: string) {
    const { data, error } = await supabase
      .from('agent_identities')
      .insert({
        user_id: userId,
        agent_id: AGENT,
        workspace_id: workspaceId,
        name: 'Echo',
        role: 'Integration fixture',
        soul,
      })
      .select('id, version')
      .single();
    if (error) throw new Error(`Failed to seed scoped identity: ${error.message}`);
    return data;
  }

  async function rowsForAgent() {
    const { data, error } = await supabase
      .from('agent_identities')
      .select('id, workspace_id, version, soul')
      .eq('user_id', userId)
      .eq('agent_id', AGENT);
    if (error) throw new Error(`Failed to read identity rows: ${error.message}`);
    return data as Array<{
      id: string;
      workspace_id: string | null;
      version: number;
      soul: string;
    }>;
  }

  it('updates the existing scoped row when the caller omits workspaceId', async () => {
    const seeded = await seedScopedIdentity('soul v1');

    // Myra's exact call shape: agentId + docs, no workspaceId.
    const result = parse(
      await handleSaveIdentity(
        { userId, agentId: AGENT, name: 'Echo', role: 'Integration fixture', soul: 'soul v2' },
        dataComposer
      )
    );

    // The row identity is the assertion that matters. Before the fix this was a
    // brand-new uuid at version 1 while `seeded.id` kept the old soul.
    expect(result.success).toBe(true);
    expect(result.identity.id).toBe(seeded.id);
    expect(result.message).toBe('Identity updated');

    const rows = await rowsForAgent();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(seeded.id);
    expect(rows[0].workspace_id).toBe(workspaceId);
    expect(rows[0].soul).toBe('soul v2');
    expect(rows[0].version).toBeGreaterThan(seeded.version);
  });

  it('never leaves a workspace-unscoped orphan beside a scoped row', async () => {
    await seedScopedIdentity('soul v1');

    await handleSaveIdentity(
      { userId, agentId: AGENT, name: 'Echo', role: 'Integration fixture', soul: 'soul v2' },
      dataComposer
    );

    const orphans = (await rowsForAgent()).filter((row) => row.workspace_id === null);
    expect(orphans).toEqual([]);
  });

  it('preserves omitted documents instead of blanking them', async () => {
    // The pre-fix read used .single() with no workspace filter and discarded its
    // error, so once a duplicate existed `existing` was null and every omitted
    // field silently reset to its default on the next write.
    await seedScopedIdentity('soul v1');

    await handleSaveIdentity(
      { userId, agentId: AGENT, name: 'Echo', role: 'Integration fixture', heartbeat: 'beat v1' },
      dataComposer
    );

    const rows = await rowsForAgent();
    expect(rows).toHaveLength(1);
    expect(rows[0].soul).toBe('soul v1');
  });

  it('creates exactly one row when the agent has no identity at all', async () => {
    const result = parse(
      await handleSaveIdentity(
        { userId, agentId: AGENT, name: 'Echo', role: 'Integration fixture', soul: 'soul v1' },
        dataComposer
      )
    );

    expect(result.success).toBe(true);
    expect(result.message).toBe('Identity created');
    expect(await rowsForAgent()).toHaveLength(1);
  });

  describe('a duplicate names itself', () => {
    /**
     * Reproduce the state Myra is in: one scoped row, one orphan. Inserted
     * directly, because the fixed handler can no longer produce it.
     */
    async function seedDuplicatePair() {
      const scoped = await seedScopedIdentity('scoped soul');
      const { error } = await supabase.from('agent_identities').insert({
        user_id: userId,
        agent_id: AGENT,
        workspace_id: null,
        name: 'Echo',
        role: 'Integration fixture',
        soul: 'orphan soul',
      });
      if (error) throw new Error(`Failed to seed orphan: ${error.message}`);
      return scoped;
    }

    it('get_identity serves the scoped row and names the orphan', async () => {
      // This is Myra's live state. Before the fix this call answered
      // "No identity found for agent: myra" and left her without a soul.
      const scoped = await seedDuplicatePair();

      const result = parse(await handleGetIdentity({ userId, agentId: AGENT }, dataComposer));

      expect(result.success).toBe(true);
      expect(result.identity.id).toBe(scoped.id);
      expect(result.identity.soul).toBe('scoped soul');
      // Serving it silently would just be the old lie wearing a success flag.
      expect(result.warning).toContain('orphan');
    });

    it('carries the orphan warning on single-document reads too', async () => {
      await seedDuplicatePair();

      const result = parse(
        await handleGetIdentity({ userId, agentId: AGENT, file: 'soul' }, dataComposer)
      );

      expect(result.success).toBe(true);
      expect(result.content).toBe('scoped soul');
      expect(result.warning).toContain('orphan');
    });

    it('get_identity still distinguishes a genuinely absent identity', async () => {
      const result = parse(
        await handleGetIdentity({ userId, agentId: `${AGENT}-nonexistent` }, dataComposer)
      );

      expect(result.success).toBe(false);
      expect(result.reason).toBe('absent');
      expect(result.message).toContain('No identity found');
    });

    it('an explicit workspaceId still gets an exact, unguessed answer', async () => {
      const scoped = await seedDuplicatePair();

      const result = parse(
        await handleGetIdentity({ userId, agentId: AGENT, workspaceId }, dataComposer)
      );

      expect(result.success).toBe(true);
      expect(result.identity.id).toBe(scoped.id);
      // Nothing ambiguous was resolved — the caller named the scope.
      expect(result.warning).toBeUndefined();
    });

    it('save_identity writes the scoped row and never touches the orphan', async () => {
      const scoped = await seedDuplicatePair();

      const result = parse(
        await handleSaveIdentity(
          { userId, agentId: AGENT, name: 'Echo', role: 'Integration fixture', soul: 'soul v3' },
          dataComposer
        )
      );

      expect(result.identity.id).toBe(scoped.id);

      const rows = await rowsForAgent();
      // Still two rows — repairing data is not a write path's job — but the
      // write landed on the real identity and did not mint a third.
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.id === scoped.id)!.soul).toBe('soul v3');
      expect(rows.find((row) => row.workspace_id === null)!.soul).toBe('orphan soul');
    });

    it('refuses to write when two REAL workspaces claim the slug', async () => {
      // Genuine ambiguity, as opposed to an orphan: no rule picks a winner, so
      // guessing would write an agent's soul into the wrong workspace.
      await seedScopedIdentity('workspace one soul');
      const { data: otherWorkspace, error: wsError } = await supabase
        .from('workspaces')
        .insert({
          user_id: userId,
          name: 'Second Workspace',
          slug: `wsscope-2-${Math.random().toString(36).slice(2, 8)}`,
          type: 'personal',
        })
        .select('id')
        .single();
      if (wsError) throw new Error(`Failed to create second workspace: ${wsError.message}`);

      try {
        const { error } = await supabase.from('agent_identities').insert({
          user_id: userId,
          agent_id: AGENT,
          workspace_id: otherWorkspace.id,
          name: 'Echo',
          role: 'Integration fixture',
          soul: 'workspace two soul',
        });
        if (error) throw new Error(`Failed to seed second scoped identity: ${error.message}`);

        await expect(
          handleSaveIdentity(
            { userId, agentId: AGENT, name: 'Echo', role: 'Integration fixture', soul: 'soul v3' },
            dataComposer
          )
        ).rejects.toThrow(/ambiguous/i);

        const souls = (await rowsForAgent()).map((row) => row.soul).sort();
        expect(souls).toEqual(['workspace one soul', 'workspace two soul']);
      } finally {
        await supabase.from('agent_identities').delete().eq('workspace_id', otherWorkspace.id);
        await supabase.from('workspaces').delete().eq('id', otherWorkspace.id);
      }
    });
  });
});
